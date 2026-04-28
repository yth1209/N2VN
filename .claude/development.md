# 개발 상세 기획서 — Episode Pipeline Event-Driven Architecture 전환

> 작성 기준: `proposal.md` (2026-04-24)
> 참조: `structure.md`, `episode-pipeline.service.ts`, `parsing.service.ts`

---

## 1. 목표 및 범위

### 목표
`EpisodePipelineService.run()`의 순차 오케스트레이터 방식을 **이벤트 기반 아키텍처(EDA)**로 전환한다.
- 파싱 완료 후 이미지 생성·BGM 생성 3개 작업을 **병렬** 처리
- 각 단계의 상태(PENDING→PROCESSING→DONE/FAILED)를 **단일 서비스**에서 중앙 관리
- `EpisodePipelineService`는 이벤트 발행만 담당, 개별 서비스는 순수 비즈니스 로직만 유지

### 변환 전/후 흐름 비교

**현재 (Orchestrator — 완전 순차)**
```
run()
  → parseCharacters  (await)
  → parseScenes      (await)
  → generateCharacterImages   (await)
  → generateBackgroundImages  (await)
  → generateBgm               (await)
```

**목표 (Event-Driven — 병렬 포함)**
```
run() → emit [pipeline.start]
          ↓
  CharacterParsingHandler  listens [pipeline.start]
          ↓  emit [pipeline.characters.done]
  SceneParsingHandler      listens [pipeline.characters.done]
          ↓  emit [pipeline.scenes.done]
  ┌───────┼───────────────────────┐
  ↓       ↓                      ↓
CharImg  BackgroundImg          Bgm   (3개 병렬)
Handler  Handler                Handler
  ↓       ↓                      ↓
emit   emit                   emit [pipeline.{step}.done]
  └───────┴───────────────────────┘
          ↓  (3개 모두 완료 시)
  PipelineCoordinatorService → episode.status = DONE
```

---

## 2. 사용 패키지

```bash
npm install @nestjs/event-emitter
```

`AppModule`에 `EventEmitterModule.forRoot({ wildcard: false })` 등록.

---

## 3. 파일 변경 목록

### 신규 파일

| 경로 | 역할 |
|---|---|
| `src/pipeline/pipeline.module.ts` | PipelineModule 정의 |
| `src/pipeline/pipeline.events.ts` | 이벤트 상수·페이로드 클래스 |
| `src/pipeline/handlers/base-pipeline.handler.ts` | 추상 기반 클래스 (Template Method + 상태 관리) |
| `src/pipeline/handlers/character-parsing.handler.ts` | PARSE_CHARACTERS 핸들러 |
| `src/pipeline/handlers/scene-parsing.handler.ts` | PARSE_SCENES 핸들러 |
| `src/pipeline/handlers/character-image.handler.ts` | GENERATE_CHARACTER_IMAGES 핸들러 |
| `src/pipeline/handlers/background-image.handler.ts` | GENERATE_BACKGROUND_IMAGES 핸들러 |
| `src/pipeline/handlers/bgm.handler.ts` | GENERATE_BGM 핸들러 |

### 변경 파일

| 경로 | 변경 내용 |
|---|---|
| `src/episode/episode-pipeline.service.ts` | `run()` 단순화: emit만 수행, 서비스 의존성 제거 |
| `src/episode/episode.module.ts` | `PipelineModule` import 추가 |
| `src/parsing/parsing.service.ts` | 공개 메서드에서 `updateStep` 호출 제거, 메서드명 변경 |
| `src/image/image.service.ts` | 공개 메서드에서 `updateStep` 호출 제거 |
| `src/bgm/bgm.service.ts` | 공개 메서드에서 `updateStep` 호출 제거 |
| `src/app.module.ts` | `EventEmitterModule.forRoot()` 등록 |

---

## 4. 이벤트 정의 (`pipeline.events.ts`)

```typescript
import { StepKey } from '../entities/episode-pipeline-step.entity';

// ─── 이벤트 토픽 상수 ────────────────────────────────────
export const PipelineEvent = {
  START:          'pipeline.start',
  CHARACTERS_DONE:'pipeline.characters.done',
  SCENES_DONE:    'pipeline.scenes.done',
  CHAR_IMG_DONE:  'pipeline.charImages.done',
  BG_IMG_DONE:    'pipeline.bgImages.done',
  BGM_DONE:       'pipeline.bgm.done',
  STEP_FAILED:    'pipeline.step.failed',
} as const;

// ─── 페이로드 ────────────────────────────────────────────
export class PipelineStartPayload {
  episodeId: string;
  seriesId: string;
  episodeNumber: number;
}

export class PipelineStepDonePayload {
  episodeId: string;
  seriesId: string;
  episodeNumber: number;
  stepKey: StepKey;
}

export class PipelineStepFailedPayload {
  episodeId: string;
  stepKey: StepKey;
  error: string;
}
```

---

---

## 6. Handler 구조 — Template Method 패턴 (상속)

