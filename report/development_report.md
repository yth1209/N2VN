# N2VN 백엔드 기술 보고서
## Novel-to-Visual-Novel 변환 파이프라인: AI Agent 간 데이터 전달 구조 분석

---

## 1. 시스템 개요

N2VN은 텍스트 소설을 입력받아 캐릭터 이미지, 배경 이미지, BGM, 대화 스크립트가 결합된 비주얼 노벨(Visual Novel) 형식으로 자동 변환하는 시스템이다. 백엔드는 NestJS 11(TypeScript) 기반으로 구현되어 있으며, 복수의 AI 서비스를 순차적 또는 병렬로 호출하는 멀티 에이전트 파이프라인 구조를 채택하고 있다.

변환 파이프라인은 크게 다음 5개 단계로 구성된다.

1. **캐릭터 파싱** — Gemini LLM이 소설 텍스트에서 등장인물 정보를 추출한다.
2. **씬 파싱** — Gemini LLM이 배경, BGM, 대화 스크립트를 추출하고 화면 상태를 정의한다.
3. **캐릭터 이미지 생성** — Gemini Image가 캐릭터 스프라이트를 생성한다.
4. **배경 이미지 생성** — Gemini Image로 배경 이미지를 생성한다.
5. **BGM 생성** — Google Lyria 3 Clip이 음악 클립을 생성한다.

모든 단계는 NestJS의 `EventEmitter2`를 통한 이벤트 버스로 연결되며, AWS S3와 MariaDB(TypeORM)를 통해 AI Agent 간 데이터를 교환한다.

---

## 2. 기술 스택

| 구성 요소 | 기술 |
|---|---|
| 서버 프레임워크 | NestJS 11 (TypeScript) |
| ORM / DB | TypeORM 0.3 + MariaDB (AWS RDS) |
| 이벤트 버스 | `@nestjs/event-emitter` (EventEmitter2) |
| LLM (텍스트 분석) | Google Gemini 2.5 Flash (LangChain + StructuredOutputParser) |
| 이미지 생성 | Gemini Image API |
| 오디오 생성 | Google Lyria 3 Clip |
| 배경 제거 | Photoroom API |
| 클라우드 스토리지 | AWS S3 (AES256 암호화) |
| 스키마 검증 | Zod |

---

## 3. 데이터 모델 (Entity 구조)

파이프라인 전체에서 사용하는 핵심 DB 테이블은 다음과 같다.

### 3.1 Series (시리즈)
소설 하나의 최상위 단위. 캐릭터·배경 스타일 정보가 시리즈 레벨에서 한 번 결정되어 이후 에피소드에서 재사용된다.

```
Series {
  id:                  UUID (PK)
  title:               string
  description:         string
  authorId:            UUID (FK → User)
  characterStyleKey:   StyleKey enum   // 최초 캐릭터 파싱 시 확정
  characterArtStyle:   string          // Gemini가 결정한 자연어 화풍
  backgroundStyleKey:  StyleKey enum   // 최초 씬 파싱 시 확정
  backgroundArtStyle:  string
  latestEpisodeAt:     datetime
}
```

### 3.2 Episode (에피소드)
각 변환 요청의 단위. 파이프라인 전체의 상태를 추적한다.

```
Episode {
  id:            UUID (PK)
  seriesId:      UUID (FK → Series)
  episodeNumber: int
  title:         string
  status:        enum (PENDING | PROCESSING | DONE | FAILED)
  errorMessage:  string?
}
```

### 3.3 EpisodePipelineStep (파이프라인 단계 추적)
5개 파이프라인 스텝 각각의 실행 상태와 타임스탬프를 기록한다.

```
EpisodePipelineStep {
  id:           UUID (PK)
  episodeId:    UUID (FK → Episode)
  stepKey:      enum (parseCharacters | parseScenes | generateCharacterImages
                      | generateBackgroundImages | generateBgm)
  status:       enum (PENDING | PROCESSING | DONE | FAILED)
  startedAt:    datetime?
  finishedAt:   datetime?
  errorMessage: string?
}
```

### 3.4 Character (캐릭터)
Gemini가 추출한 등장인물 정보. 시리즈 레벨에서 공유된다.

```
Character {
  id:           UUID (PK)
  seriesId:     UUID (FK → Series)
  name:         string        // 원문 이름 (번역 금지)
  sex:          string        // male | female | unknown
  look:         string        // 이미지 생성 프롬프트용 외형 키워드
  subjectCount: int (1~3)     // 단일=1, 그룹=2~3
}
```

### 3.5 CharacterImg (캐릭터 이미지)
`(characterId, emotion)` 복합 PK로 감정별 이미지를 관리한다.

```
CharacterImg {
  characterId: UUID (PK, FK → Character)
  emotion:     Emotion enum (PK)  // DEFAULT|SERIOUS|SMILE|...|FEAR
  genId:       string?   // 이미지 생성 결과 ID (미사용)
  nobgGenId:   string?   // NOBG 변환 결과 ID (미사용)
  status:      GenStatus // PENDING | PROCESSING | DONE | FAILED
}
```

### 3.6 Background (배경)
씬 파싱 시 생성되는 배경 엔티티.

```
Background {
  id:          UUID (PK)
  seriesId:    UUID (FK → Series)
  name:        string
  description: string   // 시간대 제외한 시각적 특징 (영문)
  genId:       string?
  status:      GenStatus
}
```

### 3.7 Bgm (배경음악)
씬 파싱 시 생성되는 BGM 엔티티.

```
Bgm {
  id:       UUID (PK)
  seriesId: UUID (FK → Series)
  category: BgmCategory enum  // ACTION|ROMANCE|MYSTERY|PEACEFUL|SAD|EPIC|DARK
  prompt:   string            // Lyria 3 Clip용 영어 프롬프트
  genId:    string?
  status:   GenStatus
}
```

---

## 4. 파이프라인 오케스트레이션

### 4.1 이벤트 버스 기반 체인

NestJS `EventEmitter2`를 통해 각 단계가 이벤트로 연결된다. 이벤트는 `pipeline.events.ts`에 `const enum`으로 정의된다.

```typescript
// src/pipeline/pipeline.events.ts
export const enum PipelineEvent {
  START             = 'pipeline.start',
  CHARACTERS_START  = 'pipeline.characters.start',
  CHARACTERS_DONE   = 'pipeline.characters.done',
  SCENES_START      = 'pipeline.scenes.start',
  SCENES_DONE       = 'pipeline.scenes.done',
  CHAR_IMG_START    = 'pipeline.charImages.start',
  CHAR_IMG_DONE     = 'pipeline.charImages.done',
  BG_IMG_START      = 'pipeline.bgImages.start',
  BG_IMG_DONE       = 'pipeline.bgImages.done',
  BGM_START         = 'pipeline.bgm.start',
  BGM_DONE          = 'pipeline.bgm.done',
}

export class PipelineStepPayload {
  episodeId: string;
}
```

