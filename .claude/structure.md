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

### `createNovel` 흐름

```
POST /novels { novelTitle }
  -> novelTitle 존재 확인
  -> 이미 있으면 기존 Novel 반환 (idempotent)
  -> 없으면 새로 INSERT 후 반환
```

### `getNovelAssets` 흐름

```
GET /novels/:id/assets
  -> novel 조회
  -> characters 조회 -> 각 캐릭터의 character_img 목록 조회 (N+1 문제 있음)
  -> backgrounds 조회
  -> S3 URL 조합: https://{bucket}.s3.{region}.amazonaws.com/{novelId}/...
  -> 감정별 이미지 URL(url) + 배경 제거 URL(nobgUrl) 포함하여 반환
```

---

## 4. LLM 파싱 파이프라인 (`parsing/`)

### 전체 흐름

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

### `POST /parsing/characters`

**Zod 스키마:**
```typescript
{
  globalArtStyle: string,
  styleKey: StyleKey,
  characters: Record<string, { sex: string, look: string }>
}
```

- `look` 필드 5가지 요소: 나이/성별 + 상세 헤어 + 얼굴/신체 + 상세 의상 + 소품/무기
- DB 저장: 기존 캐릭터 전체 삭제 후 재생성 (CASCADE DELETE로 character_img도 삭제됨)

### `POST /parsing/backgrounds`

**Zod 스키마:**
```typescript
{
  globalBackgroundArtStyle: string,
  styleKey: StyleKey,
  backgrounds: Record<string, { name: string, description: string }>
}
```

### `POST /parsing/scenes`

**LLM 입력:**
```
novel_text:        S3에서 읽은 원본 소설
characters_info:   "- ID: 1_char_1, Name: 백무진, Sex: male, Description: ..."
backgrounds_info:  "- ID: 1_bg_1, Name: 화산파 연무장, Description: ..."
```

**Zod 스키마:**
```typescript
{
  scenes: Array<{
    backgroundId: string,
    timeOfDay: string,
    bgm_prompt: string,
    dialogues: Array<{
      characterId: string,
      dialog: string,
      action: "IDLE" | "ATTACK" | "SHAKE",
      emotion: Emotion,
      look: string
    }>
  }>
}
```

**씬 후처리:**
1. 대화에서 캐릭터별 사용된 감정 수집 (DEFAULT는 항상 포함)
2. `character_img`에 Upsert로 플레이스홀더 생성 (`genId=null`)
3. `scenes.json`을 S3에 저장

---

## 5. 이미지 생성 파이프라인 (`image/`)

### 비동기 Fire-and-Forget 구조

```typescript
this.imageGenerationService.generateCharacterImages(novelId).catch(err => { });
return { success: true, message: 'Image generation started in background.' };
```

### `POST /images/characters` 흐름

```
1. genId가 NULL인 character_img 조회 (JOIN으로 novelId 필터링)
2. 캐릭터별 그룹화 (Map.groupBy)
3. 캐릭터 단위 병렬 처리 (Promise.all)
   └── DEFAULT 이미지 먼저 생성 (Flux 모델, 레퍼런스 확보)
       -> S3 업로드 + NOBG 추출 + DB 업데이트
   └── 나머지 감정 병렬 생성 (Lucid 모델 + initImageId로 일관성 확보)
       -> S3 업로드 + NOBG 추출 + DB 업데이트
```

### `POST /images/backgrounds` 흐름

```
1. novelId의 모든 background 조회
2. 병렬 처리 (Promise.all)
   - 프롬프트: (globalArtStyle:1.2), {styleKey}, {description}, empty scenery, no characters
   - Flux 모델, 1280x720
   - S3 업로드 + DB 업데이트
```

### Leonardo AI 생성 핵심 함수 (`generateImageToBuffer`)

```
POST /v2/generations -> generationId 획득
     |
폴링 (최대 60회 x 3초 = 최대 180초)
  GET /v1/generations/{generationId}
  -> status == 'COMPLETE' 일 때 이미지 URL 획득
     |
이미지 URL로 binary 다운로드 -> Buffer 반환
```

### NOBG (배경 제거) 파이프라인

```
POST /v1/variations/nobg { id: genId }
     |
폴링: GET /v1/variations/{sdNobgJobId}
  -> transformType === 'NOBG' 찾을 때까지 대기
     |
S3 업로드: characters/{charId}_{emotion}_NOBG.png + nobgGenId DB 업데이트
```

### 캐릭터 이미지 프롬프트 구조 (`image/prompt/prompt.ts`)

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

## 6. 알려진 문제 및 개선 포인트

| # | 위치 | 문제 | 개선 방향 |
|---|---|---|---|
| 1 | `novel.service.ts` | N+1 쿼리 (캐릭터별 개별 characterImg 조회) | JOIN 또는 QueryBuilder로 단일 쿼리화 |
| 2 | `image-generation.service.ts` | `orWhere`로 다른 소설 DEFAULT 이미지 포함될 수 있음 | `andWhere('(ci.genId IS NULL OR ci.emotion = :emotion)')` 형태로 수정 |
| 3 | `app.module.ts` | `synchronize: true` (프로덕션 위험) | `false`로 변경 후 TypeORM 마이그레이션 도입 |
| 4 | 전체 | 이미지 생성 진행 상황 추적 불가 | WebSocket 또는 SSE로 실시간 진행률 전송 |
| 5 | 전체 | `scenes.json`이 S3에만 저장, DB 미저장 | 게임 런타임이 S3 파일에 강하게 의존하는 구조 |
| 6 | 전체 | `novel.txt` 수동 S3 업로드 필요 | 파일 업로드 API 엔드포인트 추가 |