5개 핸들러는 try/catch·emit 로직이 완전히 동일하므로 추상 기반 클래스로 공통화한다.
`@OnEvent` 데코레이터는 컴파일 타임에 문자열이 결정되어야 하므로 자식 클래스에서만 선언.

### BasePipelineHandler (추상 클래스)

step 상태 관리 + try/catch + emit을 모두 담당. `PipelineCoordinatorService` 불필요.

```typescript
// src/pipeline/handlers/base-pipeline.handler.ts
export abstract class BasePipelineHandler {
  constructor(
    protected readonly eventEmitter: EventEmitter2,
    protected readonly repo: RepositoryProvider,
  ) {}

  protected abstract readonly doneEvent: string;
  protected abstract readonly stepKey: StepKey;

  protected abstract execute(seriesId: string, episodeNumber: number): Promise<void>;

  protected async run(payload: { episodeId: string; seriesId: string; episodeNumber: number }): Promise<void> {
    const { episodeId, seriesId, episodeNumber } = payload;

    // 1. PROCESSING
    await this.repo.pipelineStep.updateStep(episodeId, this.stepKey, StepStatus.PROCESSING, { startedAt: new Date() });

    try {
      await this.execute(seriesId, episodeNumber);

      // 2. DONE
      await this.repo.pipelineStep.updateStep(episodeId, this.stepKey, StepStatus.DONE, { finishedAt: new Date() });
      this.eventEmitter.emit(this.doneEvent, { ...payload, stepKey: this.stepKey });

      // 3. 병렬 3개 step 완료 여부 체크 → episode DONE
      await this.checkEpisodeDone(episodeId, seriesId);

    } catch (err: any) {
      // 4. FAILED
      await this.repo.pipelineStep.updateStep(episodeId, this.stepKey, StepStatus.FAILED, { finishedAt: new Date(), errorMessage: err.message });
      await this.repo.episode.update(episodeId, { status: EpisodeStatus.FAILED, errorMessage: `[${this.stepKey}] ${err.message}` });
    }
  }

  // GENERATE_* 3개 step이 모두 DONE이면 episode 완료 처리
  private async checkEpisodeDone(episodeId: string, seriesId: string): Promise<void> {
    const episode = await this.repo.episode.findOneBy({ id: episodeId });
    if (episode?.status === EpisodeStatus.FAILED) return;  // 이미 실패면 스킵

    const parallelSteps = [StepKey.GENERATE_CHARACTER_IMAGES, StepKey.GENERATE_BACKGROUND_IMAGES, StepKey.GENERATE_BGM];
    const steps = await this.repo.pipelineStep.findBy({ episodeId, stepKey: In(parallelSteps) });
    const allDone = steps.length === parallelSteps.length && steps.every(s => s.status === StepStatus.DONE);

    if (allDone) {
      await this.repo.episode.update(episodeId, { status: EpisodeStatus.DONE });
      await this.repo.series.update(seriesId, { latestEpisodeAt: new Date() });
    }
  }
}
```

### 자식 핸들러 예시 (CharacterParsingHandler)

```typescript
// src/pipeline/handlers/character-parsing.handler.ts
@Injectable()
export class CharacterParsingHandler extends BasePipelineHandler {
  protected readonly doneEvent = PipelineEvent.CHARACTERS_DONE;
  protected readonly stepKey   = StepKey.PARSE_CHARACTERS;

  constructor(
    private readonly parsingService: ParsingService,
    eventEmitter: EventEmitter2,
  ) { super(eventEmitter); }

  @OnEvent(PipelineEvent.START)                          // 각 자식에서만 선언
  handle(payload: PipelineStartPayload) { return this.run(payload); }

  protected execute(seriesId: string, episodeNumber: number) {
    return this.parsingService.parseCharacters(seriesId, episodeNumber);
  }
}
```

### 5개 핸들러 매핑

| 핸들러 | `doneEvent` | `stepKey` | `@OnEvent` | `execute()` 호출 |
|---|---|---|---|---|
| `CharacterParsingHandler` | `CHARACTERS_DONE` | `PARSE_CHARACTERS` | `pipeline.start` | `parsingService.parseCharacters()` |
| `SceneParsingHandler` | `SCENES_DONE` | `PARSE_SCENES` | `pipeline.characters.done` | `parsingService.parseScenes()` |
| `CharacterImageHandler` | `CHAR_IMG_DONE` | `GENERATE_CHARACTER_IMAGES` | `pipeline.scenes.done` | `imageService.generateCharacterImages()` |
| `BackgroundImageHandler` | `BG_IMG_DONE` | `GENERATE_BACKGROUND_IMAGES` | `pipeline.scenes.done` | `imageService.generateBackgroundImages()` |
| `BgmHandler` | `BGM_DONE` | `GENERATE_BGM` | `pipeline.scenes.done` | `bgmService.generateBgm()` |

---

## 7. 기존 서비스 리팩터링

### ParsingService 변경

공개 메서드에서 `updateStep` 호출 제거 + 메서드명 변경. 내부 private `_parse*` 메서드는 그대로 유지.