페이로드는 `episodeId` 단일 필드만 전달한다. 각 핸들러는 이 ID로 DB에서 필요한 데이터를 직접 조회한다.

### 4.2 이벤트 흐름도

```
[HTTP] POST /series/:id/episodes  (novel.txt 업로드)
  │
  ▼
EpisodeService.createEpisode()
  ├─ Episode INSERT (status: PROCESSING)
  ├─ EpisodePipelineStep 5개 INSERT (status: PENDING)
  ├─ S3 업로드: series/{seriesId}/episodes/{episodeId}/novel.txt
  └─ EpisodePipelineService.run(episodeId)  ← fire-and-forget
       │
       └─ emit(PipelineEvent.START)
            │
            ▼
       CharacterParsingHandler  [@OnEvent(START)]
            │  execute() → ParsingService.parseCharacters()
            │  emit(CHARACTERS_DONE)
            ▼
       SceneParsingHandler  [@OnEvent(CHARACTERS_DONE)]
            │  execute() → ParsingService.parseScenes()
            │  emit(SCENES_DONE)
            ├──────────────────────────┐
            ▼                          ▼
  CharacterImageHandler         BackgroundImageHandler
  [@OnEvent(SCENES_DONE)]       [@OnEvent(SCENES_DONE)]
  ImageService.generateChar()   ImageService.generateBg()
  emit(CHAR_IMG_DONE)           emit(BG_IMG_DONE)
            │                          │
            └──────────┬───────────────┘
                       ▼
               BgmHandler  [@OnEvent(SCENES_DONE)]
               SoundService.generateBgm()
               emit(BGM_DONE)
                       │
                       ▼
         BasePipelineHandler.checkEpisodeDone()
         → 모든 스텝 DONE이면 Episode.status = DONE
```

**주목할 점**: `SCENES_DONE` 이벤트 하나에 `CharacterImageHandler`, `BackgroundImageHandler`, `BgmHandler` 세 핸들러가 동시에 구독한다. 즉, 씬 파싱 완료 후 캐릭터 이미지·배경 이미지·BGM 생성이 동시에 시작된다.

### 4.3 BasePipelineHandler (공통 실행 기반)

모든 핸들러는 `BasePipelineHandler`를 상속한다.

```typescript
// src/pipeline/handlers/base/base-pipeline.handler.ts
protected async run(payload: PipelineStepPayload): Promise<void> {
  const { episodeId } = payload;

  // 1. EpisodeStatus를 PROCESSING으로 업데이트
  await this.repo.episode.update(episodeId, { status: EpisodeStatus.PROCESSING });
  // 2. 해당 스텝의 status를 PROCESSING으로 업데이트, startedAt 기록
  await this.repo.pipelineStep.updateStep(episodeId, this.stepKey, StepStatus.PROCESSING, { startedAt: new Date() });

  try {
    await this.execute(episodeId);  // 각 핸들러의 실제 로직

    // 3. 스텝 DONE 처리, finishedAt 기록
    await this.repo.pipelineStep.updateStep(episodeId, this.stepKey, StepStatus.DONE, { finishedAt: new Date() });
    // 4. 다음 이벤트 emit
    this.eventEmitter.emit(this.doneEvent, payload);
    // 5. 모든 스텝이 DONE인지 확인 → Episode DONE 처리
    await this.checkEpisodeDone(episodeId, episode.seriesId);

  } catch (err) {
    // 6. 오류 시 스텝과 에피소드 모두 FAILED 처리
    await this.repo.pipelineStep.updateStep(episodeId, this.stepKey, StepStatus.FAILED, { finishedAt: new Date(), errorMessage: err.message });
    await this.repo.episode.update(episodeId, { status: EpisodeStatus.FAILED, errorMessage: `[${this.stepKey}] ${err.message}` });
  }
}

private async checkEpisodeDone(episodeId: string, seriesId: string): Promise<void> {
  const hasUnfinished = await this.repo.pipelineStep.findOneBy({ episodeId, status: Not(StepStatus.DONE) });
  if (!hasUnfinished) {
    await this.repo.episode.update(episodeId, { status: EpisodeStatus.DONE });
    await this.repo.series.update(seriesId, { latestEpisodeAt: new Date() });
  }
}
```

---

## 5. Step 1: 캐릭터 파싱 (CharacterParsingHandler)

### 5.1 트리거 및 핸들러

```typescript
// CharacterParsingHandler
@OnEvent(PipelineEvent.CHARACTERS_START)
@OnEvent(PipelineEvent.START)
handle(payload: PipelineStepPayload) { return this.run(payload); }

protected execute(episodeId: string) {
  return this.parsingService.parseCharacters(episodeId);
}
```

두 이벤트를 모두 구독한다. `START`는 파이프라인 자동 실행 시, `CHARACTERS_START`는 HTTP 엔드포인트 수동 재실행 시 사용된다.

### 5.2 데이터 입력

- **S3**: `series/{seriesId}/episodes/{episodeId}/novel.txt` — 소설 원문 텍스트
- **DB**: `Character` 테이블 — 해당 시리즈의 기존 캐릭터 목록 (중복 추출 방지)

### 5.3 AI 호출 (Gemini LLM)

`GenAIHelperService.geminiParse<T>()`를 통해 LangChain 체인을 실행한다.

```typescript
// GenAIHelperService
async geminiParse<T>(
  template:       string,   // 프롬프트 템플릿 (character_prompt)
  inputVariables: string[], // ['novel_text', 'existing_characters']
  schema:         ZodSchema<T>,
  variables:      Record<string, string>,
): Promise<T> {
  const parser         = StructuredOutputParser.fromZodSchema(schema);
  const promptTemplate = new PromptTemplate({ template, inputVariables,
    partialVariables: { format_instructions: parser.getFormatInstructions() } });
  const chain = promptTemplate.pipe(this.geminiModel).pipe(parser);
  return chain.invoke(variables) as Promise<T>;
}
```

LangChain의 `StructuredOutputParser`가 Zod 스키마에서 JSON 포맷 지시문을 자동 생성하여 프롬프트에 삽입하고, LLM 응답을 파싱한다. 모델은 `gemini-2.5-flash`이며 `temperature: 0.1`로 결정론적 출력에 가깝게 설정된다.

### 5.4 프롬프트 전략 (character_prompt)

```
You are an expert Art Director for a Visual Novel.
...
[CRITICAL INSTRUCTIONS]
- Do NOT translate the character's name into English. Keep the original name exactly.
- [STRICTLY FORBIDDEN] Do NOT include any facial expressions, emotions, or mood descriptions in the 'look' field.
- The 'look' field MUST be a dense, comma-separated English prompt designed for image generation AI.
- [VITAL: CREATIVE INFERENCE] If specific physical traits are not mentioned, INFER and CREATE highly specific details based on character's job, personality, and genre.
- Format the 'look' field by strictly combining these 5 elements:
    1. Age/Gender (plural if subjectCount > 1)
    2. Detailed Hair
    3. Face/Body features
    4. Detailed Clothing
    5. Props/Weapons
- 'subjectCount': EXACT number of individuals (1~3, max 3 for groups)
```

