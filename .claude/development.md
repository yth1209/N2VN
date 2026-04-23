# N2VN 상세 개발 기획서 — BGM 파이프라인 & 배경 이미지 최적화

> **작성 기준:** plan.md (2026-04-23) 반영  
> **선행 문서:** [plan.md](./plan.md) · [structure.md](./structure.md)  
> **코드 컨벤션:** [conventions.md](./conventions.md)

---

## 0. 변경 범위 요약

| 파일 | 변경 종류 | 핵심 내용 |
|---|---|---|
| `entities/bgm.entity.ts` | **신규** | BGM 테이블 엔티티 |
| `entities/episode-pipeline-step.entity.ts` | **수정** | StepKey enum 재정의 (5단계) |
| `common/gen-ai-helper.service.ts` | **신규** | Gemini·Leonardo·Lyria API 통합 헬퍼 |
| `common/repository.provider.ts` | **수정** | `bgm` Repository 추가 |
| `common/constants.ts` | **수정** | `BgmCategory` enum 추가 |
| `bgm/bgm.service.ts` | **신규** | Lyria 3 Clip 파이프라인 서비스 |
| `bgm/bgm.module.ts` | **신규** | BGM 모듈 |
| `parsing/parsing.service.ts` | **수정** | `parseScenesForEpisode` 전면 개편, GenAIHelperService 사용 |
| `parsing/prompt/prompt.ts` | **수정** | scene_prompt 교체 (BGM + 배경 통합) |
| `image/image.service.ts` | **수정** | `generateBackgroundImagesForSeries` 추가, GenAIHelperService 사용 |
| `episode/episode-pipeline.service.ts` | **수정** | STEP_ORDER 5단계로 변경, GENERATE_BGM 단계 추가 |
| `episode/episode.service.ts` | **수정** | `getVnScript`: BGM map 추가, `buildVnScript`: `play bgm` 명령 추가 |
| `app.module.ts` | **수정** | BgmModule 등록, Bgm Entity 등록 |
| `frontend/player.js` | **수정** | BGM 재생·페이드·토글 로직 |
| `frontend/player.html` | **수정** | 사운드 토글 버튼 UI |

---

## 1. DB 엔티티

### 1.1 `bgm.entity.ts` (신규)

```typescript
// backend/src/entities/bgm.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Series } from './series.entity';
import { BgmCategory } from '../common/constants';

@Entity('bgm')
export class Bgm {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  seriesId: string;

  @ManyToOne(() => Series, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'seriesId' })
  series: Series;

  @Column({ type: 'enum', enum: BgmCategory })
  category: BgmCategory;

  @Column({ type: 'text' })
  prompt: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  genId: string | null;        // Lyria 생성 완료 여부 플래그 (null = 미생성)
  // S3 경로는 코드에서 조합: series/{seriesId}/bgm/{id}.mp3
}
```

**DDL:**
```sql
CREATE TABLE bgm (
  id         VARCHAR(36)  NOT NULL PRIMARY KEY,
  seriesId   VARCHAR(36)  NOT NULL,
  category   ENUM('ACTION','ROMANCE','MYSTERY','PEACEFUL','SAD','EPIC','DARK') NOT NULL,
  prompt     TEXT         NOT NULL,
  genId      VARCHAR(255) NULL,
  CONSTRAINT fk_bgm_series FOREIGN KEY (seriesId) REFERENCES series(id) ON DELETE CASCADE
);
```

---

### 1.2 `constants.ts` — `BgmCategory` enum 추가

```typescript
// backend/src/common/constants.ts (기존 Emotion·StyleKey 아래에 추가)

export enum BgmCategory {
  ACTION   = 'ACTION',
  ROMANCE  = 'ROMANCE',
  MYSTERY  = 'MYSTERY',
  PEACEFUL = 'PEACEFUL',
  SAD      = 'SAD',
  EPIC     = 'EPIC',
  DARK     = 'DARK',
}
```

---

### 1.3 `episode-pipeline-step.entity.ts` — StepKey 재정의

`PARSE_BACKGROUNDS` 제거 (씬 파싱에 흡수) + `GENERATE_BGM` 신규 추가. 최종 5단계.

```typescript
// 변경 전
export enum StepKey {
  PARSE_CHARACTERS           = 'parseCharacters',
  PARSE_BACKGROUNDS          = 'parseBackgrounds',        // 제거
  PARSE_SCENES               = 'parseScenes',
  GENERATE_CHARACTER_IMAGES  = 'generateCharacterImages',
  GENERATE_BACKGROUND_IMAGES = 'generateBackgroundImages',
}

export const STEP_ORDER: StepKey[] = [
  StepKey.PARSE_CHARACTERS,
  StepKey.PARSE_BACKGROUNDS,
  StepKey.PARSE_SCENES,
  StepKey.GENERATE_CHARACTER_IMAGES,
  StepKey.GENERATE_BACKGROUND_IMAGES,
];
```

```typescript
// 변경 후
export enum StepKey {
  PARSE_CHARACTERS           = 'parseCharacters',
  PARSE_SCENES               = 'parseScenes',             // 배경·BGM DB 적재 포함
  GENERATE_CHARACTER_IMAGES  = 'generateCharacterImages',
  GENERATE_BACKGROUND_IMAGES = 'generateBackgroundImages', // 유지 (명시적 순차 실행)
  GENERATE_BGM               = 'generateBgm',             // 신규
}

export const STEP_ORDER: StepKey[] = [
  StepKey.PARSE_CHARACTERS,
  StepKey.PARSE_SCENES,
  StepKey.GENERATE_CHARACTER_IMAGES,
  StepKey.GENERATE_BACKGROUND_IMAGES,
  StepKey.GENERATE_BGM,
];
```

