# N2VN 기획서 — BGM 생성 파이프라인 & 배경 이미지 최적화

> **작성 기준:** proposal.md (2026-04-23) 반영  
> **이전 문서:** [.claude/proposal.md](./proposal.md)  
> **후속 문서:** [.claude/development.md](./development.md)

---

## 1. 개선 배경 및 목적

### 1.1 현재 상태 요약

| 영역 | 현재 상태 |
|---|---|
| BGM | 씬 파싱 시 `bgm_prompt`만 생성. 실제 음악 파일 없음 |
| 배경 이미지 | 씬과 무관하게 전체 배경 목록을 일괄 생성 → 사용 안 되는 이미지 발생 |

### 1.2 개선 목표

1. **BGM 파이프라인 완성**: 각 씬의 분위기에 맞는 BGM을 자동 생성하여 비주얼 노벨 재생 시 음악이 흐르도록 한다.
2. **배경 이미지 낭비 제거**: 실제로 씬에 배정된 배경만 이미지를 생성하여 불필요한 API 비용과 생성 시간을 제거한다.
3. **BGM 재사용성 확보**: 유사한 분위기의 씬은 동일한 BGM을 공유하여 감상 몰입도를 높이고 생성 비용을 절감한다.

---

## 2. BGM 생성 파이프라인 기획

### 2.1 핵심 개념: BGM의 역할

비주얼 노벨에서 BGM은 단순한 배경음악이 아니라 **감정 증폭 장치**다. 씬의 분위기가 바뀔 때마다 새 BGM이 재생되면 몰입이 깨지므로, **같은 감정 톤의 씬들은 BGM을 공유**하는 것이 자연스럽다.

### 2.2 BGM 식별 전략

```
씬 파싱 시점에 Gemini가 각 씬의 bgm_prompt를 생성
  ↓
LLM이 기존 BGM 목록(id + 설명)을 참고하여
  ┌── 어울리는 BGM이 있으면 → 기존 BGM ID 반환 (재사용)
  └── 없으면 → new_bgm_{num} 임시 ID 생성
```

**재사용 판단 기준 예시:**
- 동일 소설 내 이미 생성된 BGM과 분위기 키워드 50% 이상 겹침
- 감정 카테고리 동일 (예: 전투, 로맨스, 슬픔, 평온 등)

### 2.3 BGM 데이터 생애주기

```
1단계: 씬 파싱 (LLM)
  └── 씬별 bgm_prompt 생성
  └── 기존 BGM과 매칭 또는 new_bgm_{n} 임시 ID 할당

2단계: DB 적재 + UUID 발급
  └── new_bgm_{n} → DB INSERT → 실제 UUID 발급
  └── scenes.json의 임시 ID를 UUID로 일괄 치환 → S3 재저장

3단계: BGM 음원 생성 (비동기)
  └── BGM AI API 호출 (bgm_prompt 기반)
  └── 생성된 음원 S3 업로드
  └── DB에 파일 경로 업데이트
```

### 2.4 BGM 카테고리 설계

LLM이 bgm_prompt 생성 시 아래 감정 카테고리 중 하나를 명시하도록 지시한다. 같은 카테고리 내에서 재사용 우선 검색을 수행한다.

| 카테고리 | 대표 키워드 | 비주얼 노벨 사용 예시 |
|---|---|---|
| `ACTION` | intense, battle, fast-paced | 전투, 추격 장면 |
| `ROMANCE` | tender, warm, heartfelt | 고백, 설레임 장면 |
| `MYSTERY` | tense, eerie, suspenseful | 사건 발생, 의혹 장면 |
| `PEACEFUL` | calm, gentle, ambient | 일상, 회화 장면 |
| `SAD` | melancholic, somber, lonely | 이별, 상실 장면 |
| `EPIC` | grand, orchestral, heroic | 클라이맥스, 결전 장면 |
| `DARK` | ominous, heavy, oppressive | 악당 등장, 위기 장면 |

### 2.5 BGM AI 서비스 선정 기준

비주얼 노벨 BGM은 다음 조건을 충족해야 한다:
- **무가사 인스트루멘탈**: 대사와 음악이 충돌하지 않도록
- **루프 가능한 구조**: 씬 길이에 상관없이 반복 재생
- **분위기 제어 가능**: 텍스트 프롬프트로 장르·감정 지정
- **REST API 제공**: 기존 아키텍처와 동일한 방식으로 연동