`look` 필드에서 감정 표현을 금지하는 이유는 이후 이미지 생성 단계에서 감정을 별도 레이어로 추가해야 하기 때문이다. `subjectCount`는 군중·그룹 캐릭터를 단일 엔티티로 모델링하기 위한 필드다.

### 5.5 Zod 출력 스키마

```typescript
const characterSchema = z.object({
  globalArtStyle: z.string(),   // 공통 화풍 키워드 (이미지 생성 프롬프트에 재사용)
  styleKey:       z.nativeEnum(StyleKey),  // 이미지 생성 스타일 키 (배경 프롬프트 텍스트로 사용)
  characters:     z.record(
    z.string(),   // 캐릭터 이름
    z.object({
      sex:          z.string(),
      look:         z.string(),    // SD 프롬프트용 외형 기술
      subjectCount: z.number().int().min(1).max(3),
    }),
  ),
});
```

### 5.6 최종 LLM 요청 프롬프트 (실제 전송 형태)

LangChain `PromptTemplate`이 `character_prompt` 템플릿의 `{format_instructions}` 자리에 `StructuredOutputParser.getFormatInstructions()`의 반환값을, `{existing_characters}`와 `{novel_text}` 자리에 DB/S3 조회 결과를 대입하여 아래와 같은 완성 프롬프트를 Gemini에 전송한다.

```
You are an expert Art Director for a Visual Novel.
Read the following novel text carefully and extract detailed character design information
to create a definitive "Character Bible" for ALL **NEW** characters appearing in the text.

You must format your output as a JSON value that adheres to a given "JSON Schema" instance.

"JSON Schema" is a declarative language that allows you to annotate and validate JSON
documents.

For example, the JSON Schema {"properties": {"foo": {"description": "a list of test words",
"type": "array", "items": {"type": "string"}}}, "required": ["foo"]} would produce a well
formatted instance: {"foo": ["bar", "baz"]}

Here is the JSON Schema instance your output must conform to. Include the STARTING `{` and
ENDING `}` of the JSON:
{
  "type": "object",
  "properties": {
    "globalArtStyle": {
      "type": "string",
      "description": "이 소설의 모든 캐릭터 이미지 생성 시 공통으로 적용될 화풍 및 렌더링 스타일 영어 키워드 리스트"
    },
    "styleKey": {
      "type": "string",
      "enum": [
        "BOKEH", "CINEMATIC", "CINEMATIC_CLOSEUP", "CREATIVE", "DYNAMIC",
        "FASHION", "FILM", "FOOD", "HDR", "LONG_EXPOSURE", "MACRO",
        "MINIMALIST", "MONOCHROME", "MOODY", "NEUTRAL", "NONE",
        "PORTRAIT", "RETRO", "STOCK_PHOTO", "UNPROCESSED", "VIBRANT"
      ],
      "description": "소설 장르 및 분위기에 가장 어울리는 렌더링 필터 스타일"
    },
    "characters": {
      "type": "object",
      "description": "등장인물의 원본 이름 (번역 금지, 원문 그대로)",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "sex": {
            "type": "string",
            "description": "성별 (male, female, unknown)"
          },
          "look": {
            "type": "string",
            "description": "캐릭터 비주얼 Character Bible 프롬프트 (영어 키워드)"
          },
          "subjectCount": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3,
            "description": "이 캐릭터 엔트리가 나타내는 실제 인원 수 (단일 = 1, 그룹 = 2~3)"
          }
        },
        "required": ["sex", "look", "subjectCount"],
        "additionalProperties": false
      }
    }
  },
  "required": ["globalArtStyle", "styleKey", "characters"],
  "additionalProperties": false
}

[EXISTING CHARACTERS — DO NOT RE-EXTRACT THESE]
The following characters already exist in the system. Even if they appear under different
aliases, titles, or honorifics, do NOT include them in your output.
Only extract characters that are completely new and not represented below.
- ID: <uuid>, Name: 아리아, Sex: female, Look: young woman in her early 20s, ...
  ↑ DB Character 테이블에서 조회한 기존 캐릭터 목록 (없으면 "(없음)")

[CRITICAL INSTRUCTIONS]
- Do NOT translate the character's name into English. Keep the original name exactly as it
  appears in the text.
- [STRICTLY FORBIDDEN] Do NOT include any facial expressions, emotions, or mood descriptions
  in the 'look' field.
- The 'look' field MUST be a dense, comma-separated English prompt designed for
  image generation AI.
- [VITAL: CREATIVE INFERENCE] If specific physical traits or clothing details are not
  explicitly mentioned, INFER and CREATE highly specific details based on the character's
  job, personality, and genre. Do not use generic words or "unknown".
- Format the 'look' field by strictly combining these 5 elements:
    1. Age/Gender (use plural if subjectCount > 1, e.g. "3 teenage girls")
    2. Detailed Hair
    3. Face/Body features
    4. Detailed Clothing
    5. Props/Weapons
- 'subjectCount' field: the EXACT number of distinct individuals this character entry
  represents. Use 1 for a single person. Use 2 or more for a group that always appears
  together as a unit (e.g. a trio of soldiers = 3). Maximum value is 3.
- If there are NO new characters in this episode, return an empty object for "characters".

Novel Text:
"""
<S3에서 읽어온 novel.txt 원문 전체>
"""
```

`{format_instructions}` 블록(JSON Schema 부분)은 Zod 스키마에서 LangChain이 자동 생성하며, 실제 전송 시에는 하나의 연속된 문자열로 조립된다. `{existing_characters}`와 `{novel_text}`는 런타임에 DB/S3 조회 결과로 치환된다.

### 5.7 데이터 출력

```typescript
// 시리즈 스타일 최초 1회만 저장
if (!series.characterArtStyle) {
  series.characterArtStyle = result.globalArtStyle;
  series.characterStyleKey = result.styleKey;
  await this.repo.series.save(series);
}

// 신규 캐릭터 DB 적재
const newCharacters = Object.entries(result.characters).map(([name, attr]) =>
  this.repo.character.create({ seriesId: series.id, name, sex: attr.sex, look: attr.look, subjectCount: attr.subjectCount ?? 1 })
);
await this.repo.character.save(newCharacters);
```

- **DB 출력**: `Character` 레코드 (name, sex, look, subjectCount)
- **DB 출력**: `Series.characterArtStyle`, `Series.characterStyleKey` (최초 1회)

---

## 6. Step 2: 씬 파싱 (SceneParsingHandler)

### 6.1 트리거 및 핸들러

```typescript
// SceneParsingHandler
@OnEvent(PipelineEvent.SCENES_START)
@OnEvent(PipelineEvent.CHARACTERS_DONE)
handle(payload: PipelineStepPayload) { return this.run(payload); }
```

`CHARACTERS_DONE` 이벤트를 받아 자동으로 실행된다.

### 6.2 데이터 입력