> **주의:** MariaDB ENUM 컬럼은 ALTER 없이 값 추가·제거가 안 된다. 운영 환경에서는 아래 마이그레이션을 사용한다.
> 
> ```sql
> -- 기존 PARSE_BACKGROUNDS 스텝 행 삭제
> DELETE FROM episode_pipeline_step WHERE stepKey = 'parseBackgrounds';
> 
> -- ENUM 컬럼 재정의 (parseBackgrounds 제거, generateBgm 추가)
> ALTER TABLE episode_pipeline_step
>   MODIFY COLUMN stepKey ENUM('parseCharacters','parseScenes','generateCharacterImages','generateBackgroundImages','generateBgm') NOT NULL;
> ```

---

## 2. RepositoryProvider 변경

```typescript
// backend/src/common/repository.provider.ts
import { Bgm } from '../entities/bgm.entity';

@Injectable()
export class RepositoryProvider {
  constructor(
    @InjectRepository(User)                public readonly user:         Repository<User>,
    @InjectRepository(Series)              public readonly series:       Repository<Series>,
    @InjectRepository(Episode)             public readonly episode:      Repository<Episode>,
    @InjectRepository(EpisodePipelineStep) public readonly pipelineStep: Repository<EpisodePipelineStep>,
    @InjectRepository(Character)           public readonly character:    Repository<Character>,
    @InjectRepository(CharacterImg)        public readonly characterImg: Repository<CharacterImg>,
    @InjectRepository(Background)          public readonly background:   Repository<Background>,
    @InjectRepository(Bgm)                 public readonly bgm:          Repository<Bgm>, // 추가
  ) {}
}
```

`CommonModule`의 `TypeOrmModule.forFeature([...])` 배열에 `Bgm` 추가.

---

## 3. BgmService (신규)

```
backend/src/bgm/
├── bgm.module.ts
└── bgm.service.ts
```

### 3.0 서비스 선정: Google Lyria 3 Clip

| | Mubert | **Lyria 3 Clip** | Lyria 3 Pro |
|---|---|---|---|
| **비용** | $49/월 고정 | **$0.04/클립** | $0.08/트랙 |
| **에피소드당** (BGM 7개) | $49 | **$0.28** | $0.56 |
| **생성 길이** | 최대 25분 | **30초** | 풀 송 (~수 분) |
| **루프 최적화** | 네이티브 루프 | **루프·클립 특화** | ✗ (벌스/코러스 구조) |
| **VN BGM 적합성** | ✓ | **✓** | ✗ (노래 제작용) |
| **기존 API 키 재사용** | ✗ | **✓ (GEMINI_API_KEY)** | ✓ (GEMINI_API_KEY) |

**선정: Lyria 3 Clip** — "짧은 음악 클립·루프·미리보기"에 명시 최적화. 에피소드당 $0.28, 기존 GEMINI_API_KEY 재사용. 30초 클립을 프론트엔드 `<audio loop>`로 반복 재생.

`.env` 추가:
```
# Mubert 키 불필요 — 기존 GEMINI_API_KEY 사용
LYRIA_MODEL=lyria-3-clip-preview
```

`package.json` 의존성 추가:
```
@google/generative-ai
```

---

### 3.1 Lyria 3 Clip API 구조

`@google/generative-ai` SDK의 `generateContent()`를 사용한다. `responseModalities: ['AUDIO']`를 지정하면 응답 `inlineData`에 base64 MP3가 반환된다.

---

### 3.2 `bgm.service.ts`

