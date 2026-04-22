# N2VN Plan — Monogatari 비주얼 노벨 플레이어 통합

> **원본 요구사항**: [proposal.md](proposal.md)  
> **상세 구현**: [development.md](development.md)

---

## 목표

현재 캐릭터·배경 에셋 뷰어에 **Monogatari 기반 비주얼 노벨 플레이어 탭**을 추가한다.  
이를 위해 기존 scenes.json 구조를 Monogatari 스크립트 형식으로 변환하는 백엔드 엔드포인트를 신설하고, 프론트엔드에 플레이어를 임베드한다.

---

## 변경 범위 요약

| 영역 | 변경 내용 |
|---|---|
| Backend | `GET /novels/:id/vn-script` 엔드포인트 신설 |
| Backend | `scene_prompt` 수정 (진입/퇴장 이벤트 추가) |
| Frontend | Monogatari 라이브러리 통합 |
| Frontend | "비주얼 노벨" 탭 추가 |

---

## 1. 현황 분석

### 현재 scenes.json 구조
```json
{
  "scenes": [
    {
      "backgroundId": "1_bg_1",
      "timeOfDay": "Morning",
      "bgm_prompt": "...",
      "dialogues": [
        {
          "characterId": "1_char_1",
          "dialog": "대사 원문",
          "action": "IDLE",
          "emotion": "DEFAULT",
          "look": "calm eyes"
        }
      ]
    }
  ]
}
```

### Monogatari가 필요로 하는 스크립트 형식
```javascript
[
  'show scene 1_bg_1 with fade',          // 배경 전환
  'play music bgm_1',                      // BGM 시작
  'show character 1_char_1 DEFAULT center', // 캐릭터 등장
  { '백무진': '대사 원문' },               // 대사
  'show character 1_char_1 SMILE center',  // 감정 전환
  { '백무진': '다음 대사' },
  'hide character 1_char_1',              // 캐릭터 퇴장
  'end'
]
```

### 현재 scenes.json의 문제점

1. **캐릭터 등장/퇴장 정보 없음**: Monogatari는 `show`/`hide` 명령이 명시적으로 필요하나, 현재 구조에는 씬 내 캐릭터 진입·이탈 시점 정보가 없음
2. **씬 간 연속성 없음**: 한 씬에서 등장한 캐릭터가 다음 씬으로 이어지는지 알 수 없음
3. **BGM이 프롬프트만 존재**: 실제 BGM 파일 ID가 없음 (BGM 생성 파이프라인은 미구현 상태)

---

## 2. 해결 전략

### 2-1. scene_prompt 수정 — 진입/퇴장/위치 이벤트 추가

`dialogues` 배열에 `isEntry` / `isExit` / `position` 필드를 추가하여 LLM이 씬 내 캐릭터 등장·퇴장 시점과 화면 위치를 명시하도록 한다.

**추가할 필드:**
```typescript
isEntry:  z.boolean().describe("이 대사가 해당 캐릭터의 씬 첫 등장인 경우 true"),
isExit:   z.boolean().describe("이 대사가 해당 캐릭터의 씬 마지막 등장인 경우 true"),
position: z.enum(['left', 'center', 'right']).describe("캐릭터의 화면 위치. 1인 등장 시 center, 2인 이상 시 대화 맥락상 자연스러운 위치 지정"),
```

**프롬프트 지시사항 추가:**
- 씬에 처음 등장하는 캐릭터의 첫 번째 대사에는 `isEntry: true`
- 씬에서 더 이상 등장하지 않는 마지막 대사에는 `isExit: true`
- `position`: 캐릭터 혼자라면 `center`, 두 명 이상이 동시에 화면에 있을 때는 `left` / `right`로 자연스럽게 배치
- narrator에는 `isEntry: false`, `isExit: false`, `position: center`

### 2-2. 백엔드 변환 엔드포인트 신설

`GET /novels/:id/vn-script`가 다음을 수행한다:

1. S3에서 `{novelId}/scenes.json` 읽기
2. DB에서 characters, backgrounds, character_img(NOBG URL 포함) 조회
3. scenes.json + 에셋 URL을 **Monogatari 설정 객체**로 변환 후 반환

반환 형식:
```json
{
  "characters": {
    "1_char_1": {
      "name": "백무진",
      "sprites": {
        "DEFAULT": "https://.../_DEFAULT_NOBG.png",
        "SMILE":   "https://.../_SMILE_NOBG.png"
      }
    }
  },
  "scenes": {
    "1_bg_1": "https://.../backgrounds/1_bg_1.png"
  },
  "script": [
    "show scene 1_bg_1 with fade",
    "show character 1_char_1 DEFAULT center",
    { "백무진": "대사 원문" },
    "..."
  ]
}
```

### 2-3. scenes.json → Monogatari script 변환 로직

변환 규칙 (백엔드에서 처리):

| 조건 | 생성되는 Monogatari 명령 |
|---|---|
| 씬 시작 | `show scene {backgroundId} with fade` |
| BGM | ~~`play music {bgmId}`~~ — **미구현** (BGM 파이프라인 이번 버전 제외) |
| `isEntry: true` | `show character {id} {emotion} {position}` 삽입 후 대사 |
| 감정 또는 위치 변경 (동일 씬 내, 실제 변화 시에만) | `show character {id} {emotion} {position}` 삽입 후 대사 |
| `isExit: true` | 대사 후 `hide character {id}` 삽입 |
| narrator 대사 | `'{dialog}'` (문자열 형태) |
| 캐릭터 대사 | `{ '{name}': '{dialog}' }` |
| 씬 종료 후 화면 잔류 캐릭터 | `hide character {id}` |
| 전체 마지막 | `'end'` |

### 2-4. 프론트엔드 — Monogatari 탭 추가

- 기존 Characters / Backgrounds 탭에 **Visual Novel** 탭 추가
- 탭 전환 시 Monogatari 엔진 초기화 및 스크립트 로드
- 소설 선택 시 `GET /novels/:id/vn-script` 호출 → Monogatari에 동적 주입
- Monogatari는 iframe 또는 div 내에 임베드

---

## 3. 작업 항목

### Backend

- [ ] `novel-parsing.service.ts`: `sceneSchema`에 `isEntry`, `isExit` 필드 추가
- [ ] `prompt/prompt.ts`: `scene_prompt`에 `isEntry`/`isExit` 지시사항 추가
- [ ] `novel/` 모듈에 `GET /novels/:id/vn-script` 엔드포인트 추가
- [ ] scenes.json → Monogatari script 변환 함수 구현

### Frontend

- [ ] `vn.html` 신규 파일 생성 — Monogatari 라이브러리 로드 및 플레이어 단독 페이지
- [ ] `vn.js` 신규 파일 생성 — `postMessage`로 novelId 수신 후 `GET /novels/:id/vn-script` 호출 및 Monogatari 초기화
- [ ] `index.html`: "Visual Novel" 탭 추가 + `<iframe src="vn.html">` 컨테이너 추가
- [ ] `app.js`: 탭 전환 시 iframe에 `postMessage({ novelId })` 전송
- [ ] 기존 Characters/Backgrounds 탭 기능 유지 확인

---

## 4. 미결 사항 (개발 전 확인 필요)

1. **Monogatari 임베드 방식**: **iframe 방식으로 결정** — `vn.html` 별도 파일로 분리, 메인 페이지와 `postMessage`로 novelId 전달
2. ~~**기존 scenes.json 재생성 필요**: `isEntry`/`isExit`/`position` 추가 후 기존 데이터는 `POST /parsing/scenes` 재호출 필요~~ → 사용자가 직접 처리