- **S3**: `series/{seriesId}/episodes/{episodeId}/novel.txt` — 소설 원문
- **DB**: `Character` 테이블 — 전 단계에서 저장된 캐릭터 목록 (ID 포함)
- **DB**: `Background` 테이블 — 시리즈의 기존 배경 목록
- **DB**: `Bgm` 테이블 — 시리즈의 기존 BGM 목록

Step 1의 출력(캐릭터 ID, look)이 Step 2의 핵심 입력으로 전달된다.

### 6.3 프롬프트 전략 (scene_prompt)

```
Before listing scenes, you MUST declare all NEW backgrounds and BGMs
in the newBackgrounds and newBgms arrays. Then reference them by tempId.

[BACKGROUND RULES]
- Reuse existing background ID if location matches.
- NEW location → add to newBackgrounds with tempId "new_bg_N", use tempId as backgroundId.
- timeOfDay is per scene and must NOT appear in the background description.

[BGM RULES]
- Consecutive scenes with similar mood SHOULD share the same bgmId (musical continuity).
- BGM prompt must be in English, under 30 words.

[DIALOGUE RULES]
# Screen State Rules (CRITICAL)
- "currentScreen": every dialogue block MUST include ALL visible characters at that moment.
- 1 Character: MUST be "center". 2 Characters: "left" and "right". 3: "left", "center", "right".
- MAX 3 characters. If 4th must appear, REMOVE the least active one.

# Group Character Monopoly
- Group characters MUST be alone on screen (position: "center").
```

`tempId` 패턴이 핵심이다. LLM이 신규 배경/BGM을 `new_bg_1`, `new_bgm_1` 형식의 임시 ID로 선언하고 씬에서 참조하면, 코드에서 실제 UUID로 치환한다.

### 6.4 Zod 출력 스키마

```typescript
const sceneSchema = z.object({
  globalBackgroundArtStyle: z.string(),
  backgroundStyleKey:       z.nativeEnum(StyleKey),
  newBackgrounds: z.array(z.object({
    tempId:      z.string(),   // "new_bg_1" 형식
    name:        z.string(),
    description: z.string(),   // 시각적 특징 (시간대 제외)
  })),
  newBgms: z.array(z.object({
    tempId:   z.string(),      // "new_bgm_1" 형식
    category: z.nativeEnum(BgmCategory),
    prompt:   z.string(),      // Lyria용 30단어 이내 영어 프롬프트
  })),
  scenes: z.array(z.object({
    backgroundId: z.string(),
    bgmId:        z.string(),
    timeOfDay:    z.string(),
    dialogues: z.array(z.object({
      characterId:   z.string(),   // 캐릭터 ID 또는 "narrator"
      dialog:        z.string(),   // 원문 대사 (번역 금지)
      currentScreen: z.array(z.object({
        characterId: z.string(),
        position:    z.enum(['left', 'center', 'right']),
        emotion:     z.nativeEnum(Emotion),
        look:        z.string(),
        action:      z.enum(['IDLE', 'ATTACK', 'SHAKE']),
      })),
    })),
  })),
});
```

### 6.5 최종 LLM 요청 프롬프트 (실제 전송 형태)

동일하게 LangChain `PromptTemplate`이 `scene_prompt`의 `{format_instructions}`, `{characters_info}`, `{existing_backgrounds}`, `{existing_bgms}`, `{novel_text}` 자리를 런타임 값으로 치환하여 아래와 같이 조립한다.