```typescript
// backend/src/bgm/bgm.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { RepositoryProvider } from '../common/repository.provider';
import { S3HelperService } from '../common/s3-helper.service';
import { GenAIHelperService } from '../common/gen-ai-helper.service';
import { Bgm } from '../entities/bgm.entity';

@Injectable()
export class BgmService {
  private readonly logger = new Logger(BgmService.name);

  constructor(
    private readonly repo: RepositoryProvider,
    private readonly s3: S3HelperService,
    private readonly genAI: GenAIHelperService,
  ) {}

  /**
   * seriesId에 속한 미생성 BGM(genId = null) 전체에 대해 Lyria 3 Clip 음원 생성 후 S3 업로드.
   * EpisodePipelineService의 GENERATE_BGM 단계에서 호출.
   */
  async generateBgmForSeries(seriesId: string): Promise<void> {
    const bgms = await this.repo.bgm.find({ where: { seriesId, genId: IsNull() } });

    if (!bgms.length) {
      this.logger.log(`[${seriesId}] 생성할 BGM 없음 (모두 완료됨)`);
      return;
    }

    await Promise.all(
      bgms.map((bgm) =>
        this.generateSingleBgm(seriesId, bgm).catch((err) =>
          this.logger.error(`[BGM ${bgm.id}] 생성 실패: ${err.message}`),
        ),
      ),
    );
    this.logger.log(`[${seriesId}] BGM 생성 완료: ${bgms.length}개`);
  }

  private async generateSingleBgm(seriesId: string, bgm: Bgm): Promise<void> {
    const fullPrompt =
      `${bgm.prompt}, instrumental only, no vocals, no lyrics, ` +
      `loopable structure, visual novel background music, ` +
      `fade in at start, clean loop tail`;

    const audioBuffer = await this.genAI.lyriaGenerateClip(fullPrompt);
    const s3Key       = `series/${seriesId}/bgm/${bgm.id}.mp3`;

    await this.s3.uploadAudio(s3Key, audioBuffer, 'audio/mpeg');

    bgm.genId = bgm.id;
    await this.repo.bgm.save(bgm);

    this.logger.log(`[BGM ${bgm.id}] S3 업로드 완료: ${s3Key}`);
  }
}

> **비용 참고:** Lyria 3 Clip은 클립당 $0.04 과금. 에피소드 1개에 BGM 7개 생성 시 약 $0.28.  
> 실패 후 재시도 시 추가 과금 발생하므로, `catch`에서 로그만 남기고 재시도하지 않는다.

### 3.3 `S3HelperService`에 `uploadAudio` 추가

```typescript
// backend/src/common/s3-helper.service.ts
async uploadAudio(key: string, buffer: Buffer, mime: string): Promise<void> {
  const command = new PutObjectCommand({
    Bucket:               this.bucket,
    Key:                  key,
    Body:                 buffer,
    ContentType:          mime,
    ServerSideEncryption: 'AES256',
  });
  await this.s3Client.send(command);
}
```

---

## 4. 시리즈 스타일 고정 정책

`characterArtStyle`, `characterStyleKey`, `backgroundArtStyle`, `backgroundStyleKey`는 **시리즈 전체에 걸쳐 일관성을 유지해야 하는 값**이다. 회차가 추가되더라도 최초 파싱 시 확정된 스타일이 교체되면 안 된다.

### 정책

- `parseCharactersForEpisode`: LLM 결과의 `globalArtStyle` / `styleKey`는 `series.characterArtStyle`이 **null인 경우에만** 저장.
- `parseScenesForEpisode` (parseBackgrounds 흡수 후): LLM 결과의 `globalBackgroundArtStyle` / `styleKey`는 `series.backgroundArtStyle`이 **null인 경우에만** 저장.
- 이미 값이 존재하면 LLM이 다른 스타일을 반환하더라도 **무조건 무시**한다.

### 코드 패턴

```typescript
// 기존 값이 없을 때만 최초 1회 저장
if (!series.characterArtStyle) {
  series.characterArtStyle = result.globalArtStyle;
  series.characterStyleKey = result.styleKey;
  await this.repo.series.save(series);
}
```

> **참고**: LLM은 이미 스타일이 설정된 경우에도 계속 `globalArtStyle` / `styleKey`를 반환하지만, 결과값은 버린다. 프롬프트 최적화(스타일이 이미 있을 때 해당 필드를 요청하지 않음)는 추후 개선 과제로 남긴다.

---

## 5. 씬 파싱 전면 개편 (`parsing.service.ts`)

### 4.1 새 Zod 스키마

씬 파싱 결과에서 `bgm_prompt` 제거. 배경/BGM을 기존 ID 재사용 or 임시 ID로 출력.

```typescript
// parseScenesForEpisode 내부 sceneSchema 교체
const sceneSchema = z.object({
  // 배경 스타일 (기존 parseBackgrounds에서 설정하던 값 — series에 미설정 시 저장)
  globalBackgroundArtStyle: z.string().describe(
    '이 소설의 모든 배경 이미지 생성에 공통 적용될 화풍·분위기 영어 키워드',
  ),
  backgroundStyleKey: z.nativeEnum(StyleKey).describe(
    '배경 렌더링 필터 스타일',
  ),

  // LLM이 결정한 신규 배경 목록 (씬 배정 전 선언)
  newBackgrounds: z.array(z.object({
    tempId:      z.string().describe('new_bg_{n} 형식의 임시 ID'),
    name:        z.string().describe('배경 명칭'),
    description: z.string().describe('시각적 특징·분위기 영문 줄글 (시간대 제외)'),
  })).describe('기존 배경 목록에 없어 새로 생성해야 하는 배경들'),

  // LLM이 결정한 신규 BGM 목록 (씬 배정 전 선언)
  newBgms: z.array(z.object({
    tempId:   z.string().describe('new_bgm_{n} 형식의 임시 ID'),
    category: z.nativeEnum(BgmCategory).describe('BGM 감정 카테고리'),
    prompt:   z.string().describe('Lyria 3 Clip 생성용 영어 텍스트 프롬프트 (30단어 이내)'),
  })).describe('기존 BGM 목록에 없어 새로 생성해야 하는 BGM들'),

  // 씬 배열
  scenes: z.array(z.object({
    backgroundId: z.string().describe(
      '이 씬의 배경 ID. 기존 배경이면 그대로, 신규면 newBackgrounds 선언 후 동일 tempId 사용',
    ),
    bgmId: z.string().describe(
      '이 씬의 BGM ID. 기존 BGM이면 그대로, 신규면 newBgms 선언 후 동일 tempId 사용',
    ),
    timeOfDay: z.string().describe('씬이 일어나는 시간대 (예: Morning, Night, Dusk)'),
    dialogues: z.array(z.object({
      characterId: z.string(),
      dialog:      z.string(),
      action:      z.enum(['IDLE', 'ATTACK', 'SHAKE']),
      emotion:     z.nativeEnum(Emotion),
      look:        z.string(),
      isEntry:     z.boolean(),
      isExit:      z.boolean(),
      position:    z.enum(['left', 'center', 'right']),
    })),
  })),
});
```

### 4.2 LLM 프롬프트에 추가되는 입력 변수

```typescript
// prompt.ts의 scene_prompt 입력 변수에 추가
inputVariables: [
  'novel_text',
  'characters_info',
  'existing_backgrounds',  // 기존 배경 목록 (id + name + description)
  'existing_bgms',         // 기존 BGM 목록 (id + category + prompt)
],
```

`existing_backgrounds` 구성:
```typescript
const dbBackgrounds = await this.repo.background.find({ where: { seriesId } });
const existingBgStr = dbBackgrounds.length
  ? dbBackgrounds.map((b) => `- ID: ${b.id}, Name: ${b.name}, Description: ${b.description}`).join('\n')
  : '(없음)';
