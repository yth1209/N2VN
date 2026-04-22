# N2VN 상세 구조 문서

> 코드 아키텍처, DB 스키마, 파이프라인 상세 설명을 담은 참고 문서.
> 개요는 [CLAUDE.md](../CLAUDE.md) 참조.

---

## 1. 데이터베이스 스키마 (TypeORM Entities)

### 1.1 `novel` 테이블

```typescript
@Entity('novel')
class Novel {
  id: number;                  // Auto-increment PK
  novelTitle: string;          // 소설 제목 (VARCHAR 255)
  characterStyleKey: string;   // 캐릭터 이미지 스타일 키 (enum StyleKey)
  characterArtStyle: string;   // 캐릭터 아트 스타일 텍스트 (TEXT)
  backgroundStyleKey: string;  // 배경 스타일 키
  backgroundArtStyle: string;  // 배경 아트 스타일 텍스트
}
```

### 1.2 `character` 테이블

```typescript
@Entity('character')
class Character {
  id: string;      // PK: {novelId}_char_{idx} (예: "1_char_1")
  novelId: number; // FK -> novel.id (CASCADE DELETE)
  name: string;    // 캐릭터 이름 (원문 그대로)
  sex: string;     // 성별 (male/female/unknown)
  look: string;    // SD 프롬프트용 외모 묘사 영문 키워드 (TEXT)
}
```

> **설계 특이점:** `id`가 Auto-increment가 아닌 `@PrimaryColumn`으로 수동 지정됨.
> `_novelFk`는 FK 제약조건만을 위한 가상 관계 매핑이며, 비즈니스 로직에서는 사용되지 않음.

### 1.3 `character_img` 테이블

```typescript
@Entity('character_img')
class CharacterImg {
  characterId: string;  // Composite PK #1 (FK -> character.id, CASCADE DELETE)
  emotion: Emotion;     // Composite PK #2 (enum: DEFAULT|SERIOUS|SMILE|...)
  genId: string;        // Leonardo AI 생성 이미지 ID (null이면 미생성)
  nobgGenId: string;    // 배경 제거(NOBG) 이미지 ID
}
```

> **복합 Primary Key**: `(characterId, emotion)` 쌍이 PK. 하나의 캐릭터가 감정별로 별도 이미지를 가짐.

### 1.4 `background` 테이블

```typescript
@Entity('background')
class Background {
  id: string;          // PK: {novelId}_bg_{idx} (예: "1_bg_2")
  novelId: number;     // FK -> novel.id (CASCADE DELETE)
  name: string;        // 배경 이름 (예: 화산파 연무장)
  description: string; // 영문 시각 묘사 (Leonardo AI 프롬프트용)
  genId: string;       // 생성 이미지 ID (null이면 미생성)
}
```

### 1.5 Entity Relationship Diagram

```
novel (1) ──────< character (N)
                      │
                      └──────< character_img (N)  [PK: characterId + emotion]

novel (1) ──────< background (N)
```

---

## 2. 공통 인프라 (Common Layer)

### 2.1 `RepositoryProvider`

```typescript
@Injectable()
class RepositoryProvider {
  constructor(
    @InjectRepository(Novel)         public readonly novel:        Repository<Novel>,
    @InjectRepository(Character)     public readonly character:    Repository<Character>,
    @InjectRepository(CharacterImg)  public readonly characterImg: Repository<CharacterImg>,
    @InjectRepository(Background)    public readonly background:   Repository<Background>,
  ) {}
}
```

4개의 TypeORM Repository를 하나의 Provider로 묶어 중앙 집중식 의존성 주입 구조를 실현. 각 서비스는 `RepositoryProvider` 하나만 주입받으면 모든 테이블에 접근 가능.

### 2.2 `S3HelperService`

| 메서드 | 설명 |
|---|---|
| `uploadJson(key, data)` | JSON 객체를 S3에 직렬화 저장 (SSE-S3 암호화) |
| `readText(key)` | S3의 텍스트 파일을 string으로 읽기 |
| `readJson(key)` | S3의 JSON 파일을 읽어 파싱 후 반환 |
| `uploadImage(key, buffer, mime)` | Buffer를 이미지로 S3 업로드 (SSE-S3 암호화) |