```typescript
// 변경 전
async parseCharactersForEpisode(seriesId, episodeNumber): Promise<void> {
  // updateStep PROCESSING ...
  await this._parseCharacters(seriesId, episodeNumber);
  // updateStep DONE ...
}

// 변경 후 (상태 관리 코드 전부 제거)
async parseCharacters(seriesId: string, episodeNumber: number): Promise<void> {
  await this._parseCharacters(seriesId, episodeNumber);
}

async parseScenes(seriesId: string, episodeNumber: number): Promise<void> {
  await this._parseScenes(seriesId, episodeNumber);
}
```

### ImageService, BgmService 동일 패턴

- `generateCharacterImages(seriesId, episodeNumber)` — `updateStep` 제거
- `generateBackgroundImages(seriesId, episodeNumber)` — `updateStep` 제거
- `generateBgm(seriesId, episodeNumber)` — `updateStep` 제거

> ⚠️ 주의: 기존 서비스 메서드명이 `generateCharacterImages`, `generateBackgroundImagesForSeries`, `generateBgmForSeries`로 혼재. 이 기회에 `generateCharacterImages`, `generateBackgroundImages`, `generateBgm` 으로 통일.

---

## 8. EpisodePipelineService 단순화

`episode.status = PROCESSING` 초기화 후 START 이벤트 발행. 서비스 의존성 전부 제거.

```typescript
@Injectable()
export class EpisodePipelineService {
  constructor(
    private readonly repo: RepositoryProvider,
    private readonly eventEmitter: EventEmitter2,
    // ParsingService, ImageService, BgmService 의존성 제거
  ) {}

  async run(seriesId: string, episodeNumber: number): Promise<void> {
    const episode = await this.repo.episode.findOneBy({ seriesId, episodeNumber });
    if (!episode) {
      this.logger.error(`Episode not found: ${seriesId}/${episodeNumber}`);
      return;
    }

    // episode 상태 초기화 (Coordinator 없이 여기서 직접)
    await this.repo.episode.update(episode.id, { status: EpisodeStatus.PROCESSING });

    this.eventEmitter.emit(PipelineEvent.START, {
      episodeId:     episode.id,
      seriesId,
      episodeNumber,
    } satisfies PipelineStartPayload);
  }
}
```

---

## 9. PipelineModule

```typescript
@Module({
  imports: [
    CommonModule,
    ParsingModule,
    ImageModule,
    BgmModule,
  ],
  providers: [
    CharacterParsingHandler,
    SceneParsingHandler,
    CharacterImageHandler,
    BackgroundImageHandler,
    BgmHandler,
  ],
})
export class PipelineModule {}
```

`EpisodeModule`에서 `PipelineModule` import 추가.

---

## 10. AppModule 변경

```typescript
@Module({
  imports: [
    EventEmitterModule.forRoot({ wildcard: false }),  // 추가
    // ... 기존 모듈들
  ],
})
export class AppModule {}
```

---

## 11. 구현 순서

1. `npm install @nestjs/event-emitter` 설치
2. `AppModule`에 `EventEmitterModule.forRoot()` 등록
3. `pipeline.events.ts` — 이벤트 상수·페이로드 작성
4. `ParsingService`, `ImageService`, `BgmService` — `updateStep` 제거 + 메서드명 통일
5. `BasePipelineHandler` 작성 (상태 관리 + try/catch + emit + 병렬 완료 체크)
6. 핸들러 5개 작성 (`character-parsing`, `scene-parsing`, `character-image`, `background-image`, `bgm`)
7. `PipelineModule` 작성
8. `EpisodePipelineService.run()` 단순화 (episode PROCESSING 초기화 + emit만)
9. `EpisodeModule`에 `PipelineModule` import 추가

---

## 12. 고려 사항 및 제약

### 이벤트 핸들러 에러 처리
`@OnEvent` 핸들러에서 throw된 예외는 NestJS 이벤트 에미터에 의해 조용히 무시될 수 있음. 각 핸들러 내부에서 반드시 try/catch로 감싸고 `pipeline.step.failed` 이벤트를 직접 emit해야 함.

### 병렬 step 중 하나 실패 시
`pipeline.step.failed` 수신 → `PipelineCoordinator`가 episode FAILED 처리. 이미 진행 중인 다른 병렬 작업은 자연 완료될 때까지 실행됨 (중단 없음). `checkAllParallelDone` 은 episode가 이미 FAILED인 경우 스킵.

### 동일 이벤트 중복 발행 방지
`scenes.done` 이벤트 수신 시 3개 병렬 핸들러가 동시에 트리거됨. 각 핸들러는 독립적인 step을 처리하므로 DB 충돌 없음.

### 기존 step 초기화 타이밍
`pipeline.start` 이전에 `EpisodePipelineStep` 레코드가 이미 생성되어 있어야 함 (현재 `episode.service.ts`에서 생성). `PipelineCoordinatorService.onStart()`에서 step들이 PENDING 상태인지 확인 후, 이미 있으면 status를 PENDING으로 리셋.