```

`existing_bgms` 구성:
```typescript
const dbBgms = await this.repo.bgm.find({ where: { seriesId } });
const existingBgmStr = dbBgms.length
  ? dbBgms.map((b) => `- ID: ${b.id}, Category: ${b.category}, Prompt: ${b.prompt}`).join('\n')
  : '(없음)';
```

### 4.3 `parseScenesForEpisode` 후처리 로직

```typescript
async parseScenesForEpisode(seriesId: string, episodeNumber: number): Promise<void> {
  // ... (series 조회, novelText 읽기, LLM 호출 생략)

  // === 1. 배경 DB 적재 + ID 맵 구성 ===
  const bgTempToRealId = new Map<string, string>();

  for (const nb of result.newBackgrounds) {
    const entity = this.repo.background.create({
      seriesId,
      name:        nb.name,
      description: nb.description,
    });
    const saved = await this.repo.background.save(entity);
    bgTempToRealId.set(nb.tempId, saved.id);  // "new_bg_1" → "uuid-xxxx"
  }

  // === 2. BGM DB 적재 + ID 맵 구성 ===
  const bgmTempToRealId = new Map<string, string>();

  for (const nb of result.newBgms) {
    const entity = this.repo.bgm.create({
      seriesId,
      category: nb.category,
      prompt:   nb.prompt,
    });
    const saved = await this.repo.bgm.save(entity);
    bgmTempToRealId.set(nb.tempId, saved.id);  // "new_bgm_1" → "uuid-yyyy"
  }

  // === 3. series 배경 스타일 갱신 (미설정 시에만) ===
  if (!series.backgroundArtStyle) {
    series.backgroundArtStyle = result.globalBackgroundArtStyle;
    series.backgroundStyleKey = result.backgroundStyleKey;
    await this.repo.series.save(series);
  }

  // === 4. scenes의 임시 ID를 실제 UUID로 치환 ===
  const resolvedScenes = result.scenes.map((scene) => ({
    ...scene,
    backgroundId: bgTempToRealId.get(scene.backgroundId) ?? scene.backgroundId,
    bgmId:        bgmTempToRealId.get(scene.bgmId)        ?? scene.bgmId,
  }));

  // === 5. character_img 플레이스홀더 생성 (기존 로직 유지) ===
  const emotionMap = new Map<string, Set<Emotion>>();
  for (const scene of resolvedScenes) {
    for (const dialogue of scene.dialogues) {
      const charId = dialogue.characterId;
      if (charId && charId !== 'narrator' && charId !== 'unknown') {
        if (!emotionMap.has(charId)) emotionMap.set(charId, new Set([Emotion.DEFAULT]));
        emotionMap.get(charId)!.add(dialogue.emotion as Emotion);
      }
    }
  }
  for (const [charId, emotions] of emotionMap.entries()) {
    for (const emotion of emotions) {
      const exists = await this.repo.characterImg.findOne({ where: { characterId: charId, emotion } });
      if (!exists) {
        await this.repo.characterImg.save(
          this.repo.characterImg.create({ characterId: charId, emotion, genId: null, nobgGenId: null }),
        );
      }
    }
  }

  // === 6. scenes.json S3 저장 ===
  await this.s3HelperService.uploadJson(
    `series/${seriesId}/episodes/${episodeNumber}/scenes.json`,
    { scenes: resolvedScenes },
  );

  this.logger.log(`[${seriesId}/ep${episodeNumber}] 씬 파싱 완료`);
}
```

> **의존성 주입:** `ParsingService`에 `ImageService`와 `BgmService`를 주입. 순환 참조를 피하기 위해 `forwardRef`가 필요할 수 있으므로 모듈 구성 시 확인.

---

## 6. ImageService — `generateBackgroundImagesForNew` 추가

기존 `generateBackgroundImages`를 `seriesId`의 미생성 배경(`genId = null`)만 처리하도록 변경한다. EpisodePipelineService의 GENERATE_BACKGROUND_IMAGES 단계에서 호출.

```typescript
// backend/src/image/image.service.ts
async generateBackgroundImagesForSeries(seriesId: string): Promise<void> {
  const series = await this.repo.series.findOne({ where: { id: seriesId } });
  if (!series) throw new Error('Series not found');

  const backgrounds = await this.repo.background.find({ where: { seriesId, genId: IsNull() } });
  if (!backgrounds.length) {
    this.logger.log(`[${seriesId}] 생성할 배경 이미지 없음 (모두 완료됨)`);
    return;
  }

  const globalBgArtStyle  = series.backgroundArtStyle ?? '';
  const actualStyleKey    = series.backgroundStyleKey  ?? 'DYNAMIC';
  const selectedStyleUUID = STYLE_UUIDS[actualStyleKey.toUpperCase()] ?? STYLE_UUIDS['DYNAMIC'];

  this.logger.log(`[${seriesId}] 신규 배경 이미지 생성: ${backgrounds.length}개`);

  await Promise.all(
    backgrounds.map(async (bg) => {
      try {
        const prompt = `(${globalBgArtStyle}:1.2), ${actualStyleKey} art style rendering, ${bg.description}, masterpiece, empty scenery, highly detailed landscape, no characters`;
        const { buffer, imageId } = await this.generateImageToBuffer(
          prompt, undefined, selectedStyleUUID, 1280, 720,
        );
        await this.s3HelperService.uploadImage(
          `series/${seriesId}/backgrounds/${bg.id}.png`, buffer, 'image/png',
        );
        bg.genId = imageId;
        await this.repo.background.save(bg);
        this.logger.log(`[${bg.id}] 배경 이미지 완료`);
      } catch (err: any) {
        this.logger.error(`[${bg.id}] 배경 이미지 실패: ${err.message}`);
      }
    }),
  );
}
```

> 기존 `generateBackgroundImages(seriesId)` 메서드는 수동 전체 재생성 용도로 유지.

---

## 7. EpisodePipelineService — 5단계 순차 실행

```typescript
// backend/src/episode/episode-pipeline.service.ts
const steps: Array<{ key: StepKey; fn: () => Promise<void> }> = [
  {
    key: StepKey.PARSE_CHARACTERS,
    fn:  () => this.parsingService.parseCharactersForEpisode(seriesId, episodeNumber),
  },
  {
    key: StepKey.PARSE_SCENES,
    fn:  () => this.parsingService.parseScenesForEpisode(seriesId, episodeNumber),
    // 배경·BGM DB 적재 포함. 이미지·음원 생성은 하지 않음
  },
  {
    key: StepKey.GENERATE_CHARACTER_IMAGES,
    fn:  () => this.imageService.generateCharacterImages(seriesId),
  },
  {
    key: StepKey.GENERATE_BACKGROUND_IMAGES,
    fn:  () => this.imageService.generateBackgroundImagesForSeries(seriesId),
  },
  {
    key: StepKey.GENERATE_BGM,
    fn:  () => this.bgmService.generateBgmForSeries(seriesId),
  },
];
```

> **에피소드 완료 시점:** 모든 5단계가 순차 완료 = DONE. 각 단계는 StepKey로 상태 추적 가능하며, 실패한 단계만 재실행 가능.

---

## 8. EpisodeService — `getVnScript` & `buildVnScript` 수정

### 7.1 BGM URL 맵 추가

```typescript
async getVnScript(seriesId: string, episodeNumber: number) {
  // ... (기존 로직 유지)

  // BGM 맵 추가
  const bgmList  = await this.repo.bgm.find({ where: { seriesId } });
  const baseUrl  = this.getBaseUrl();

  const bgmMap: Record<string, string | null> = {};
  for (const bgm of bgmList) {
    bgmMap[bgm.id] = bgm.genId
      ? `${baseUrl}/series/${seriesId}/bgm/${bgm.id}.mp3`
      : null;
  }

  const script = this.buildVnScript(scenesData.scenes, characterMap);

  // 기존 반환 구조에 bgm 추가
  return {
    characters: characterMap,
    scenes:     sceneMap,
    bgm:        bgmMap,       // 신규 필드
    script,
  };
}
```

**응답 구조 예시:**
```json
{
  "success": true,
  "data": {
    "characters": { ... },
    "scenes": { "uuid-bg-1": "https://.../backgrounds/uuid-bg-1.png" },
    "bgm": {
      "uuid-bgm-1": "https://.../bgm/uuid-bgm-1.mp3",
      "uuid-bgm-2": null
    },
    "script": [
      "play bgm uuid-bgm-1",
      "show scene uuid-bg-1 with fade",
      ...
    ]
  }
}
```

### 7.2 `buildVnScript` — `play bgm` 명령 추가

```typescript
private buildVnScript(
  scenes: any[],
  characterMap: VnCharacterMap,
): (string | Record<string, string>)[] {
  const script: (string | Record<string, string>)[] = [];
  let currentBgmId: string | null = null;   // 이전 씬의 bgmId 추적

  for (const scene of scenes) {
    // bgmId가 변경된 경우에만 play bgm 명령 삽입
    if (scene.bgmId && scene.bgmId !== currentBgmId) {
      script.push(`play bgm ${scene.bgmId}`);
      currentBgmId = scene.bgmId;
    }

    script.push(`show scene ${scene.backgroundId} with fade`);
    // ... (기존 dialogue 처리 로직 그대로 유지)
  }

  script.push('end');
  return script;
}
```

---

## 9. 프론트엔드 — `player.html` & `player.js`

### 9.1 `player.html` — 사운드 토글 버튼 추가

```html
<!-- player.html — VN 플레이어 컨테이너 내부 (기존 #player-container 안) -->
<div id="player-container" style="position: relative; ...">
  <!-- 기존 배경, 캐릭터, 대사창 등 -->

  <!-- 사운드 토글 버튼 -->
  <button id="sound-toggle-btn"
          style="position: absolute; top: 12px; right: 12px;
                 background: rgba(0,0,0,0.5); border: none; border-radius: 50%;
                 width: 40px; height: 40px; cursor: pointer;
                 font-size: 20px; color: white; z-index: 100;">
    🔊
  </button>
</div>
```

### 9.2 `player.js` — BGM 재생 로직

**1) 상태 변수 추가**

```javascript
// player.js — 상태 변수 섹션 상단
let bgmMap     = {};          // { bgmId: url | null }
let bgmAudio   = new Audio(); // 단일 Audio 인스턴스 재사용
let isMuted    = false;
let currentBgmId = null;

const FADE_DURATION_MS  = 1000;  // 1초 페이드
const FADE_STEP_MS      = 50;    // 50ms 간격
const FADE_STEPS        = FADE_DURATION_MS / FADE_STEP_MS;
```

**2) 초기화 — localStorage 음소거 상태 복원**

```javascript
// loadNovel() 호출 직전에 실행
function initSoundState() {
  isMuted = localStorage.getItem('n2vn_muted') === 'true';
  document.getElementById('sound-toggle-btn').textContent = isMuted ? '🔇' : '🔊';
  bgmAudio.muted = isMuted;
}
```

**3) 사운드 토글 이벤트**

```javascript
document.getElementById('sound-toggle-btn').addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('n2vn_muted', String(isMuted));
  document.getElementById('sound-toggle-btn').textContent = isMuted ? '🔇' : '🔊';
  bgmAudio.muted = isMuted;
});
```

**4) `executeCommand` — `play bgm` 처리**

```javascript
// executeCommand(cmd) 내부 string 분기에 추가
if (typeof cmd === 'string') {
  if (cmd.startsWith('play bgm ')) {
    const bgmId = cmd.replace('play bgm ', '').trim();
    await playBgm(bgmId);
    return; // shouldPause = false → 즉시 다음 명령으로
  }
  // ... 기존 show scene / show character / hide character 처리
  if (cmd === 'end') {
    await fadeBgm(0);
    bgmAudio.pause();
    currentBgmId = null;
  }
}
```

**5) `playBgm` 함수**

```javascript
async function playBgm(bgmId) {
  if (bgmId === currentBgmId) return; // 동일 BGM → 중단 없이 계속

  const url = bgmMap[bgmId];

  // 현재 재생 중이면 페이드아웃
  if (!bgmAudio.paused) {
    await fadeBgm(0);
    bgmAudio.pause();
  }

  if (!url) {
    // BGM 파일 미생성(null) → 무음으로 계속
    currentBgmId = bgmId;
    return;
  }

  currentBgmId   = bgmId;
  bgmAudio.src   = url;
  bgmAudio.loop  = true;
  bgmAudio.volume = 0;
  bgmAudio.muted  = isMuted;
  bgmAudio.play().catch(() => {}); // 브라우저 autoplay 정책 무시
  await fadeBgm(0.6); // 목표 볼륨 0.6
}
```

**6) `fadeBgm` 유틸**

```javascript
function fadeBgm(targetVolume) {
  return new Promise((resolve) => {
    const startVolume = bgmAudio.volume;
    const delta       = (targetVolume - startVolume) / FADE_STEPS;
    let   step        = 0;

    const interval = setInterval(() => {
      step++;
      bgmAudio.volume = Math.min(1, Math.max(0, startVolume + delta * step));
      if (step >= FADE_STEPS) {
        bgmAudio.volume = targetVolume;
        clearInterval(interval);
        resolve();
      }
    }, FADE_STEP_MS);
  });
}
```

**7) `loadNovel` — bgmMap 수신**

```javascript
async function loadNovel(novelId) {
  const res  = await fetch(`/series/${currentSeriesId}/episodes/${episodeNumber}/vn-script`);
  const data = await res.json();

  bgmMap = data.data.bgm ?? {};
  // ... 기존 characters, scenes, script 처리
  initSoundState();
}
```

---

## 10. scene_prompt 개편 (`parsing/prompt/prompt.ts`)

기존 `scene_prompt`에서 `backgrounds_info` 변수를 `existing_backgrounds`로 교체하고, BGM 관련 지시사항 추가.

**추가 입력 섹션:**
```
## 기존 배경 목록 (재사용 가능)
{existing_backgrounds}