**S3 버킷 구조:**
```
n2vn-bucket/
└── {novelId}/
    ├── novel.txt                       # 원본 소설 텍스트 (사전 업로드 필요)
    ├── scenes.json                     # 씬 파싱 결과 (게임 런타임용)
    ├── characters/
    │   ├── {charId}_DEFAULT.png
    │   ├── {charId}_SMILE.png
    │   ├── {charId}_DEFAULT_NOBG.png
    │   └── ...
    └── backgrounds/
        └── {bgId}.png
```

### 2.3 `constants.ts`

**`Emotion` enum (10가지):** `DEFAULT, SERIOUS, SMILE, SMIRK, ANGRY, RAGE, SAD, PAIN, SURPRISED, FEAR`

**`StyleKey` enum (21가지):** Leonardo AI의 Pre-defined 렌더링 필터 스타일. BOKEH, CINEMATIC, DYNAMIC, VIBRANT 등.

**`STYLE_UUIDS`:** StyleKey → Leonardo AI UUID 매핑 테이블.

---

## 3. 소설 관리 모듈 (`novel/`)

### 3.1 API 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/novels` | 소설 목록 조회 |
| `POST` | `/novels` | 소설 생성 (body: `novelTitle`) — 이미 있으면 기존 반환 (idempotent) |
| `GET` | `/novels/:id/assets` | 소설 에셋 조회 (S3 URL 포함) |
| `GET` | `/novels/:id/vn-script` | Monogatari 비주얼 노벨 스크립트 반환 |

### 3.2 `createNovel` 흐름

```
POST /novels { novelTitle }
  -> novelTitle 존재 확인
  -> 이미 있으면 기존 Novel 반환 (idempotent)
  -> 없으면 새로 INSERT 후 반환
```

### 3.3 `getNovelAssets` 흐름

```
GET /novels/:id/assets
  -> novel 조회
  -> characters 조회 -> 각 캐릭터의 character_img 목록 조회 (N+1 문제 있음)
  -> backgrounds 조회
  -> S3 URL 조합: https://{bucket}.s3.{region}.amazonaws.com/{novelId}/...
  -> 감정별 이미지 URL(url) + 배경 제거 URL(nobgUrl) 포함하여 반환
```

### 3.4 `getVnScript` 흐름

```
GET /novels/:id/vn-script
  -> novel 존재 확인
  -> S3에서 scenes.json 읽기
  -> characters, backgrounds 조회
  -> In(charIds) 단일 쿼리로 모든 character_img 조회 (N+1 방지)
  -> characterMap 구성: emotion -> NOBG URL (없으면 원본, 둘 다 없으면 DEFAULT 폴백)
  -> sceneMap 구성: bgId -> URL
  -> buildMonogatariScript(scenes, characterMap) 호출
  -> { characters, scenes, script } 반환
```

**반환 JSON 구조:**
```json
{
  "success": true,
  "data": {
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
      { "백무진": "어디 한 번 덤벼보거라." },
      "hide character 1_char_1",
      "end"
    ]
  }
}
```

### 3.5 `buildMonogatariScript` (private 메서드)

`NovelService` 클래스 내 private 메서드로 구현됨.

**변환 규칙:**

| 조건 | 생성되는 명령 |
|---|---|
| 씬 시작 | `show scene {bgId} with fade` |
| `isEntry: true` (첫 등장) | `show character {id} {emotion} {pos}` |
| 동일 씬 내 감정/위치 실제 변화 | `show character {id} {emotion} {pos}` |
| 캐릭터 대사 | `{ '{name}': '{dialog}' }` |
| `isExit: true` (마지막) | `hide character {id}` |
| narrator / unknown | `'{dialog}'` 문자열 |
| 씬 종료 후 화면 잔류 캐릭터 | `hide character {id}` (isExit 누락 방어) |
| 전체 마지막 | `'end'` |

**구버전 방어 처리:** `isEntry`/`isExit`/`position` 필드가 없는 구버전 `scenes.json`에 대해 `??` 연산자로 기본값 적용 (`false`, `false`, `'center'`).

---

## 4. LLM 파싱 파이프라인 (`parsing/`)

### 4.1 전체 흐름

```
S3에서 novel.txt 읽기
  -> LangChain PromptTemplate + Zod Schema 정의
  -> Gemini 2.5 Flash 호출 (temperature=0.1)
  -> StructuredOutputParser로 JSON 파싱
  -> MariaDB에 저장
  -> (씬의 경우) scenes.json을 S3에도 저장
```