#### 서비스 비교 분석

| 항목 | Mubert API | **Lyria 3 Clip** | Lyria 3 Pro |
|---|---|---|---|
| **가격** | $49/월 구독 (최소) | **$0.04/클립** | $0.08/트랙 |
| **에피소드당 비용** (BGM 7개 기준) | $49 고정 | **$0.28** | $0.56 |
| **생성 길이** | 최대 25분 | **30초** | ~풀 송 길이 |
| **출력 포맷** | MP3 | **MP3 48kHz stereo** | MP3 48kHz stereo |
| **텍스트/이미지 프롬프트** | 텍스트만 | **텍스트·이미지** | 텍스트·이미지 |
| **루프 최적화** | 네이티브 루프 | **명시적 루프 최적화** | ✗ (풀 송 구조) |
| **VN BGM 적합성** | ✓ 게임 특화 | **✓ 루프·클립 특화** | ✗ 벌스/코러스 구조 |
| **기존 API 키 재사용** | ✗ (신규 계정) | **✓ (GEMINI_API_KEY)** | ✓ (GEMINI_API_KEY) |

#### 선정 근거

- **Mubert**: 게임 BGM에 특화되어 있으나, **월 $49 구독료**가 소규모 연구 프로젝트에 비경제적.
- **Lyria 3 Pro**: "여러 벌스·코러스·브리지를 갖춘 전체 길이의 노래"에 최적화된 모델. 반복 재생용 배경음악보다는 노래 제작에 적합하여 VN BGM 용도와 맞지 않음.
- **Lyria 3 Clip**: "짧은 음악 클립, 루프, 미리보기"에 명시적으로 최적화. 30초 클립은 HTML `<audio loop>`로 무한 반복하면 VN BGM으로 충분하며, 루프 구조를 고려한 생성이 보장됨.

**확정 서비스: Google Lyria 3 Clip (Gemini API)**

공식 문서 기준 루프·클립 생성에 특화된 모델. 기존 Gemini 2.5 Flash와 동일한 API 키·빌링으로 운영 가능하며, 30초 클립을 프론트엔드 `<audio loop>`로 반복 재생한다. 에피소드당 비용이 약 $0.28로 Pro 대비 50% 절감.

### 2.6 BGM 파일 규격

| 항목 | 규격 |
|---|---|
| 포맷 | MP3 (48kHz stereo, Lyria 기본 출력) |
| 길이 | 30초 (Lyria 3 Clip 고정 출력) |
| 루프 처리 | 프론트엔드 `<audio loop>` (브라우저 레벨) |
| 저장 경로 | S3: `series/{seriesId}/bgm/{bgmId}.mp3` |

---

## 3. 배경 이미지 최적화 기획

### 3.1 문제 정의

현재 흐름:
```
Step 3: 배경 파싱 → 배경 6개 생성 (DB 저장)
Step 4: 씬 파싱 → 실제로 4개 배경만 씬에 사용
Step 6: 배경 이미지 생성 → 6개 전체 이미지 생성 (2개 낭비)
```

개선 후 흐름 (BGM과 동일한 패턴):
```
Step 3: POST /parsing/backgrounds 제거
Step 4: 씬 파싱 시점에 BGM과 동일하게 배경 매칭/신규 생성 결정
  └── new_bg_{n} 임시 ID → DB INSERT → 실제 ID 발급 → scenes.json 치환
  └── 신규 배경 이미지 생성 트리거 (비동기)
```

### 3.2 BGM과 동일한 배경 식별 전략

```
씬 파싱 시점에 Gemini가 각 씬의 배경을 결정
  ↓
LLM이 기존 background 목록(id + name + description)을 참고하여
  ┌── 어울리는 배경이 있으면 → 기존 background ID 반환 (재사용)
  └── 없으면 → new_bg_{n} 임시 ID + name + description 생성
```

**재사용 판단 기준:**
- 동일 소설 내 이미 생성된 배경과 장소/분위기가 동일
- 시간대(timeOfDay)가 달라도 동일 장소라면 재사용 (시간대는 이미지 프롬프트에 오버레이)

### 3.3 배경 데이터 생애주기