## 기존 BGM 목록 (재사용 가능)
{existing_bgms}
```

**LLM 지시사항 핵심 추가 항목:**
```
[배경 처리 규칙]
- 씬의 장소가 existing_backgrounds와 동일하다고 판단되면 기존 ID를 backgroundId에 사용.
- 새 장소라면 newBackgrounds 배열에 tempId(new_bg_1, new_bg_2 ...) + name + description 선언 후, 씬의 backgroundId에 동일 tempId 사용.
- timeOfDay는 씬마다 별도로 지정 (배경 description에는 시간대 제외).

[BGM 처리 규칙]
- 씬의 감정 톤이 existing_bgms와 동일 카테고리라고 판단되면 기존 BGM ID를 bgmId에 사용 (재사용 우선).
- 새로운 분위기라면 newBgms 배열에 tempId(new_bgm_1 ...) + category + prompt 선언 후, 씬의 bgmId에 동일 tempId 사용.
- prompt는 Lyria 3 Clip용 영어 텍스트 (예: "calm piano melody with soft strings, peaceful ambient").
- 연속되는 유사 분위기 씬은 동일 bgmId를 공유하여 음악 연속성 확보.
```

---

## 11. API 변경 정리

| Method | Path | 변경사항 |
|---|---|---|
| `POST` | `/parsing/backgrounds` | **제거** — 씬 파싱에 통합 |
| `POST` | `/parsing/scenes` | 배경+BGM 통합 처리, 비동기 이미지/음원 트리거 |
| `GET` | `/series/:seriesId/episodes/:episodeNumber/vn-script` | 응답에 `bgm` URL 맵 추가 |
| `POST` | `/images/backgrounds` | 수동 재생성 전용으로 유지 (파이프라인에서 제거) |

---

## 12. 모듈 등록 (`app.module.ts`)

```typescript
// app.module.ts
import { BgmModule } from './bgm/bgm.module';
import { Bgm }       from './entities/bgm.entity';