파싱 서비스는 LangChain LCEL 체인 방식 사용:
```typescript
const chain = promptTemplate.pipe(this.model).pipe(parser);
const result = await chain.invoke({ novel_text: novelText });
```

### 4.2 `POST /parsing/characters`

**Zod 스키마:**
```typescript
{
  globalArtStyle: string,   // 공통 화풍 키워드 (SD 프롬프트용)
  styleKey: StyleKey,       // Leonardo AI 렌더링 필터
  characters: Record<string, { sex: string, look: string }>
}
```

- `look` 필드 5가지 요소: 나이/성별 + 상세 헤어 + 얼굴/신체 + 상세 의상 + 소품/무기
- **창작 추론(CREATIVE INFERENCE)**: 소설 원문에 묘사가 부족한 경우 장르/직업에 맞게 디테일을 창작. 외모가 평범하면 고유 식별자(점, 흉터, 특이한 귀걸이 등) 최소 1개 이상 창작.
- DB 저장: 기존 캐릭터 전체 삭제 후 재생성 (CASCADE DELETE로 character_img도 삭제됨)

### 4.3 `POST /parsing/backgrounds`

**Zod 스키마:**
```typescript
{
  globalBackgroundArtStyle: string,
  styleKey: StyleKey,
  backgrounds: Record<string, { name: string, description: string }>
}
```

- `description`은 시간대 묘사 제외한 시각적 특징 + 분위기 영문 줄글

### 4.4 `POST /parsing/scenes`

**LLM 입력:**
```
novel_text:        S3에서 읽은 원본 소설
characters_info:   "- ID: 1_char_1, Name: 백무진, Sex: male, Description: ..."
backgrounds_info:  "- ID: 1_bg_1, Name: 화산파 연무장, Description: ..."
```

**Zod 스키마 (현재 버전 — isEntry/isExit/position 포함):**
```typescript
{
  scenes: Array<{
    backgroundId: string,
    timeOfDay: string,
    bgm_prompt: string,
    dialogues: Array<{
      characterId: string,          // "narrator" | "unknown" | "{novelId}_char_{n}"
      dialog: string,               // 원문 그대로 (번역 금지)
      action: "IDLE" | "ATTACK" | "SHAKE",
      emotion: Emotion,
      look: string,
      isEntry: boolean,             // 씬 내 캐릭터 첫 등장 여부
      isExit: boolean,              // 씬 내 캐릭터 마지막 대사 여부
      position: "left" | "center" | "right"  // 화면 위치
    }>
  }>
}
```

**씬 후처리:**
1. 대화에서 캐릭터별 사용된 감정 수집 (DEFAULT는 항상 포함)
2. `character_img`에 findOne + save로 없는 경우에만 플레이스홀더 생성 (`genId=null`)
3. `scenes.json`을 S3에 저장

**scene_prompt 핵심 지시사항:**
- narrator/unknown 대사: 순수 시각 묘사, 감정 설명, 이전 대사의 중복 설명은 제외. 필수 플롯 전개만 포함하고 압축.
- 연속된 narrator 블록 금지.
- `isEntry`/`isExit` 규칙: 씬 내 첫 등장 = true, 마지막 대사 = true. 단독 등장 시 둘 다 true. narrator는 항상 false.
- `position` 규칙: 혼자면 center, 2인 이상 동시 화면 시 left/right 자연스럽게 배치.

---

## 5. 이미지 생성 파이프라인 (`image/`)

### 5.1 비동기 Fire-and-Forget 구조

```typescript
this.imageGenerationService.generateCharacterImages(novelId).catch(err => { });
return { success: true, message: 'Image generation started in background.' };
```

### 5.2 `POST /images/characters` 흐름

```
1. genId가 NULL인 character_img 조회 (JOIN으로 novelId 필터링)
2. 캐릭터별 그룹화 (Map.groupBy)
3. 캐릭터 단위 병렬 처리 (Promise.all)
   └── DEFAULT 이미지 먼저 생성 (Flux 모델, 레퍼런스 확보)
       -> S3 업로드 + NOBG 추출 + DB 업데이트
   └── 나머지 감정 병렬 생성 (Lucid 모델 + initImageId로 일관성 확보)
       -> S3 업로드 + NOBG 추출 + DB 업데이트
```

### 5.3 `POST /images/backgrounds` 흐름

