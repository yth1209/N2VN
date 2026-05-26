# Development Plan: Gemini NOBG 실제 투명화 적용

## 배경 및 목적

Gemini 이미지 생성 모드(`IMAGE_PROVIDER=gemini`)에서 `_NOBG.png` 저장 시,
Gemini에 배경 제거를 직접 요청하면 진짜 알파 채널이 아닌 체커 무늬 색상 이미지를 반환한다.
`@imgly/background-removal-node`를 사용해 서버 측에서 실제 배경 제거(알파 채널 적용)를 수행한 뒤 저장하도록 수정한다.

---

## 변경 범위

| 파일 | 변경 유형 | 내용 |
|---|---|---|
| `backend/package.json` | 의존성 추가 | `@imgly/background-removal-node` 설치 |
| `backend/src/common/gen-ai-helper.service.ts` | 메서드 추가 | `removeImageBackground(buffer)` |
| `backend/src/image/image.service.ts` | 로직 수정 | Gemini 경로에서 NOBG 저장 전 배경 제거 호출 |

---

## 1. 패키지 설치

```bash
cd backend
npm install @imgly/background-removal-node
```

- 최초 실행 시 로컬 AI 모델을 다운로드하여 캐싱; 이후 빠르게 동작함.
- Node.js 서버 환경 전용 패키지 (`@imgly/background-removal-node`).
  브라우저용(`@imgly/background-removal`)과 구분할 것.

---

## 2. `GenAIHelperService` — `removeImageBackground` 메서드 추가

**파일**: `backend/src/common/gen-ai-helper.service.ts`

기존 서비스 하단(공통 유틸 섹션)에 아래 메서드를 추가한다.

```typescript
// ── Background Removal ───────────────────────────────────────────────────────

/**
 * @imgly/background-removal-node로 이미지 배경 제거.
 * Gemini 이미지 생성 후 _NOBG.png 저장 전 단계에 호출.
 * 모델은 최초 1회만 다운로드되고 이후 캐시에서 로드됨.
 */
async removeImageBackground(inputBuffer: Buffer): Promise<Buffer> {
  const { removeBackground } = await import('@imgly/background-removal-node');
  const resultBlob = await removeBackground(inputBuffer);
  const arrayBuffer = await resultBlob.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
```

- dynamic import를 사용해 모듈 로드 시점을 지연시켜 서버 시작 속도에 영향 없음.
- 반환값은 `Buffer` (PNG with alpha channel).

---

## 3. `ImageService` — Gemini NOBG 저장 로직 수정

**파일**: `backend/src/image/image.service.ts`

### 3-1. `processCharacter` — DEFAULT 이미지

**AS-IS** (line 158–162):
```typescript
if (this.imageProvider === 'gemini') {
  ({ buffer: defaultBuffer } = await this.genAI.geminiGenerateImage(defaultPrompt, undefined, '9:16', '1K'));
  await this.s3HelperService.uploadImage(
    `series/${seriesId}/characters/${charId}/DEFAULT_NOBG.png`, defaultBuffer, 'image/png',
  );
}
```

**TO-BE**:
```typescript
if (this.imageProvider === 'gemini') {
  ({ buffer: defaultBuffer } = await this.genAI.geminiGenerateImage(defaultPrompt, undefined, '9:16', '1K'));
  const defaultNobgBuffer = await this.genAI.removeImageBackground(defaultBuffer);
  await this.s3HelperService.uploadImage(
    `series/${seriesId}/characters/${charId}/DEFAULT_NOBG.png`, defaultNobgBuffer, 'image/png',
  );
}
```

### 3-2. `generateEmotion` — 감정 이미지

**AS-IS** (line 220–224):
```typescript
if (this.imageProvider === 'gemini') {
  ({ buffer } = await this.genAI.geminiGenerateImage(prompt, defaultBuffer, '9:16', '1K'));
  await this.s3HelperService.uploadImage(
    `series/${seriesId}/characters/${charId}/${cimg.emotion}_NOBG.png`, buffer, 'image/png',
  );
}
```

**TO-BE**:
```typescript
if (this.imageProvider === 'gemini') {
  ({ buffer } = await this.genAI.geminiGenerateImage(prompt, defaultBuffer, '9:16', '1K'));
  const nobgBuffer = await this.genAI.removeImageBackground(buffer);
  await this.s3HelperService.uploadImage(
    `series/${seriesId}/characters/${charId}/${cimg.emotion}_NOBG.png`, nobgBuffer, 'image/png',
  );
}
```

---

## 4. 영향 범위

- Leonardo 경로(`this.imageProvider === 'leonardo'`)는 변경 없음. Leonardo는 자체 NOBG API를 통해 처리.
- 배경 이미지(`generateBackgroundImages`)는 NOBG 저장 자체가 없으므로 영향 없음.
- Gemini 경로에서 `DEFAULT.png`와 감정 `.png` 저장은 원본 `buffer`를 그대로 사용하므로 변경 없음.

---

## 5. 예외 처리

- `removeImageBackground` 실패 시 예외를 throw → 상위 `processCharacter` / `generateEmotion`의 기존 catch 블록이 `GenStatus.FAILED`로 처리하므로 별도 추가 핸들링 불필요.

---

---

## 7. 기존 이미지 NOBG 재처리 API (추가 기능)

### 목적

이미 생성 완료된 캐릭터 이미지들(`status = DONE`)에 대해 `_NOBG.png`를 일괄 재생성.
Gemini가 체커 무늬로 저장해둔 기존 이미지들을 소급 처리하는 용도.

### 신규 엔드포인트

| Method | Path | Body | 설명 |
|---|---|---|---|
| `POST` | `/images/characters/nobg-reprocess` | `{ seriesId }` | 해당 시리즈 전체 캐릭터 이미지 NOBG 재생성 (백그라운드) |

### 처리 흐름

```
1. CharacterImg JOIN Character WHERE seriesId = ? AND status = DONE 조회
2. 각 row에 대해 (병렬, Promise.allSettled):
   a. S3 다운로드: series/{seriesId}/characters/{characterId}/{emotion}.png
   b. removeImageBackground(buffer) → nobgBuffer
   c. S3 업로드:  series/{seriesId}/characters/{characterId}/{emotion}_NOBG.png
3. 성공/실패 수 로깅 후 종료 (부분 실패 허용)
```

### 변경 파일

| 파일 | 변경 내용 |
|---|---|
| `backend/src/image/image.service.ts` | `reprocessNobgForSeries(seriesId)` 메서드 추가 |
| `backend/src/image/image.controller.ts` | `POST /images/characters/nobg-reprocess` 엔드포인트 추가 |

---

## 6. 구현 체크리스트

- [x] `@imgly/background-removal-node` 패키지 설치
- [x] `GenAIHelperService.removeImageBackground` 메서드 추가
- [x] `processCharacter` DEFAULT NOBG 저장 로직 수정
- [x] `generateEmotion` NOBG 저장 로직 수정
- [x] `ImageService.reprocessNobgForSeries` 메서드 추가
- [x] `POST /images/characters/nobg-reprocess` 엔드포인트 추가
- [ ] 로컬 테스트: Gemini 모드로 캐릭터 이미지 생성 후 S3 `_NOBG.png` 알파 채널 확인
- [ ] 로컬 테스트: 기존 시리즈에 `nobg-reprocess` 호출 후 S3 확인