TypeOrmModule.forRoot({
  // ...
  entities: [...기존..., Bgm],   // Bgm 엔티티 추가
}),

@Module({
  imports: [
    ...기존 모듈...,
    BgmModule,                    // BgmModule 등록
  ],
})
```

**순환 참조 주의:**
`ParsingModule`이 `BgmService`와 `ImageService` 양쪽을 주입해야 하므로, 각 모듈에서 `exports` 설정 확인.

```typescript
// bgm.module.ts
@Module({
  imports:   [CommonModule],
  providers: [BgmService],
  exports:   [BgmService],    // ParsingModule에서 사용
})

// image.module.ts (기존)
@Module({
  imports:   [CommonModule],
  providers: [ImageService],
  exports:   [ImageService],  // 이미 있어야 함
})

// parsing.module.ts
@Module({
  imports:   [CommonModule, BgmModule, ImageModule],
  providers: [ParsingService],
  exports:   [ParsingService],
})
```

---

## 13. GenAIHelperService 리팩토링

외부 AI API 호출 로직을 `GenAIHelperService`로 통합한다. 각 서비스는 API 세부 구현을 알 필요 없이 헬퍼 메서드만 호출한다.

### 13.1 역할 분리

| 서비스 | 현재 | 변경 후 |
|---|---|---|
| `ParsingService` | `ChatGoogleGenerativeAI` 직접 초기화·호출 | `genAiHelper.geminiParse()` 호출 |
| `ImageService` | Leonardo `axios` 직접 호출, `poll()` 보유 | `genAiHelper.leonardoGenerateImage()`, `genAiHelper.leonardoNobg()` 호출 |
| `BgmService` | `GoogleGenerativeAI` 직접 초기화·호출 | `genAiHelper.lyriaGenerateClip()` 호출 |

### 13.2 `gen-ai-helper.service.ts`

```typescript
// backend/src/common/gen-ai-helper.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ZodSchema } from 'zod';
import axios from 'axios';