```
1. novelId의 모든 background 조회
2. 병렬 처리 (Promise.all)
   - 프롬프트: (globalArtStyle:1.2), {styleKey}, {description}, empty scenery, no characters
   - Flux 모델, 1280x720
   - S3 업로드 + DB 업데이트
```

### 5.4 Leonardo AI 생성 핵심 함수 (`generateImageToBuffer`)

```
POST /v2/generations -> generationId 획득
     |
폴링 (최대 60회 x 3초 = 최대 180초)
  GET /v1/generations/{generationId}
  -> status == 'COMPLETE' 일 때 이미지 URL 획득
     |
이미지 URL로 binary 다운로드 -> Buffer 반환
```

### 5.5 NOBG (배경 제거) 파이프라인

```
POST /v1/variations/nobg { id: genId }
     |
폴링: GET /v1/variations/{sdNobgJobId}
  -> transformType === 'NOBG' 찾을 때까지 대기
     |
S3 업로드: characters/{charId}_{emotion}_NOBG.png + nobgGenId DB 업데이트
```

### 5.6 캐릭터 이미지 프롬프트 구조 (`image/prompt/prompt.ts`)

```
getCharacterPrompt(style, look, emotion)
  = {style}, {look}, {emotionBlock}, {FRAMING_BLOCK}, {BACKGROUND_BLOCK}
```

- `FRAMING_BLOCK`: `"full body shot, full length portrait, front view, facing forward, looking at viewer"`
- `BACKGROUND_BLOCK`: `"isolated on a simple solid white background, no background"`

감정별 블록 예시:
```
DEFAULT  -> "calm and composed expression, stoic, confident eyes"
RAGE     -> "(intense piercing glare:1.05), (gritted teeth:1.05), fierce expression"
FEAR     -> "stiff expression, wide eyes, cold sweat, shrinking pupils, anxious"
SAD      -> "somber expression, looking down slightly, melancholic, shadow over eyes"
```

---

## 6. 프론트엔드 (`frontend/`)

### 6.1 파일 구조

```
frontend/
├── index.html          # 메인 대시보드 (소설 목록 + 탭 뷰)
├── app.js              # 메인 애플리케이션 로직
├── style.css           # 메인 스타일시트
├── vn.html             # Monogatari 비주얼 노벨 플레이어 (iframe 단독 페이지)
├── vn.js               # VN 플레이어 초기화 로직
├── monogatari.css      # Monogatari npm 패키지에서 복사한 로컬 CSS
├── monogatari.js       # Monogatari npm 패키지에서 복사한 로컬 JS
└── package.json        # @monogatari/core ^2.6.0 의존성
```

> **Monogatari 로컬 배포:** CDN 대신 npm(`@monogatari/core@^2.6.0`)으로 설치 후 `monogatari.css`, `monogatari.js`를 `frontend/` 루트에 직접 복사하여 사용.

### 6.2 `index.html` 구조

3개 탭 구성:
- **Characters** — 캐릭터별 감정 이미지 갤러리 + NOBG 토글
- **Backgrounds** — 배경 이미지 카드 갤러리
- **Visual Novel** — `vn.html`을 임베드하는 `<iframe>` (높이 600px)

```html
<div id="vn-view" style="display: none; width: 100%; height: 600px;">
  <iframe id="vn-iframe" src="vn.html" style="width: 100%; height: 100%; border: none;" allow="autoplay"></iframe>
</div>
```

### 6.3 `app.js` 주요 로직

**탭 전환 (`setupEventListeners`):**
```javascript
if (activeTab === 'characters')   { /* characters-view: grid, 나머지 none */ }
else if (activeTab === 'backgrounds') { /* backgrounds-view: grid, 나머지 none */ }
else if (activeTab === 'vn') {
  vnViewEl.style.display = 'block';
  if (currentNovelId) sendNovelIdToVnPlayer(currentNovelId);
}
```

**`sendNovelIdToVnPlayer(novelId)`:**
```javascript
// iframe src를 재지정하여 Monogatari 인스턴스를 완전 초기화
vnIframeEl.src = 'vn.html';
vnIframeEl.onload = () => {
  vnIframeEl.contentWindow.postMessage({ novelId }, window.location.origin);
  vnIframeEl.onload = null;
};
```

> 소설 변경 시 iframe을 리로드하는 방식으로 Monogatari 재초기화 문제를 회피.