```
You are an expert novel scriptwriter and director.
Your task is to analyze the provided novel text and break it down into multiple Scenes
based on changes in Location or Time.

Before listing scenes, you MUST declare all NEW backgrounds and BGMs in the newBackgrounds
and newBgms arrays. Then reference them by tempId in the scenes array.

You must format your output as a JSON value that adheres to a given "JSON Schema" instance.

"JSON Schema" is a declarative language that allows you to annotate and validate JSON
documents.

For example, the JSON Schema {"properties": {"foo": {"description": "a list of test words",
"type": "array", "items": {"type": "string"}}}, "required": ["foo"]} would produce a well
formatted instance: {"foo": ["bar", "baz"]}

Here is the JSON Schema instance your output must conform to. Include the STARTING `{` and
ENDING `}` of the JSON:
{
  "type": "object",
  "properties": {
    "globalBackgroundArtStyle": {
      "type": "string",
      "description": "이 소설의 모든 배경 이미지 생성에 공통 적용될 화풍·분위기 영어 키워드"
    },
    "backgroundStyleKey": {
      "type": "string",
      "enum": ["BOKEH", "CINEMATIC", ... (StyleKey 전체 21개 값)],
      "description": "배경 렌더링 필터 스타일"
    },
    "newBackgrounds": {
      "type": "array",
      "description": "기존 배경 목록에 없어 새로 생성해야 하는 배경들",
      "items": {
        "type": "object",
        "properties": {
          "tempId":      { "type": "string", "description": "new_bg_{n} 형식의 임시 ID" },
          "name":        { "type": "string", "description": "배경 명칭" },
          "description": { "type": "string", "description": "시각적 특징·분위기 영문 줄글 (시간대 제외)" }
        },
        "required": ["tempId", "name", "description"],
        "additionalProperties": false
      }
    },
    "newBgms": {
      "type": "array",
      "description": "기존 BGM 목록에 없어 새로 생성해야 하는 BGM들",
      "items": {
        "type": "object",
        "properties": {
          "tempId":   { "type": "string", "description": "new_bgm_{n} 형식의 임시 ID" },
          "category": { "type": "string", "enum": ["ACTION","ROMANCE","MYSTERY","PEACEFUL","SAD","EPIC","DARK"],
                        "description": "BGM 감정 카테고리" },
          "prompt":   { "type": "string", "description": "Lyria 3 Clip 생성용 영어 텍스트 프롬프트 (30단어 이내)" }
        },
        "required": ["tempId", "category", "prompt"],
        "additionalProperties": false
      }
    },
    "scenes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "backgroundId": { "type": "string",
            "description": "이 씬의 배경 ID. 기존이면 그대로, 신규면 newBackgrounds 선언 후 동일 tempId 사용" },
          "bgmId":        { "type": "string",
            "description": "이 씬의 BGM ID. 기존이면 그대로, 신규면 newBgms 선언 후 동일 tempId 사용" },
          "timeOfDay":    { "type": "string",
            "description": "씬이 일어나는 시간대 (예: Morning, Night, Dusk)" },
          "dialogues": {
            "type": "array",
            "description": "이 씬에 포함되는 모든 대사와 나레이션을 순서대로 담은 배열",
            "items": {
              "type": "object",
              "properties": {
                "characterId": { "type": "string",
                  "description": "화자의 고유 ID. 나레이션인 경우 narrator" },
                "dialog":      { "type": "string",
                  "description": "대사 또는 서술 내용 문장 원문 (번역 금지)" },
                "currentScreen": {
                  "type": "array",
                  "description": "이 대사가 출력되는 순간 화면에 있는 모든 캐릭터 목록 (narrator 제외)",
                  "items": {
                    "type": "object",
                    "properties": {
                      "characterId": { "type": "string" },
                      "position":    { "type": "string", "enum": ["left","center","right"] },
                      "emotion":     { "type": "string",
                        "enum": ["DEFAULT","SERIOUS","SMILE","SMIRK","ANGRY","RAGE","SAD","PAIN","SURPRISED","FEAR"] },
                      "look":        { "type": "string" },
                      "action":      { "type": "string", "enum": ["IDLE","ATTACK","SHAKE"] }
                    },
                    "required": ["characterId","position","emotion","look","action"],
                    "additionalProperties": false
                  }
                }
              },
              "required": ["characterId","dialog","currentScreen"],
              "additionalProperties": false
            }
          }
        },
        "required": ["backgroundId","bgmId","timeOfDay","dialogues"],
        "additionalProperties": false
      }
    }
  },
  "required": ["globalBackgroundArtStyle","backgroundStyleKey","newBackgrounds","newBgms","scenes"],
  "additionalProperties": false
}

[BACKGROUND RULES]
- If the scene location matches an entry in the existing backgrounds list, reuse that ID
  directly as backgroundId.
- If it is a NEW location not in the list, add it to newBackgrounds with tempId like
  "new_bg_1", "new_bg_2", etc., then use that tempId as backgroundId.
- timeOfDay is specified per scene and must NOT appear in the background description.
- If the location is completely unknown, use "bg_unknown" as backgroundId.

[BGM RULES]
- If the scene mood/category matches an existing BGM, reuse that ID as bgmId.
- If it requires NEW music, add it to newBgms with tempId like "new_bgm_1", etc.
- Consecutive scenes with a similar mood SHOULD share the same bgmId (musical continuity).
- BGM prompt must be in English, under 30 words.

[DIALOGUE RULES]

# 1. Text & Metadata Rules
- Ensure NO dialogue is skipped. Retain the exact original language. Do NOT translate.
- characterId: match to ID using characters_info. Use "narrator" for narration.
- Narrator Blocks: ONLY keep essential plot advancements. Summarize. Avoid consecutive ones.

# 2. Screen State & Positioning Rules (CRITICAL)
- "currentScreen": every dialogue block MUST include ALL visible characters at that moment.
- Narrator is EXCLUDED from currentScreen.

# 3. Dynamic Layout Adjustment
- 1 Character: MUST be "center".
- 2 Characters: MUST be "left" and "right".
- 3 Characters: MUST be "left", "center", and "right".
- MAX 3 characters. If 4th must appear, REMOVE the least active character.

# 4. Group Character Monopoly Exception
- Group characters MUST be alone on screen (position: "center").
- ALL other characters MUST be removed from currentScreen in that turn.


Known Characters Information:
- ID: <uuid-1>, Name: 아리아, Sex: female, Description: young woman in her early 20s, ...
- ID: <uuid-2>, Name: 레온, Sex: male, Description: tall man with silver hair, ...
  ↑ DB Character 테이블에서 조회한 캐릭터 목록 (Step 1 출력)

## Existing Backgrounds (reuse if matching)
- ID: <uuid-bg>, Name: 왕궁 홀, Description: grand royal hall with marble pillars, ...
  ↑ DB Background 테이블 (없으면 "(없음)")

## Existing BGMs (reuse if matching)
- ID: <uuid-bgm>, Category: ROMANCE, Prompt: gentle piano melody with soft strings, ...
  ↑ DB Bgm 테이블 (없으면 "(없음)")

Novel Text:
"""
<S3에서 읽어온 novel.txt 원문 전체>
"""
```

씬 파싱 프롬프트는 캐릭터 파싱보다 JSON Schema 깊이가 훨씬 크다. `currentScreen` 배열이 `dialogues` 배열 내에 중첩되어, 한 번의 LLM 호출로 배경·BGM 선언, 전체 씬·대화 구조, 매 대화 시점의 화면 상태까지 모두 추출하는 것이 핵심 설계다. LangChain의 `StructuredOutputParser`가 이 중첩 스키마 전체를 JSON Schema로 변환하여 `{format_instructions}` 자리에 주입한다.

### 6.6 LLM 응답 후처리 (DB 적재 및 ID 치환)

```typescript
// 1. 신규 배경 DB 적재 + tempId → realId 맵 구성
const bgTempToRealId = new Map<string, string>();
for (const nb of result.newBackgrounds) {
  const saved = await this.repo.background.save(
    this.repo.background.create({ seriesId, name: nb.name, description: nb.description, status: GenStatus.PENDING })
  );
  bgTempToRealId.set(nb.tempId, saved.id);
}

// 2. 신규 BGM DB 적재 + tempId → realId 맵 구성
const bgmTempToRealId = new Map<string, string>();
for (const nb of result.newBgms) {
  const saved = await this.repo.bgm.save(
    this.repo.bgm.create({ seriesId, category: nb.category, prompt: nb.prompt, status: GenStatus.PENDING })
  );
  bgmTempToRealId.set(nb.tempId, saved.id);
}

// 3. scenes의 tempId를 실제 UUID로 치환
const resolvedScenes = result.scenes.map((scene) => ({
  ...scene,
  backgroundId: bgTempToRealId.get(scene.backgroundId) ?? scene.backgroundId,
  bgmId:        bgmTempToRealId.get(scene.bgmId)        ?? scene.bgmId,
}));
```

### 6.7 CharacterImg 플레이스홀더 생성

씬 파싱 결과를 분석하여 각 캐릭터가 어떤 감정으로 등장하는지 수집하고, 이미지 생성 요청용 플레이스홀더를 생성한다.

```typescript
// 씬 전체를 스캔하여 (캐릭터 ID, 감정) 조합 수집
const emotionMap = new Map<string, Set<Emotion>>();
for (const scene of resolvedScenes) {
  for (const dialogue of scene.dialogues) {
    for (const entry of dialogue.currentScreen ?? []) {
      if (!emotionMap.has(entry.characterId))
        emotionMap.set(entry.characterId, new Set<Emotion>([Emotion.DEFAULT]));
      emotionMap.get(entry.characterId)!.add(entry.emotion as Emotion);
    }
  }
}

// CharacterImg 플레이스홀더 생성 (genId=null, status=PENDING)
for (const [charId, emotions] of emotionMap.entries()) {
  for (const emotion of emotions) {
    const exists = await this.repo.characterImg.findOne({ where: { characterId: charId, emotion } });
    if (!exists) {
      await this.repo.characterImg.save(
        this.repo.characterImg.create({ characterId: charId, emotion, genId: null, status: GenStatus.PENDING })
      );
    }
  }
}
```

DEFAULT 감정은 모든 캐릭터에 자동 포함된다. 플레이스홀더는 다음 이미지 생성 단계에서 큐로 활용된다.

### 6.8 데이터 출력