@Injectable()
export class GenAIHelperService {
  private readonly logger     = new Logger(GenAIHelperService.name);
  private readonly geminiModel: ChatGoogleGenerativeAI;
  private readonly lyriaAI:    GoogleGenerativeAI;
  private readonly lyriaModel: string;
  private readonly leonardoKey: string;

  constructor(private readonly configService: ConfigService) {
    this.geminiModel = new ChatGoogleGenerativeAI({
      model:       this.configService.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash',
      temperature: 0.1,
      apiKey:      this.configService.get<string>('GEMINI_API_KEY'),
    });

    this.lyriaAI    = new GoogleGenerativeAI(this.configService.get<string>('GEMINI_API_KEY') ?? '');
    this.lyriaModel = this.configService.get<string>('LYRIA_MODEL') ?? 'lyria-3-clip-preview';

    this.leonardoKey =
      this.configService.get<string>('LEONARDO_AI_API_KEY') ||
      this.configService.get<string>('LEONARDO_API_KEY') ||
      '';
  }

  // ── Gemini (LangChain) ──────────────────────────────────────────────────────

  /**
   * LangChain 체인 실행 후 Zod 스키마로 파싱된 결과 반환.
   * ParsingService의 모든 LLM 호출에 사용.
   */
  async geminiParse<T>(
    template:       string,
    inputVariables: string[],
    schema:         ZodSchema<T>,
    variables:      Record<string, string>,
  ): Promise<T> {
    const parser         = StructuredOutputParser.fromZodSchema(schema);
    const promptTemplate = new PromptTemplate({
      template,
      inputVariables,
      partialVariables: { format_instructions: parser.getFormatInstructions() },
    });
    const chain = promptTemplate.pipe(this.geminiModel).pipe(parser);
    return chain.invoke(variables) as Promise<T>;
  }

  // ── Lyria 3 Clip ────────────────────────────────────────────────────────────