```
1단계: 씬 파싱 (LLM)
  └── 씬별 backgroundId 결정
  └── 기존 background와 매칭 또는 new_bg_{n} 임시 ID 할당
  └── new_bg_{n} 에는 name + description도 함께 생성

2단계: DB 적재 + ID 발급
  └── new_bg_{n} → background 테이블 INSERT → 실제 ID ({novelId}_bg_{idx}) 발급
  └── scenes.json의 임시 ID를 실제 ID로 일괄 치환 → S3 재저장

3단계: 배경 이미지 생성 (비동기)
  └── 신규 background ID만 Leonardo AI 이미지 생성 트리거
  └── 생성된 이미지 S3 업로드 + DB genId 업데이트
```

### 3.4 개선된 파이프라인 전체 흐름

```
[사전] S3에 novel.txt 업로드

Step 1: POST /novels
  └── novel 레코드 생성

Step 2: POST /parsing/characters
  └── Gemini → 캐릭터 파싱 → character 레코드 생성

Step 3: POST /parsing/scenes  ← [핵심 변경 지점] (배경 파싱 Step 흡수)
  └── Gemini → 씬 파싱
        입력: 소설 원문 + 기존 background 목록 (id + name + description)
  └── [배경] 기존 매칭 또는 new_bg_{n} + name + description 생성
        → DB INSERT → 실제 ID 발급 → scenes.json 치환
        → 신규 배경 이미지 생성 트리거 (비동기)
  └── [BGM] 기존 매칭 또는 new_bgm_{n} + prompt 생성
        → DB INSERT → UUID 발급 → scenes.json 치환
        → BGM 음원 생성 트리거 (비동기)
  └── scenes.json S3 저장

Step 4: POST /images/characters
  └── 캐릭터 이미지 생성 (기존과 동일)

Step 5: GET /novels/:id/assets
  └── 캐릭터 이미지 + 배경 이미지 + BGM URL 반환

Step 6: GET /novels/:id/vn-script
  └── scenes.json + DB 조합 → VN 스크립트 반환 (bgmId 포함)
```

> `POST /parsing/backgrounds` 엔드포인트는 **제거**한다. 배경 파싱은 씬 파싱에 완전히 통합된다.

---

## 4. scenes.json 스키마 변경

### 4.1 현재 스키마 (씬 단위)

```json
{
  "backgroundId": "1_bg_1",
  "timeOfDay": "dawn",
  "bgm_prompt": "tense orchestral music with light percussion",
  "dialogues": [...]
}
```

### 4.2 개선 스키마

```json
{
  "backgroundId": "1_bg_1",
  "timeOfDay": "dawn",
  "bgmId": "uuid-xxxx-xxxx",
  "dialogues": [...]
}
```

- `bgm_prompt` 필드는 DB의 `bgm` 테이블에 저장 (런타임 불필요)
- `bgmId`는 DB에서 UUID를 발급받은 후 치환 저장

---

## 5. 비주얼 노벨 플레이어 BGM 재생 기획

### 5.1 재생 규칙

| 상황 | BGM 동작 |
|---|---|
| 씬 전환 시 bgmId 변경 | 현재 BGM 페이드아웃 → 새 BGM 페이드인 |
| 씬 전환 시 bgmId 동일 | BGM 중단 없이 계속 재생 (매끄러운 연속성) |
| 소설 시작 | 첫 씬의 BGM 자동 재생 |
| `end` 명령 | BGM 페이드아웃 |
| 음소거 상태에서 씬 전환 | BGM 교체는 수행하되 소리는 내지 않음 |
| 음소거 해제 | 현재 씬의 BGM 즉시 재생 |

### 5.2 VN 스크립트 명령어 추가

```
# 씬 전환 시 BGM ID가 다를 때만 명령 삽입
play bgm {bgmId}
```

### 5.3 플레이어 에셋 응답 구조 추가

`GET /novels/:id/vn-script` 응답에 BGM URL 맵 추가:

```json
{
  "bgm": {
    "uuid-xxxx": "https://.../{novelId}/bgm/uuid-xxxx.mp3"
  }
}
```

### 5.4 사운드 토글 UI

플레이어 화면 우측 상단에 사운드 토글 버튼을 고정 배치한다.

**UI 사양:**