- **DB**: `Background` 레코드 (name, description, status=PENDING)
- **DB**: `Bgm` 레코드 (category, prompt, status=PENDING)
- **DB**: `CharacterImg` 플레이스홀더 (characterId, emotion, status=PENDING)
- **DB**: `Series.backgroundArtStyle`, `Series.backgroundStyleKey` (최초 1회)
- **S3**: `series/{seriesId}/episodes/{episodeId}/scenes.json`

#### scenes.json 구조

```json
{
  "scenes": [
    {
      "backgroundId": "uuid-of-bg",
      "bgmId": "uuid-of-bgm",
      "timeOfDay": "Night",
      "dialogues": [
        {
          "characterId": "uuid-of-char",
          "dialog": "원문 대사 그대로",
          "currentScreen": [
            {
              "characterId": "uuid-of-char",
              "position": "center",
              "emotion": "SERIOUS",
              "look": "standing straight, arms crossed",
              "action": "IDLE"
            }
          ]
        },
        {
          "characterId": "narrator",
          "dialog": "서술 내용",
          "currentScreen": []
        }
      ]
    }
  ]
}
```

---

## 7. Step 3: 캐릭터 이미지 생성 (CharacterImageHandler)

### 7.1 트리거 및 병렬 실행

```typescript
// CharacterImageHandler, BackgroundImageHandler, BgmHandler
@OnEvent(PipelineEvent.SCENES_DONE)
handle(payload: PipelineStepPayload) { return this.run(payload); }
```

세 핸들러 모두 `SCENES_DONE` 하나를 구독하여 동시에 실행을 시작한다.

### 7.2 데이터 입력

- **DB**: `CharacterImg` (status IN [PENDING, FAILED]) — Step 2에서 생성된 플레이스홀더
- **DB**: `Character` — look, subjectCount (JOIN)
- **DB**: `Series` — characterArtStyle, characterStyleKey

```typescript
const pendingImages = await this.repo.characterImg
  .createQueryBuilder('ci')
  .innerJoinAndSelect('ci._characterFk', 'c')
  .where('c.seriesId = :seriesId', { seriesId: series.id })
  .andWhere('ci.status IN (:...statuses)', { statuses: [GenStatus.PENDING, GenStatus.FAILED] })
  .getMany();

const charGroups     = Map.groupBy(pendingImages, (pi) => pi.characterId);
const globalArtStyle = series.characterArtStyle || '';
```

### 7.3 이미지 프롬프트 생성

이미지 생성 요청 직전에 `getCharacterPrompt()` 함수로 최종 프롬프트를 조립한다.

```typescript
// src/image/prompt/prompt.ts

const FRAMING_BLOCK    = "full body shot, full length portrait, showing entire body from head to feet, standing, front view, facing forward, looking at viewer, straight on";
const BACKGROUND_BLOCK = "solid white background for removebg post-processing, no background elements, alpha channel";

function getEmotionBlock(emotion: Emotion) {
  switch(emotion) {
    case Emotion.DEFAULT:   return "calm and composed expression, stoic, confident eyes";
    case Emotion.SERIOUS:   return "serious, slightly furrowed brows, sharp focused gaze, tense jaw";
    case Emotion.SMILE:     return "subtle smile, soft expression, gentle eyes";
    case Emotion.SMIRK:     return "(smirk:1.05), arrogant smile, looking down slightly";
    case Emotion.ANGRY:     return "glaring intensely, (heavy furrowed brows:1.05), tense facial muscles";
    case Emotion.RAGE:      return "(intense piercing glare:1.05), (gritted teeth:1.05), fierce expression, hostile";
    case Emotion.SAD:       return "somber expression, looking down slightly, melancholic, shadow over eyes";
    case Emotion.PAIN:      return "wincing slightly, (gritted teeth:1.05), enduring pain, stiff face";
    case Emotion.SURPRISED: return "(widened eyes:1.05), slightly raised eyebrows, speechless";
    case Emotion.FEAR:      return "stiff expression, wide eyes, cold sweat, shrinking pupils, anxious";
  }
}

export const getCharacterPrompt = (style, look, emotion, subjectCount) => `
[ART STYLE]
${style}

[CHARACTER Count]
${getSubjectBlock(subjectCount)}   // "Draw exactly ONE character and no more."

[CHARACTER LOOK]
${look}                            // Gemini가 추출한 Character Bible (5요소 조합)

[CHARACTER EMOTION]
${getEmotionBlock(emotion)}

[FRAMING]
${FRAMING_BLOCK}

[BACKGROUND]
${BACKGROUND_BLOCK}
`;
```

**설계 의도**: `look`은 Step 1에서 표정 없이 정의되고, `emotionBlock`이 단계별로 합성된다. 단색 흰 배경(`BACKGROUND_BLOCK`)으로 생성하여 이후 배경 제거 처리의 효율을 높인다.

감정 변형 이미지는 DEFAULT 이미지를 입력으로 받는 image-to-image 방식으로 생성한다.

```typescript
export const getCharacterEmotionPrompt = (style, look, emotion, subjectCount) => {
  return `Using the provided character image, generate a new image showing the character
          with following emotion: ${getEmotionBlock(emotion)},
          Character consistency is the top priority, allowing minimal posture change,
          but never harming the overall identity of the character, such as clothes or hairstyles,
          ${BACKGROUND_BLOCK}`;
};
```

### 7.4 생성 방식: Gemini Batch API

모든 요청을 한 번의 Batch API 호출로 제출하여 병렬 처리 효율을 높인다.

```typescript
// generateCharacterImagesBatch() — Phase 1: DEFAULT 배치
const defaultRequests = charsNeedingDefault.map(([charId, pis]) => ({
  prompt:      getCharacterPrompt(globalArtStyle, pis[0]._characterFk.look, Emotion.DEFAULT, ...),
  metadata:    { charId },      // 응답 매핑용
  aspectRatio: '9:16',
  imageSize:   '1K',
}));
const defaultResults = await this.genAI.geminiBatchGenerateImages(defaultRequests);

// 각 결과에서 metadata.charId로 어느 캐릭터의 응답인지 추적

// Phase 2: 감정 배치 (image-to-image)
const emotionRequests = pendingEmotions.map((cimg) => ({
  prompt:          getCharacterEmotionPrompt(globalArtStyle, ..., 'gemini', ...),
  initImageBuffer: defaultBufferMap.get(cimg.characterId),  // DEFAULT 이미지를 입력으로
  metadata:        { charId: cimg.characterId, emotion: cimg.emotion },
  aspectRatio:     '9:16',
  imageSize:       '1K',
}));
const emotionResults = await this.genAI.geminiBatchGenerateImages(emotionRequests);
```

내부적으로 `geminiBatchGenerateImages()`는 Gemini Batch API 잡을 제출하고 완료될 때까지 폴링한다:

```typescript
async geminiBatchGenerateImages(requests) {
  const inlinedRequests = requests.map((req) => ({
    contents: [{ text: req.prompt }, ...(req.initImageBuffer ? [{ inlineData: ... }] : [])],
    config: { responseModalities: ['IMAGE', 'TEXT'], responseFormat: { image: { aspectRatio, imageSize } } },
  }));

  const job = await this.geminiImageAI.batches.create({ model: this.geminiImageModel, src: inlinedRequests });

  // 10초 간격, 최대 720회 폴링 (최대 2시간 대기)
  const completedJob = await this.pollBatchJob(job.name);
  const responses    = completedJob.dest?.inlinedResponses ?? [];

  return responses.map((resp, i) => {
    const inlineData = resp.response.candidates[0].content.parts.find((p) => p.inlineData)?.inlineData;
    return { buffer: Buffer.from(inlineData.data, 'base64'), metadata: requests[i].metadata };
  });
}
```

### 7.5 배경 제거 (Photoroom API)

```typescript
async removeImageBackground(inputBuffer: Buffer): Promise<Buffer> {
  const form = new FormData();
  form.append('image_file', inputBuffer, { filename: 'image.png', contentType: 'image/png' });

  const response = await axios.post('https://sdk.photoroom.com/v1/segment', form, {
    headers: { ...form.getHeaders(), 'x-api-key': this.photoroomKey },
    responseType: 'arraybuffer',
  });
  return Buffer.from(response.data);
}
```

### 7.6 S3 저장 경로

| 파일 | S3 경로 |
|---|---|
| 원본 이미지 | `series/{seriesId}/characters/{charId}/{EMOTION}.png` |
| 배경 제거본 | `series/{seriesId}/characters/{charId}/{EMOTION}_NOBG.png` |

---

## 8. Step 4: 배경 이미지 생성 (BackgroundImageHandler)

### 8.1 데이터 입력

- **DB**: `Background` (status IN [PENDING, FAILED])
- **DB**: `Series.backgroundArtStyle`, `Series.backgroundStyleKey`

### 8.2 프롬프트 구성 (코드 내 인라인)

```typescript
const prompt = `(${globalBgArtStyle}:1.2), ${actualStyleKey} art style rendering, ${bg.description}, masterpiece, empty scenery, highly detailed landscape, no characters`;
```

`bg.description`은 Step 2에서 Gemini가 생성한 배경 시각 설명이며, `timeOfDay`는 포함되지 않는다 (시간대는 씬별로 다르므로 배경 자체에 고정하지 않는 설계).

### 8.3 생성 방식: Gemini Batch API

16:9 비율, 2K 해상도로 배치 처리한다.
```typescript
const bgRequests = backgrounds.map((bg) => ({
  prompt:      `(${globalBgArtStyle}:1.2), ${actualStyleKey} art style, ${bg.description}, ...`,
  metadata:    { bgId: bg.id },
  aspectRatio: '16:9',
  imageSize:   '2K',
}));
const bgResults = await this.genAI.geminiBatchGenerateImages(bgRequests);
```

### 8.4 S3 저장 경로

`series/{seriesId}/backgrounds/{bgId}.png`

---

## 9. Step 5: BGM 생성 (BgmHandler)

### 9.1 데이터 입력

- **DB**: `Bgm` (status IN [PENDING, FAILED])
- `Bgm.prompt` — Step 2에서 Gemini가 30단어 이내로 작성한 영어 음악 프롬프트

### 9.2 AI 호출 (Lyria 3 Clip)

```typescript
private async generateSingleBgm(seriesId, bgm) {
  // 루프 재생을 위한 추가 지시문 삽입
  const fullPrompt = `${bgm.prompt}, instrumental only, no vocals, no lyrics, loopable structure, seamless loop`;
  const audioBuffer = await this.genAI.lyriaGenerateClip(fullPrompt);

  await this.s3.uploadAudio(`series/${seriesId}/bgm/${bgm.id}.mp3`, audioBuffer, 'audio/mpeg');
  bgm.status = GenStatus.DONE;
}

// GenAIHelperService.lyriaGenerateClip()
async lyriaGenerateClip(prompt: string): Promise<Buffer> {
  const result = await this.lyriaAI.models.generateContent({
    model:    this.lyriaModel,   // 'lyria-3-clip-preview'
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config:   { responseModalities: ['AUDIO'] },
  });

  const inlineData = result.candidates[0].content.parts.find((p) => p.inlineData)?.inlineData;
  return Buffer.from(inlineData.data, 'base64');  // MP3 Buffer 반환
}
```

모든 BGM은 `Promise.allSettled()`로 병렬 생성한다. 일부 실패 시 실패 개수를 집계하여 에러를 throw한다.

### 9.3 S3 저장 경로

`series/{seriesId}/bgm/{bgmId}.mp3`

---

## 10. AI Agent 간 데이터 전달 흐름 전체 요약