  /**
   * Lyria 3 Clip으로 MP3 클립 생성 후 Buffer 반환.
   * BgmService에서 S3 업로드 전 단계로 호출.
   */
  async lyriaGenerateClip(prompt: string): Promise<Buffer> {
    const model = this.lyriaAI.getGenerativeModel(
      { model: this.lyriaModel },
      { apiVersion: 'v1beta' },
    );

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { audioEncoding: 'MP3' } as any,
      } as any,
    });

    const inlineData = result.response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) throw new Error('Lyria: audio data 없음');

    return Buffer.from(inlineData.data, 'base64');
  }

  // ── Leonardo AI ─────────────────────────────────────────────────────────────

  private getLeonardoHeaders() {
    return {
      accept:        'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${this.leonardoKey}`,
    };
  }

  /**
   * Leonardo AI로 이미지 생성 후 완료까지 폴링, Buffer + imageId 반환.
   * ImageService의 캐릭터·배경 이미지 생성에 사용.
   */
  async leonardoGenerateImage(
    prompt:       string,
    initImageId?: string,
    styleUUID?:   string,
    width  = 576,
    height = 1024,
  ): Promise<{ buffer: Buffer; imageId: string }> {
    const payload: any = {
      model:      'flux-pro-2.0',
      public:     false,
      parameters: { width, height, quantity: 1, prompt },
    };

    if (styleUUID) payload.parameters.alchemy_refiner_creative_strength = styleUUID;
    if (initImageId) {
      payload.parameters.guidances = {
        image_reference: [{ image: { id: initImageId, type: 'GENERATED' }, strength: 'HIGH' }],
      };
    }

    const response = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v2/generations',
      payload,
      { headers: this.getLeonardoHeaders() },
    );
    const generationId = response.data?.generate?.generationId;
    if (!generationId) throw new Error('Leonardo: generationId 획득 실패');

    const completedData = await this.poll(`Generation [${generationId}]`, async () => {
      const statusRes = await axios.get(
        `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
        { headers: this.getLeonardoHeaders() },
      );
      const gen = statusRes.data?.generations_by_pk;
      if (gen?.status === 'COMPLETE') return gen;
      if (gen?.status === 'FAILED')   throw new Error('Leonardo generation failed');
      return null;
    });

    const imageUrl = completedData.generated_images[0].url;
    const imageId  = completedData.generated_images[0].id;
    const imgRes   = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    return { buffer: Buffer.from(imgRes.data, 'binary'), imageId };
  }

  /**
   * Leonardo NOBG 변환 요청 후 폴링, 완성된 NOBG URL + nobgGenId 반환.
   * 실패 시 null 반환 (ImageService에서 경고 처리).
   */
  async leonardoNobg(genId: string): Promise<{ url: string; nobgGenId: string } | null> {
    const nobgRes = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v1/variations/nobg',
      { id: genId },
      { headers: this.getLeonardoHeaders() },
    );
    const sdNobgJobId = nobgRes.data?.sdNobgJob?.id;
    if (!sdNobgJobId) { this.logger.warn(`[NOBG] Job ID 없음 (genId: ${genId})`); return null; }

    return this.poll(`NOBG [${sdNobgJobId}]`, async () => {
      const varRes  = await axios.get(
        `https://cloud.leonardo.ai/api/rest/v1/variations/${sdNobgJobId}`,
        { headers: this.getLeonardoHeaders() },
      );
      const variants = varRes.data?.generated_image_variation_generic;
      if (variants?.length > 0) {
        const nobgVar = variants.find((v: any) => v.transformType === 'NOBG');
        if (nobgVar?.url) return { url: nobgVar.url as string, nobgGenId: nobgVar.id as string };
      }
      return null;
    });
  }

  // ── 공통 유틸 ────────────────────────────────────────────────────────────────

  private async poll<T>(taskName: string, fn: () => Promise<T | null>): Promise<T> {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const result = await fn();
      if (result) return result;
    }
    throw new Error(`${taskName} timeout after 180s`);
  }
}
```

### 13.3 CommonModule 등록

```typescript
// backend/src/common/common.module.ts
@Module({
  imports:   [TypeOrmModule.forFeature([...entities]), ConfigModule],
  providers: [RepositoryProvider, S3HelperService, GenAIHelperService],
  exports:   [RepositoryProvider, S3HelperService, GenAIHelperService],
})
export class CommonModule {}
```

### 12.4 각 서비스 변경 요약

**ParsingService:**
```typescript
// 제거
private readonly model: ChatGoogleGenerativeAI;
// 추가
constructor(..., private readonly genAI: GenAIHelperService) {}

// 변경 전
const chain = promptTemplate.pipe(this.model).pipe(parser);
const result = await chain.invoke(variables);
// 변경 후
const result = await this.genAI.geminiParse(template, inputVars, schema, variables);
```

**ImageService:**
```typescript
// 제거
private readonly apiKey: string;
private getHeaders() { ... }
private async generateImageToBuffer(...) { ... }
private async poll(...) { ... }
// 추가
constructor(..., private readonly genAI: GenAIHelperService) {}

// 변경 전
const { buffer, imageId } = await this.generateImageToBuffer(prompt, initImageId, styleUUID);
// 변경 후
const { buffer, imageId } = await this.genAI.leonardoGenerateImage(prompt, initImageId, styleUUID);

// 변경 전 (extractAndSaveNobg 내부)
axios.post('.../variations/nobg', ...) + poll(...)
// 변경 후
const nobg = await this.genAI.leonardoNobg(cimg.genId);
```

---

## 14. 구현 우선순위

| 순서 | 작업 | 의존 관계 |
|---|---|---|
| 1 | `GenAIHelperService` 구현 + CommonModule 등록 | 없음 |
| 2 | `bgm.entity.ts` + `BgmCategory` enum + DB DDL | 없음 |
| 3 | `RepositoryProvider`에 `bgm` 추가 | 2 완료 후 |
| 4 | `S3HelperService.uploadAudio` 추가 | 없음 |
| 5 | `ParsingService` → `GenAIHelperService` 사용으로 교체 | 1 완료 후 |
| 6 | `ImageService` → `GenAIHelperService` 사용으로 교체, `generateBackgroundImagesForSeries` 추가 | 1 완료 후 |
| 7 | `BgmService` 구현 (GenAIHelperService 기반) | 1,2,3,4 완료 후 |
| 8 | `scene_prompt` 교체 | 없음 |
| 9 | `parseScenesForEpisode` 전면 개편 (fire-and-forget 제거) | 2~8 완료 후 |
| 10 | `StepKey` enum + `STEP_ORDER` 수정 + Pipeline 5단계로 변경 | 6,7,9 완료 후 |
| 11 | `getVnScript` + `buildVnScript` BGM 추가 | 2,3 완료 후 |
| 12 | `player.html` + `player.js` BGM 재생 로직 | 11 완료 후 |