| 항목 | 내용 |
|---|---|
| 위치 | 플레이어 우측 상단 고정 (position: absolute) |
| 켜짐 상태 | 스피커 아이콘 (🔊) |
| 꺼짐 상태 | 음소거 아이콘 (🔇) |
| 상태 유지 | localStorage에 저장 — 페이지 새로고침 후에도 유지 |
| 초기값 | 켜짐 (소설 시작 시 BGM 자동 재생) |

**동작 정의:**

| 액션 | 결과 |
|---|---|
| 켜짐 → 끔 | 현재 재생 중인 BGM 즉시 음소거 (pause 또는 volume 0) |
| 꺼짐 → 켬 | 현재 씬의 BGM 즉시 재생 |
| 음소거 상태에서 씬 전환 | 내부 bgmId는 갱신하되 소리는 내지 않음 |

---

## 6. 새로운 DB 엔티티: `bgm` 테이블

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | UUID (PK) | 자동 발급 |
| `novelId` | number (FK) | 소속 소설 |
| `category` | enum | ACTION / ROMANCE / MYSTERY 등 |
| `prompt` | TEXT | LLM이 생성한 bgm_prompt |
| `genId` | string (nullable) | BGM AI 생성 작업 ID |
| `filePath` | string (nullable) | S3 저장 경로 |

---

## 7. 사용자 경험 개선 포인트

### 7.1 독자 관점

- 씬 전환마다 분위기에 맞는 음악이 자동 재생됨
- 유사한 분위기가 이어질 때 음악이 끊기지 않아 몰입감 유지
- 소설 장르(무협, 판타지, 로맨스)에 걸맞은 음악 색채

### 7.2 창작자 관점 (추후 기능)

- 씬별 배정된 BGM 카테고리 확인 가능
- 원하는 BGM 카테고리로 재생성 요청 가능

---

## 8. 처리 순서 및 의존 관계 정리

배경과 BGM은 씬 파싱 내에서 완전히 동일한 패턴으로 처리된다.

```
씬 파싱 요청 수신
  │
  ├─[1] LLM 씬 분석
  │       입력: 소설 원문
  │             + 기존 background 목록 (id + name + description)
  │             + 기존 BGM 목록 (id + category + prompt)
  │       출력: 씬별 backgroundId or new_bg_{n} + name + description
  │             씬별 bgmId or new_bgm_{n} + category + prompt
  │             dialogues
  │
  ├─[2] 배경 중복 제거 + ID 할당  ←── BGM과 동일 패턴
  │       ├── 기존 background와 매칭 → 기존 ID 재사용
  │       └── 신규 → new_bg_{n} 임시 할당 (name + description 보유)
  │
  ├─[3] BGM 중복 제거 + ID 할당  ←── 배경과 동일 패턴
  │       ├── 기존 BGM과 매칭 → 기존 ID 재사용
  │       └── 신규 → new_bgm_{n} 임시 할당 (category + prompt 보유)
  │
  ├─[4] DB 적재 + ID 치환
  │       ├── new_bg_{n}  → background INSERT → 실제 ID 발급
  │       ├── new_bgm_{n} → bgm INSERT → UUID 발급
  │       └── scenes.json의 임시 ID 전체 치환 → S3 저장
  │
  └─[5] 비동기 생성 트리거 (Fire-and-Forget)
          ├── 신규 background ID → Leonardo AI 이미지 생성
          └── 신규 bgm UUID → Lyria 3 Clip API 음원 생성
```

---

## 9. 변경에 따른 API 정리

| Method | Path | 변경사항 |
|---|---|---|
| `POST` | `/parsing/backgrounds` | **제거** — 씬 파싱에 통합 |
| `POST` | `/parsing/scenes` | 배경 매칭/신규 생성 + BGM 매칭/신규 생성 통합. DB 적재 + 비동기 트리거 추가 |
| `POST` | `/bgm/generate` | 신규 — BGM 음원 생성 엔드포인트 (비동기, 내부 트리거용) |
| `POST` | `/images/backgrounds` | 씬 파싱에서 자동 트리거로 변경. 수동 호출은 재생성 용도로만 유지 |
| `GET` | `/novels/:id/vn-script` | 응답에 `bgm` URL 맵 추가 |
| `GET` | `/novels/:id/assets` | 응답에 BGM 에셋 목록 추가 |