```
┌─────────────────────────────────────────────────────────────────────────┐
│  사용자 업로드: novel.txt → S3                                            │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  [AGENT 1] Gemini 2.5 Flash — 캐릭터 파싱                                 │
│                                                                          │
│  입력:  S3 novel.txt, DB의 기존 캐릭터 목록                                │
│  처리:  LangChain PromptTemplate + StructuredOutputParser (Zod)          │
│  출력:  DB Character {name, sex, look, subjectCount}                    │
│         DB Series {characterArtStyle, characterStyleKey}                │
└─────────────────────────────────────────────────────────────────────────┘
                              │  CHARACTERS_DONE 이벤트
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  [AGENT 2] Gemini 2.5 Flash — 씬 파싱                                    │
│                                                                          │
│  입력:  S3 novel.txt                                                      │
│         DB Character {id, name, look} ← AGENT 1 출력                   │
│         DB Background/Bgm (기존 목록)                                    │
│  처리:  tempId 패턴으로 신규 에셋 선언 → 실제 UUID로 치환                    │
│  출력:  DB Background {name, description, status=PENDING}               │
│         DB Bgm {category, prompt, status=PENDING}                       │
│         DB CharacterImg placeholder {characterId, emotion, PENDING}     │
│         S3 scenes.json {scenes: [...dialogues, currentScreen]}          │
│         DB Series {backgroundArtStyle, backgroundStyleKey}              │
└─────────────────────────────────────────────────────────────────────────┘
                              │  SCENES_DONE 이벤트 (3개 핸들러 동시 구독)
              ┌───────────────┼────────────────────────────┐
              ▼               ▼                            ▼
┌──────────────────┐ ┌──────────────────┐      ┌──────────────────────┐
│  [AGENT 3]       │ │  [AGENT 4]       │      │  [AGENT 5]           │
│  Gemini Image    │ │  Gemini Image    │      │  Lyria 3 Clip        │
│  캐릭터 이미지 생성  │ │  배경 이미지 생성  │      │  BGM 생성             │
│                  │ │                  │      │                      │
│  입력:            │ │  입력:            │      │  입력:               │
│  DB CharacterImg │ │  DB Background   │      │  DB Bgm.prompt       │
│  DB Character    │ │  DB Series.style │      │                      │
│  DB Series.style │ │                  │      │  처리:               │
│                  │ │  처리:            │      │  prompt += "loop"    │
│  처리:            │ │  Batch API       │      │  generateContent()   │
│  DEFAULT 먼저     │ │  16:9 2K         │      │                      │
│  감정 image-to-   │ │                  │      │  출력:               │
│  image 변환       │ │  출력:            │      │  S3 bgm/{id}.mp3    │
│  Photoroom NOBG  │ │  S3 bg/{id}.png  │      │  DB Bgm.status=DONE  │
│                  │ │  DB Bg.status    │      └──────────────────────┘
│  출력:            │ │  =DONE           │
│  S3 char/{emotion}│ └──────────────────┘
│  .png + _NOBG.png│
│  DB CharImg.DONE │
└──────────────────┘
              │               │                            │
              └───────────────┴────────────────────────────┘
                                      │
                              모든 스텝 DONE → Episode.status = DONE
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  [소비] EpisodeService.getVnScript()                                     │
│                                                                          │
│  입력:  S3 scenes.json                                                   │
│         DB Character + CharacterImg (sprites 맵 구성)                   │
│         DB Background (sceneMap 구성)                                    │
│         DB Bgm (bgmMap 구성)                                             │
│                                                                          │
│  출력:  {                                                                 │
│    characters: { [charId]: { name, sprites: { [emotion]: S3_URL } } },  │
│    scenes:     { [bgId]: S3_URL },                                       │
│    bgm:        { [bgmId]: S3_URL },                                      │
│    script: [                                                             │
│      "play bgm {bgmId}",                                                │
│      "show scene {bgId} with fade",                                      │
│      "show character {charId} SERIOUS left",                            │
│      { "캐릭터명": "대사 내용" },                                          │
│      "hide character {charId}",                                          │
│      ...                                                                 │
│      "stop bgm", "end"                                                  │
│    ]                                                                     │
│  }                                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 11. VN Script 생성 (최종 출력 단계)

### 11.1 buildVnScript() 로직

`EpisodeService.buildVnScript()`는 `scenes.json`의 `currentScreen` 배열을 이전 프레임과 비교하여 diff 기반으로 캐릭터 등장/퇴장/이동/감정 변화 명령을 생성한다.

```typescript
private buildVnScript(scenes, characterMap) {
  const script = [];
  let currentBgmId = null;

  for (const scene of scenes) {
    if (scene.bgmId !== currentBgmId) {
      script.push(`play bgm ${scene.bgmId}`);
      currentBgmId = scene.bgmId;
    }
    script.push(`show scene ${scene.backgroundId} with fade`);

    let prevScreen = new Map(); // charId → { position, emotion }

    for (const dialogue of scene.dialogues) {
      const nextScreen = new Map(currentScreen.map((e) => [e.characterId, { position: e.position, emotion: e.emotion }]));

      // 이전 화면에 있었으나 현재 없는 캐릭터 → hide
      for (const [charId] of prevScreen) {
        if (!nextScreen.has(charId)) script.push(`hide character ${charId}`);
      }

      // 신규 등장하거나 위치/감정이 변한 캐릭터 → show
      for (const [charId, { position, emotion }] of nextScreen) {
        const prev = prevScreen.get(charId);
        if (!prev || prev.position !== position || prev.emotion !== emotion) {
          script.push(`show character ${charId} ${emotion} ${position}`);
        }
      }

      prevScreen = nextScreen;

      // 대사 출력
      if (characterId === 'narrator') {
        script.push(dialog);
      } else {
        script.push({ [characterMap[characterId].name]: dialog });
      }
    }
  }

  script.push('stop bgm');
  script.push('end');
  return script;
}
```

### 11.2 스프라이트 폴백 처리

특정 감정의 이미지가 생성 실패한 경우 DEFAULT 이미지로 대체한다.

```typescript
const defaultUrl = sprites[Emotion.DEFAULT];
if (defaultUrl) {
  for (const img of images) {
    if (!sprites[img.emotion]) sprites[img.emotion] = defaultUrl;
  }
}
```

---

## 12. 공통 인프라 서비스

### 12.1 S3HelperService

모든 AI Agent가 데이터 교환의 중간 저장소로 S3를 활용한다. 모든 오브젝트는 AES256으로 서버 측 암호화된다.

```
series/{seriesId}/
  episodes/{episodeId}/
    novel.txt           ← 입력 (사용자 업로드)
    scenes.json         ← AGENT 2 출력 / VN Script 입력
  characters/{charId}/
    {EMOTION}.png       ← AGENT 3 출력 (원본)
    {EMOTION}_NOBG.png  ← AGENT 3 출력 (배경 제거본, 프론트엔드 실제 사용)
  backgrounds/{bgId}.png ← AGENT 4 출력
  bgm/{bgmId}.mp3        ← AGENT 5 출력
```

### 12.2 RepositoryProvider

전체 파이프라인에서 사용하는 TypeORM 레포지토리를 단일 DI 토큰으로 제공하는 중앙화 Provider. 모든 서비스는 `RepositoryProvider`를 주입받아 `repo.character`, `repo.characterImg` 등으로 접근한다.

### 12.3 GenStatus 상태 머신

모든 생성 대상 엔티티(`Background`, `Bgm`, `CharacterImg`)는 동일한 상태 머신을 따른다.

```
PENDING → PROCESSING → DONE
   ↑            └───→ FAILED
   └──────────────────── (재처리 시 PENDING 유지 또는 FAILED에서 재실행)
```

---

## 13. 설계 결정 사항 및 특이점

**tempId 패턴**: Gemini LLM이 단일 호출 내에서 신규 에셋을 선언하고 동시에 씬에서 참조할 수 있도록 설계된 패턴. LLM 응답의 자기 참조(self-reference) 문제를 해결한다.

**감정 분리 원칙**: `Character.look`에는 표정 정보를 절대 포함하지 않는다. 이를 통해 하나의 Character Bible로 10가지 감정 이미지를 생성할 수 있다.

**DEFAULT-first 전략**: 캐릭터 이미지 생성 시 DEFAULT 감정을 먼저 완성한 후, 이를 image-to-image 입력으로 삼아 나머지 감정을 생성한다. 이는 감정 변형 시 캐릭터 정체성(의상, 헤어스타일)의 일관성을 유지하기 위한 핵심 전략이다.

**이벤트 기반 병렬화**: `SCENES_DONE` 이벤트를 3개 핸들러가 구독함으로써 캐릭터 이미지, 배경 이미지, BGM을 순서 의존성 없이 동시에 처리한다.

**멱등성 보장**: 각 생성 단계는 PENDING/FAILED 상태만 처리하므로 파이프라인 재실행 시 완료된 항목을 건너뛰고 실패한 항목만 재처리한다.

**currentScreen diff 방식**: VN Script 생성 시 전체 화면 상태를 매 대화마다 기록하고, 이전 프레임과의 diff로 최소한의 명령만 생성한다. 불필요한 `show`/`hide` 명령을 줄여 프론트엔드 처리를 최적화한다.