**소설 선택 시 VN 탭 자동 갱신:** `selectNovel()` 내에서 현재 탭이 `'vn'`이면 즉시 `sendNovelIdToVnPlayer()` 호출.

### 6.4 `vn.js` 주요 로직

**postMessage 수신:**
```javascript
window.addEventListener('message', async (event) => {
  const novelId = event.data?.novelId;
  if (!novelId) return;
  // GET /novels/:id/vn-script 호출 후 initMonogatari()
});
```

**`initMonogatari({ characters, scenes, script })`:**
```javascript
monogatari.settings({
  'AssetsPath': {
    'root': '', 'characters': '', 'scenes': '', 'audio': '', 'videos': '', 'images': ''
  }
  // AssetsPath를 빈 문자열로 설정 → S3 절대 URL이 prefix 없이 그대로 사용됨
});

// 캐릭터 등록 (S3 절대 URL sprites)
for (const [charId, charData] of Object.entries(characters)) {
  monogatari.characters({ [charId]: { name: charData.name, sprites: charData.sprites } });
}

monogatari.assets('scenes', scenes);    // 배경 등록
monogatari.script({ 'main': script });  // 스크립트 등록
monogatari.init('#monogatari').then(() => {
  document.getElementById('loading-overlay').classList.add('hidden');
  monogatari.element().find('[data-action="new"]').trigger('click'); // 새 게임 자동 시작
});
```

---

## 7. 전체 파이프라인 흐름

```
[사전] S3의 {novelId}/novel.txt 에 소설 텍스트 업로드

Step 1: POST /novels               -> novel 레코드 생성 (novelId 획득)
Step 2: POST /parsing/characters   -> Gemini 분석 -> character 레코드 생성
Step 3: POST /parsing/backgrounds  -> Gemini 분석 -> background 레코드 생성
Step 4: POST /parsing/scenes       -> Gemini 분석 -> scenes.json을 S3 저장
                                      + character_img 플레이스홀더 생성 (genId=null)
                                      (scenes.json에 isEntry/isExit/position 포함)
Step 5: POST /images/characters    -> Leonardo AI로 캐릭터 이미지 생성
                                      (DEFAULT 먼저 -> 나머지 감정 병렬, NOBG 포함)
Step 6: POST /images/backgrounds   -> Leonardo AI로 배경 이미지 생성
Step 7: GET  /novels/:id/assets    -> 모든 에셋 S3 URL 반환 -> 프론트엔드 갤러리 렌더링
Step 8: GET  /novels/:id/vn-script -> scenes.json + DB 조합 -> Monogatari script 반환
                                      -> 프론트엔드 VN 플레이어 렌더링
```

---

## 8. 알려진 문제 및 개선 포인트

| # | 위치 | 문제 | 개선 방향 |
|---|---|---|---|
| 1 | `novel.service.ts:getNovelAssets` | N+1 쿼리 (캐릭터별 개별 characterImg 조회) | `getVnScript`처럼 `In(charIds)` 단일 쿼리화 |
| 2 | `image-generation.service.ts` | `orWhere`로 다른 소설 DEFAULT 이미지 포함될 수 있음 | `andWhere('(ci.genId IS NULL OR ci.emotion = :emotion)')` 형태로 수정 |
| 3 | `app.module.ts` | `synchronize: true` (프로덕션 위험) | `false`로 변경 후 TypeORM 마이그레이션 도입 |
| 4 | 전체 | 이미지 생성 진행 상황 추적 불가 | WebSocket 또는 SSE로 실시간 진행률 전송 |
| 5 | 전체 | `scenes.json`이 S3에만 저장, DB 미저장 | 게임 런타임이 S3 파일에 강하게 의존하는 구조 |
| 6 | 전체 | `novel.txt` 수동 S3 업로드 필요 | 파일 업로드 API 엔드포인트 추가 |
| 7 | `vn.js` | postMessage origin 검증 없음 (개발 편의) | 프로덕션 배포 시 origin 체크 추가 필요 |
| 8 | `vn.js` | Monogatari `init()` 후 `[data-action="new"]` 트리거 방식은 버전에 따라 동작 다를 수 있음 | Monogatari 2.6.0 정식 API 문서 확인 필요 |
| 9 | 전체 | BGM 생성 파이프라인 미완성 (`bgm_prompt`만 scenes.json에 저장, 실제 음악 생성 없음) | 음악 생성 API 연동 후 `play music` 명령 script에 삽입 |
