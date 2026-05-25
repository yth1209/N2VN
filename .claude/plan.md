# Plan: 이미지 생성 엔진 전환 및 상태 관리 고도화

> proposal.md 기반 작성 | 2026-05-25

---

## 배경 및 목적

현재 N2VN 시스템은 캐릭터·배경 이미지를 Leonardo AI API 하나에만 의존하고 있다. 이번 변경의 목적은 두 가지다.

1. **이미지 생성 엔진 선택권 확보**: 비용·품질·응답 속도에 따라 Leonardo AI와 Google Gemini 중 하나를 골라 쓸 수 있게 한다. 전환은 코드 수정 없이 환경 변수(.env) 하나로 가능해야 한다.
2. **생성 상태 관리 일관성 확보**: 기존에는 `genId` 필드가 비어 있으면 "미생성"으로 판단했다. 그러나 Gemini는 생성 ID 개념 자체가 없어 이 방식이 통하지 않는다. 모든 이미지 엔티티가 공통 `status` 필드(PENDING / PROCESSING / DONE / FAILED)로 생성 완료 여부를 판단하도록 통일한다.

---

## 사용자 관점에서 달라지는 점

### As-Is
- Leonardo AI만 사용 가능. 다른 엔진으로 바꾸려면 코드를 직접 수정해야 한다.
- 이미지 생성 완료 여부를 `genId` 값으로 판단한다. Gemini를 쓰면 완료 판단 자체가 불가능하다.

### To-Be
- `.env`의 `IMAGE_PROVIDER` 값만 `leonardo` ↔ `gemini`로 바꾸면 전체 파이프라인이 해당 엔진으로 동작한다.
- 이미지 생성 상태는 `status` 필드(PENDING → PROCESSING → DONE / FAILED)로 일관되게 관리된다. 엔진에 상관없이 동일한 방식으로 재시도·완료 확인이 가능하다.

---

## 기능 범위

### 1. 이미지 엔진 선택 기능

| 항목 | 내용 |
|---|---|
| 설정 방법 | `.env`의 `IMAGE_PROVIDER` 값 (`leonardo` 또는 `gemini`) |
| 적용 대상 | 캐릭터 이미지 생성 + 배경 이미지 생성 파이프라인 |
| Leonardo 유지 여부 | 기존 Leonardo 로직 완전 보존. `IMAGE_PROVIDER=leonardo`면 현재와 동일하게 동작 |
| Gemini 이미지 모델 | `gemini-2.0-flash-preview-image-generation` (제안서의 "nano banana pro") |
| Gemini NOBG | 별도 NOBG API 없음 → 이미지 생성 프롬프트에 투명 배경 지시어를 포함시켜 처음부터 투명 배경으로 생성 |
| Gemini 감정 이미지 | DEFAULT 이미지를 입력으로 넣어 표정만 변경하는 image-to-image 방식으로 생성 (캐릭터 일관성 유지) |

### 2. 생성 상태 관리 통일

| 항목 | 내용 |
|---|---|
| 적용 엔티티 | `character_img`, `background`, `bgm` |
| 상태 흐름 | PENDING → PROCESSING → DONE (또는 FAILED) |
| 완료 판단 기준 | `status = DONE` (기존 `genId is not null` 방식 완전 대체) |
| 재시도 기준 | `status = PENDING` 또는 `status = FAILED`인 레코드 대상 |
| genId 필드 | Leonardo 사용 시 계속 저장됨. Gemini 사용 시 null 유지 (정상 상태) |

---

## 주요 흐름

### Gemini 선택 시 이미지 생성 흐름

```
[캐릭터 DEFAULT]
status = PENDING 레코드 조회
  └─ status → PROCESSING 으로 갱신 (재진입 방지)
      └─ Gemini API 호출 (프롬프트에 투명 배경 지시어 포함, base64 응답)
          └─ base64 → Buffer 변환 → S3 업로드 (DEFAULT.png)
              └─ status → DONE (성공) 또는 FAILED (오류)

[캐릭터 감정별 이미지]
DEFAULT 이미지를 입력으로 제공 (image-to-image)
  └─ Gemini API 호출 (표정 변경 프롬프트 + DEFAULT 이미지 첨부)
      └─ base64 → Buffer 변환 → S3 업로드 ({EMOTION}.png)
          └─ status → DONE (성공) 또는 FAILED (오류)

[배경 이미지]
status = PENDING 레코드 조회
  └─ Gemini API 호출 (배경 전용 프롬프트)
      └─ base64 → Buffer 변환 → S3 업로드
          └─ status → DONE (성공) 또는 FAILED (오류)
```

### Leonardo 선택 시 이미지 생성 흐름 (기존과 동일, status만 추가)

```
status = PENDING 레코드 조회
  └─ status → PROCESSING 으로 갱신
      └─ Leonardo API 호출 → 폴링 완료 → genId 저장 → S3 업로드
          └─ NOBG 생성 → nobgGenId 저장
              └─ status → DONE (성공) 또는 FAILED (오류)
```

---

## 범위 밖 (이번 변경에 포함하지 않음)

- BGM 생성 엔진 전환 (현재 Lyria 사용, 변경 없음)
- 씬 파싱(LLM) 로직 변경
- BGM 생성 방식 변경 (Lyria 유지)
- 프론트엔드 변경 사항

---

## 기대 효과

- 이미지 생성 비용 유연성 확보: Gemini가 Leonardo 대비 저렴하거나 빠를 때 즉시 전환 가능
- 상태 관리 일관화로 파이프라인 재시도 로직의 신뢰성 향상
- 향후 새로운 이미지 엔진 추가 시 확장 용이
