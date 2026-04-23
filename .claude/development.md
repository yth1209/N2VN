# N2VN Development Spec

> plan.md 기반 개발 상세 기획서. 구현 관점의 모든 세부 사항을 포함한다.
> 기존 코드베이스는 [structure.md](structure.md) 참조.

---

## 0. 변경 범위 개요

| 영역 | 작업 유형 | 요약 |
|---|---|---|
| DB / TypeORM | 리네임 + 신규 추가 | `novel` → `series`, `episode` + `user` 신규, 마이그레이션 도입 |
| 공통 인프라 | 수정 | `RepositoryProvider` 확장, `S3HelperService` 키 경로 변경 |
| 인증 | 신규 | `AuthModule` (JWT, Passport, bcrypt) |
| Series API | 리팩토링 | `NovelModule` → `SeriesModule` |
| Episode API | 신규 | `EpisodeModule` + `EpisodePipelineService` |
| Parsing | 리팩토링 | `novelId` → `seriesId`, 병합 전략 프롬프트 변경 |
| Image | 리팩토링 | S3 키 경로 변경, `novelId` → `seriesId` |
| Frontend | 전면 재작성 | index / series / mine / player 분리 |

---

## 0.5 코드 컨벤션 참조

> 코드 작성 규칙(DTO 패턴, 응답 래퍼 등)은 **[conventions.md](conventions.md)** 에서 관리한다.

---

## 1. 백엔드 구현

### 1.1 TypeORM 마이그레이션 도입

**`app.module.ts` TypeORM 설정 변경:**

```typescript
TypeOrmModule.forRoot({
  // ...
  synchronize: false,          // 기존 true → false 변경
  migrations: ['dist/migrations/*.js'],
  migrationsRun: true,
})
```

**마이그레이션 파일 생성 순서:**

1. `CreateUserTable` — `user` 테이블 신규 생성
2. `RenameNovelToSeries` — `novel` → `series` 테이블 리네임, 컬럼 변경
3. `CreateEpisodeTable` — `episode` 테이블 신규 생성
4. `CreateEpisodePipelineStepTable` — `episode_pipeline_step` 테이블 신규 생성
5. `UpdateCharacterAndBackground` — `novelId` → `seriesId`, PK를 UUID로 변경
6. `UpdateCharacterImgFK` — `characterId` FK 연결 재정립

> 마이그레이션은 `typeorm migration:generate`, `migration:run` CLI로 관리.

---

### 1.2 엔티티 정의

#### `src/entities/user.entity.ts` (신규)

```typescript
@Entity('user')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 50 })
  loginId: string;

  @Column({ unique: true, length: 255 })
  email: string;

  @Column({ length: 255 })
  password: string;           // bcrypt 해시

  @Column({ length: 100 })
  nickname: string;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => Series, (s) => s.author)
  series: Series[];
}
```

#### `src/entities/series.entity.ts` (기존 `novel.entity.ts` 대체)

```typescript
@Entity('series')
export class Series {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column()
  authorId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'authorId' })
  author: User;

  @Column({ length: 100, nullable: true })
  characterStyleKey: string;

  @Column({ type: 'text', nullable: true })
  characterArtStyle: string;

  @Column({ length: 100, nullable: true })
  backgroundStyleKey: string;

  @Column({ type: 'text', nullable: true })
  backgroundArtStyle: string;

  @Column({ nullable: true })
  latestEpisodeAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => Episode, (e) => e.series)
  episodes: Episode[];

  @OneToMany(() => Character, (c) => c.series)
  characters: Character[];

  @OneToMany(() => Background, (b) => b.series)
  backgrounds: Background[];
}
```

#### `src/entities/episode.entity.ts` (신규)

```typescript
export enum EpisodeStatus {
  PENDING    = 'PENDING',
  PROCESSING = 'PROCESSING',
  DONE       = 'DONE',
  FAILED     = 'FAILED',
}

@Entity('episode')
@Unique(['seriesId', 'episodeNumber'])
export class Episode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  seriesId: string;

  @ManyToOne(() => Series, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'seriesId' })
  series: Series;

  @Column()
  episodeNumber: number;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'enum', enum: EpisodeStatus, default: EpisodeStatus.PENDING })
  status: EpisodeStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => EpisodePipelineStep, (s) => s.episode, { cascade: true })
  pipelineSteps: EpisodePipelineStep[];
}
```

#### `src/entities/episode-pipeline-step.entity.ts` (신규)

5단계 진행도를 episode와 1:N 관계의 별도 테이블로 관리한다.
episode 생성 시 5개 row를 일괄 INSERT하고, 각 단계 실행 전후에 해당 row를 UPDATE한다.

```typescript
export enum StepKey {
  PARSE_CHARACTERS           = 'parseCharacters',
  PARSE_BACKGROUNDS          = 'parseBackgrounds',
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

export enum StepStatus {
  PENDING    = 'PENDING',
  PROCESSING = 'PROCESSING',
  DONE       = 'DONE',
  FAILED     = 'FAILED',
}

@Entity('episode_pipeline_step')
@Unique(['episodeId', 'stepKey'])   // episode 당 stepKey는 유일
export class EpisodePipelineStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  episodeId: string;

  @ManyToOne(() => Episode, (e) => e.pipelineSteps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode;

  @Column({ type: 'enum', enum: StepKey })
  stepKey: StepKey;

  @Column({ type: 'enum', enum: StepStatus, default: StepStatus.PENDING })
  status: StepStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;   // 해당 단계 실패 시 오류 메시지

  @Column({ nullable: true })
  startedAt: Date;

  @Column({ nullable: true })
  finishedAt: Date;
}
```

#### `src/entities/character.entity.ts` (수정)

- `id`: `@PrimaryColumn()` 수동 패턴 → `@PrimaryGeneratedColumn('uuid')`
- `novelId: number` → `seriesId: string`
- FK: `novel.id` → `series.id`

#### `src/entities/background.entity.ts` (수정)

- `id`: `@PrimaryColumn()` → `@PrimaryGeneratedColumn('uuid')`
- `novelId: number` → `seriesId: string`
- FK: `novel.id` → `series.id`

---

### 1.3 공통 인프라 변경

#### `src/common/repository.provider.ts` (확장)

```typescript
@Injectable()
export class RepositoryProvider {
  constructor(
    @InjectRepository(User)                 public readonly user:             Repository<User>,
    @InjectRepository(Series)               public readonly series:           Repository<Series>,
    @InjectRepository(Episode)              public readonly episode:          Repository<Episode>,
    @InjectRepository(EpisodePipelineStep)  public readonly pipelineStep:     Repository<EpisodePipelineStep>,
    @InjectRepository(Character)            public readonly character:        Repository<Character>,
    @InjectRepository(CharacterImg)         public readonly characterImg:     Repository<CharacterImg>,
    @InjectRepository(Background)           public readonly background:       Repository<Background>,
  ) {}
}
```

#### `src/common/s3-helper.service.ts` — S3 키 경로 변경

기존 `{novelId}/...` → `series/{seriesId}/...` 패턴으로 변경.

```typescript
// 업로드 키 예시
`series/${seriesId}/episodes/${episodeNumber}/novel.txt`
`series/${seriesId}/episodes/${episodeNumber}/scenes.json`
`series/${seriesId}/characters/${charId}/${emotion}.png`
`series/${seriesId}/characters/${charId}/${emotion}_NOBG.png`
`series/${seriesId}/backgrounds/${bgId}.png`
```

`uploadText(key: string, text: string): Promise<void>` 메서드 추가:
- `ContentType: 'text/plain'`, SSE-S3 암호화 적용.

---

### 1.4 인증 모듈 (`src/auth/`)

**파일 구조:**
```
src/auth/
├── auth.module.ts
├── auth.controller.ts
├── auth.service.ts
├── jwt.strategy.ts
├── jwt-auth.guard.ts
└── dto/
    ├── register.dto.ts
    └── login.dto.ts
```

#### `auth.service.ts`

| 메서드 | 구현 상세 |
|---|---|
| `register(dto)` | loginId/email UNIQUE 확인 → `bcrypt.hash(password, 10)` → INSERT → `{ id, loginId, nickname }` 반환 |
| `login(dto)` | `loginId`로 user 조회 → `bcrypt.compare` → JWT 서명 → `{ accessToken }` 반환 |
| `getMe(userId)` | user 조회 → `{ id, loginId, email, nickname, createdAt }` 반환 |

#### `jwt.strategy.ts`

```typescript
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET,
    });
  }
  validate(payload: { sub: string }) {
    return { id: payload.sub };   // req.user에 주입됨
  }
}
```

- `JWT_SECRET`: `.env`에 추가, 만료 `24h`

#### `auth.controller.ts`

```typescript
POST /auth/register  -> authService.register(dto)
POST /auth/login     -> authService.login(dto)
GET  /auth/me        -> @UseGuards(JwtAuthGuard) -> authService.getMe(req.user.id)
```

#### `register.dto.ts`

```typescript
class RegisterDto {
  @IsString() @Length(3, 50) @Matches(/^[a-z0-9_]+$/)
  loginId: string;

  @IsEmail()
  email: string;

  @IsString() @MinLength(8)
  password: string;

  @IsString() @Length(2, 50)
  nickname: string;
}
```

---

### 1.5 Series 모듈 (`src/series/`)

**기존 `novel/` 디렉토리 → `series/`로 이름 변경 및 재작성.**

#### API 엔드포인트

```typescript
GET    /series            -> getSeriesList()           // 공개, latestEpisodeAt DESC
GET    /series/mine       -> @Guard -> getMySeries()   // 인증 필요
POST   /series            -> @Guard -> createSeries()  // 인증 필요
GET    /series/:id        -> getSeriesDetail()         // 공개
GET    /series/:id/assets -> getSeriesAssets()         // 공개
```

#### `getSeriesList()` 구현

```typescript
const list = await this.repo.series.find({
  order: { latestEpisodeAt: 'DESC' },
  relations: ['author', 'episodes'],
});
// 반환: id, title, description, authorNickname, latestEpisodeAt, episodeCount, thumbnailUrl
// thumbnailUrl: characters 중 첫 번째 캐릭터의 DEFAULT NOBG 이미지 URL
```

#### `getSeriesDetail()` 구현

```typescript
// series + episodes + author 조인
// episodes: episodeNumber ASC 정렬
// 반환: series 메타 + 회차 목록 (id, episodeNumber, title, status, createdAt)
```

#### `getSeriesAssets()` 구현

```typescript
// 기존 getNovelAssets() N+1 수정 버전
// characters 조회 -> In(charIds)로 characterImgs 한 번에 조회
// S3 URL 조합: https://{bucket}.s3.{region}.amazonaws.com/series/{seriesId}/characters/{charId}/{emotion}.png
```

---

### 1.6 Episode 모듈 (`src/episode/`)

**파일 구조:**
```
src/episode/
├── episode.module.ts
├── episode.controller.ts
├── episode.service.ts
├── episode-pipeline.service.ts
└── dto/
    └── create-episode.dto.ts
```

#### `episode.controller.ts` 엔드포인트

```typescript
POST   /series/:id/episodes              -> @Guard -> createEpisode()
GET    /series/:id/episodes/:num         -> getEpisode()
GET    /series/:id/episodes/:num/vn-script -> getVnScript()
DELETE /series/:id/episodes/:num         -> @Guard -> deleteEpisode()
```

#### `createEpisode()` 구현 (`EpisodeService`)

```typescript
@UseInterceptors(FileInterceptor('file'))
async createEpisode(
  seriesId: string,
  dto: CreateEpisodeDto,      // title: string
  file: Express.Multer.File,  // .txt 파일
  userId: string,
) {
  // 1. series 소유권 확인 (series.authorId === userId, 아니면 403)
  // 2. PROCESSING 중인 episode 있으면 409 Conflict
  // 3. 현재 MAX episodeNumber 조회 → +1
  // 4. episode INSERT (status: PROCESSING)
  // 5. episode_pipeline_step 5개 row 일괄 INSERT (STEP_ORDER 순서, 전부 status: PENDING)
  // 6. S3 업로드: series/{seriesId}/episodes/{epNum}/novel.txt
  // 7. pipeline.run(seriesId, episodeNumber) — fire-and-forget
  // 8. episode 반환 (id, episodeNumber, title, status)
}
```

#### `getEpisode()` 응답 포맷

`GET /series/:id/episodes/:num` 응답에 `pipelineSteps` 배열 포함.
`episode` + `episode_pipeline_step` LEFT JOIN으로 단일 쿼리 조회:

```typescript
this.repo.episode.findOne({
  where: { seriesId, episodeNumber },
  relations: ['pipelineSteps'],
  order: { pipelineSteps: { stepKey: 'ASC' } },  // STEP_ORDER 순서 유지
});
```

응답 포맷:

```json
{
  "id": "uuid",
  "episodeNumber": 3,
  "title": "3화 제목",
  "status": "PROCESSING",
  "errorMessage": null,
  "createdAt": "2026-04-22T10:00:00.000Z",
  "pipelineSteps": [
    { "stepKey": "parseCharacters",          "status": "DONE",       "startedAt": "...", "finishedAt": "...", "errorMessage": null },
    { "stepKey": "parseBackgrounds",         "status": "DONE",       "startedAt": "...", "finishedAt": "...", "errorMessage": null },
    { "stepKey": "parseScenes",              "status": "PROCESSING", "startedAt": "...", "finishedAt": null,  "errorMessage": null },
    { "stepKey": "generateCharacterImages",  "status": "PENDING",    "startedAt": null,  "finishedAt": null,  "errorMessage": null },
    { "stepKey": "generateBackgroundImages", "status": "PENDING",    "startedAt": null,  "finishedAt": null,  "errorMessage": null }
  ]
}
```

#### `getVnScript()` 구현

```typescript
// 기존 /novels/:id/vn-script 로직을 episode 레벨로 이동
// S3에서 series/{seriesId}/episodes/{epNum}/scenes.json 읽기
// characters, character_imgs 조회 (In 단일 쿼리)
// backgrounds 조회
// buildVnScript(scenes, characterMap, sceneMap) 호출
// 반환 포맷: 기존 { characters, scenes, script } 구조 그대로 유지
```

#### `EpisodePipelineService` 구현

각 단계 실행 전후로 `episode_pipeline_step` 테이블의 해당 row를 UPDATE한다.
단계 실패 시 해당 단계만 `FAILED`로 기록하고 파이프라인을 중단한다 (이후 단계는 `PENDING` 유지).

```typescript
async run(seriesId: string, episodeNumber: number): Promise<void> {
  const episode = await this.repo.episode.findOneBy({ seriesId, episodeNumber });

  const steps: Array<{ key: StepKey; fn: () => Promise<void> }> = [
    { key: StepKey.PARSE_CHARACTERS,           fn: () => this.parsingService.parseCharactersForEpisode(seriesId, episodeNumber) },
    { key: StepKey.PARSE_BACKGROUNDS,          fn: () => this.parsingService.parseBackgroundsForEpisode(seriesId, episodeNumber) },
    { key: StepKey.PARSE_SCENES,               fn: () => this.parsingService.parseScenesForEpisode(seriesId, episodeNumber) },
    { key: StepKey.GENERATE_CHARACTER_IMAGES,  fn: () => this.imageService.generateCharacterImages(seriesId) },
    { key: StepKey.GENERATE_BACKGROUND_IMAGES, fn: () => this.imageService.generateBackgroundImages(seriesId) },
  ];

  for (const step of steps) {
    await this.updateStep(episode.id, step.key, StepStatus.PROCESSING, { startedAt: new Date() });
    try {
      await step.fn();
      await this.updateStep(episode.id, step.key, StepStatus.DONE, { finishedAt: new Date() });
    } catch (err) {
      await this.updateStep(episode.id, step.key, StepStatus.FAILED, {
        finishedAt: new Date(),
        errorMessage: err.message,
      });
      await this.repo.episode.update(episode.id, {
        status: EpisodeStatus.FAILED,
        errorMessage: `[${step.key}] ${err.message}`,
      });
      return;
    }
  }

  await this.repo.episode.update(episode.id, { status: EpisodeStatus.DONE });
  await this.repo.series.update(seriesId, { latestEpisodeAt: new Date() });
}

// episode_pipeline_step row 업데이트 헬퍼
private async updateStep(
  episodeId: string,
  stepKey: StepKey,
  status: StepStatus,
  extra: Partial<EpisodePipelineStep> = {},
): Promise<void> {
  await this.repo.pipelineStep.update({ episodeId, stepKey }, { status, ...extra });
}
```

---

### 1.7 Parsing 모듈 리팩토링 (`src/parsing/`)

기존 `POST /parsing/characters`, `POST /parsing/backgrounds`, `POST /parsing/scenes` 엔드포인트는 **외부 호출 가능하게 유지**한다.
파이프라인 특정 단계가 FAILED 상태일 때 해당 단계만 단독으로 재실행할 수 있어야 하기 때문이다.

**엔드포인트 변경 사항:**

| Method | Path | Body | 설명 |
|---|---|---|---|
| `POST` | `/parsing/characters` | `{ seriesId, episodeNumber }` | 캐릭터 파싱 (단독 재실행 가능) |
| `POST` | `/parsing/backgrounds` | `{ seriesId, episodeNumber }` | 배경 파싱 (단독 재실행 가능) |
| `POST` | `/parsing/scenes` | `{ seriesId, episodeNumber }` | 씬 파싱 (단독 재실행 가능) |

- 기존 `novelId` body 파라미터 → `seriesId + episodeNumber` 로 변경
- `EpisodePipelineService`도 이 엔드포인트의 서비스 메서드를 그대로 호출하는 구조로 통일

#### `parseCharactersForEpisode(seriesId, episodeNumber)` 변경점

1. S3 경로: `series/{seriesId}/episodes/{episodeNumber}/novel.txt`
2. **기존 캐릭터 목록 조회 → 프롬프트에 포함:**

```typescript
const existing = await this.repo.character.find({ where: { seriesId } });
const existingStr = existing.map(c =>
  `- ID: ${c.id}, Name: ${c.name}, Sex: ${c.sex}, Look: ${c.look}`
).join('\n');
```

3. 프롬프트 변경: `existing_characters` 파라미터 추가, LLM 지시 추가
4. LLM 응답: 신규 캐릭터만 포함 → UUID 신규 생성하여 INSERT (기존 캐릭터 건드리지 않음)
5. series의 `characterStyleKey`, `characterArtStyle` 갱신 (최초 파싱 시에만 — null인 경우)

#### `parseBackgroundsForEpisode(seriesId, episodeNumber)` 변경점

- 동일 전략: `existing_backgrounds` 프롬프트 파라미터 추가
- 신규 배경만 INSERT
- `backgroundStyleKey`, `backgroundArtStyle` 갱신 (null인 경우)

#### `parseScenesForEpisode(seriesId, episodeNumber)` 변경점

1. S3 저장 경로: `series/{seriesId}/episodes/{episodeNumber}/scenes.json`
2. `characters_info`에 기존 전체 캐릭터 (series 레벨) 전달
3. `character_img` 플레이스홀더: `genId=null`인 경우에만 INSERT (중복 방지)

---

### 1.8 Image 모듈 리팩토링 (`src/image/`)

- `novelId` → `seriesId` 파라미터 전환
- S3 키 경로: `series/{seriesId}/characters/...`, `series/{seriesId}/backgrounds/...`
- `generateCharacterImages(seriesId)`: `genId=null` 필터에서 `seriesId` 기준으로 조회
- `generateBackgroundImages(seriesId)`: 동일

**기존 버그 #2 수정 (`orWhere` 문제):**

```typescript
// 수정 전 (다른 seriesId의 DEFAULT 이미지 포함될 수 있음)
.where('ci.genId IS NULL').orWhere('ci.emotion = :emotion')

// 수정 후
.where('c.seriesId = :seriesId', { seriesId })
.andWhere('ci.genId IS NULL')
```

---

### 1.9 AppModule 구성

```typescript
@Module({
  imports: [
    TypeOrmModule.forRoot({ ... }),
    AuthModule,
    SeriesModule,
    EpisodeModule,
    ParsingModule,
    ImageModule,
  ],
})
```

- `NovelModule` 제거
- `ParsingModule`, `ImageModule`은 `EpisodeModule`에 주입됨 (내부 전용 유지)

---

## 2. 프론트엔드 구현

### 2.1 파일 구조

```
frontend/
├── index.html          # 독자 메인 (작품 목록)
├── index.js
├── series.html         # 작품 상세 + 회차 목록
├── series.js
├── mine.html           # 작가 관리 화면
├── mine.js
├── player.html         # VN 플레이어 (iframe 단독)
├── player.js           # VN 엔진 (기존 유지)
├── auth.js             # 공통 인증 헬퍼 (JWT 관리)
└── style.css
```

---

### 2.2 공통 인증 헬퍼 (`auth.js`)

```javascript
const Auth = {
  getToken: () => localStorage.getItem('token'),
  setToken: (t) => localStorage.setItem('token', t),
  removeToken: () => localStorage.removeItem('token'),
  isLoggedIn: () => !!localStorage.getItem('token'),

  // Authorization 헤더 포함 fetch 래퍼
  authFetch: (url, options = {}) => fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Auth.getToken()}`,
      ...options.headers,
    }
  }),

  // 헤더 UI 갱신 (로그인/로그아웃 버튼)
  updateHeader: async () => { ... },

  // 로그인 모달 표시
  showLoginModal: () => { ... },
  showRegisterModal: () => { ... },
};
```

모든 페이지에서 `<script src="auth.js">` 로 공유.

---

### 2.3 독자 메인 (`index.html` / `index.js`)

#### HTML 구조

```html
<header>
  <h1>N2VN</h1>
  <div id="auth-area"><!-- 로그인/로그아웃 버튼 --></div>
</header>

<div class="tab-bar">
  <button data-tab="all" class="active">전체</button>
  <button data-tab="recent">최신 업데이트</button>
  <button data-tab="read">내가 읽은 작품</button>
</div>

<div id="series-grid" class="card-grid">
  <!-- SeriesCard 반복 렌더링 -->
</div>

<!-- 로그인 모달 (auth.js 공통) -->
<div id="login-modal" class="modal hidden"> ... </div>
<div id="register-modal" class="modal hidden"> ... </div>
```

#### `index.js` 주요 로직

```javascript
// 초기화
document.addEventListener('DOMContentLoaded', async () => {
  await Auth.updateHeader();
  await loadSeriesList();
  setupTabs();
});

// 작품 목록 조회
async function loadSeriesList() {
  const data = await fetch('/series').then(r => r.json());
  allSeries = data.data;
  renderGrid(getSortedFiltered(allSeries));
}

// 복합 정렬: 최근 읽은 작품 상위 → latestEpisodeAt DESC
function getSortedFiltered(list) {
  const history = getReadHistory();  // localStorage
  return [...list].sort((a, b) => {
    const aRead = history[a.id]?.lastReadAt ?? 0;
    const bRead = history[b.id]?.lastReadAt ?? 0;
    if (aRead !== bRead) return bRead - aRead;
    return new Date(b.latestEpisodeAt) - new Date(a.latestEpisodeAt);
  });
}

// 카드 렌더링
function renderSeriesCard(series) {
  return `
    <div class="series-card" onclick="location.href='/series.html?id=${series.id}'">
      <img src="${series.thumbnailUrl ?? '/default-thumb.png'}" alt="${series.title}">
      <div class="card-info">
        <h3>${series.title}</h3>
        <span class="author">${series.authorNickname}</span>
        <span class="episode-count">총 ${series.episodeCount}화</span>
        <span class="latest">${formatDate(series.latestEpisodeAt)}</span>
      </div>
    </div>
  `;
}
```

#### 읽기 이력 로컬스토리지 구조

```javascript
// key: 'n2vn_read_history'
// 값 예시:
{
  "{seriesId}": {
    lastReadAt: 1713800000000,  // timestamp
    readEpisodes: [1, 2, 3]     // 읽은 에피소드 번호 목록
  }
}
```

---

### 2.4 작품 상세 (`series.html` / `series.js`)

#### HTML 구조

```html
<header> ... </header>

<div class="series-hero">
  <img id="series-thumb" src="">
  <div class="series-meta">
    <h2 id="series-title"></h2>
    <p id="series-author"></p>
    <p id="series-description"></p>
  </div>
</div>

<section class="episode-list">
  <h3>회차 목록</h3>
  <ul id="episode-ul">
    <!-- EpisodeItem 반복 -->
  </ul>
</section>

<!-- VN 플레이어 전체화면 모달 -->
<div id="vn-modal" class="modal-fullscreen hidden">
  <button id="vn-close-btn">✕</button>
  <iframe id="vn-iframe" src="player.html" allow="autoplay"></iframe>
</div>
```

#### `series.js` 주요 로직

```javascript
const seriesId = new URLSearchParams(location.search).get('id');

async function init() {
  await Auth.updateHeader();
  const detail = await fetch(`/series/${seriesId}`).then(r => r.json());
  renderSeriesHeader(detail.data);
  renderEpisodeList(detail.data.episodes);
}

function renderEpisodeItem(ep) {
  const isRead = isEpisodeRead(seriesId, ep.episodeNumber);
  const isProcessing = ep.status === 'PROCESSING';
  const isFailed = ep.status === 'FAILED';

  return `
    <li class="episode-item ${isRead ? 'read' : ''} ${isProcessing ? 'processing' : ''}"
        data-ep="${ep.episodeNumber}"
        onclick="${isProcessing || isFailed ? '' : `openVnPlayer(${ep.episodeNumber})`}">
      <span class="ep-num">${ep.episodeNumber}화</span>
      <span class="ep-title">${ep.title}</span>
      <span class="ep-date">${formatDate(ep.createdAt)}</span>
      ${isProcessing ? '<span class="badge processing">생성 중...</span>' : ''}
      ${isFailed    ? '<span class="badge failed">생성 실패</span>' : ''}
    </li>
  `;
}

// VN 플레이어 모달 열기
function openVnPlayer(episodeNumber) {
  const modal = document.getElementById('vn-modal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';  // 배경 스크롤 잠금

  const iframe = document.getElementById('vn-iframe');
  iframe.src = 'player.html';
  iframe.onload = () => {
    iframe.contentWindow.postMessage(
      { seriesId, episodeNumber },
      window.location.origin
    );
    iframe.onload = null;
  };
}

// VN 플레이어 모달 닫기 (읽기 이력 저장)
function closeVnPlayer(episodeNumber) {
  document.getElementById('vn-modal').classList.add('hidden');
  document.body.style.overflow = '';
  markEpisodeAsRead(seriesId, episodeNumber);
  renderEpisodeList(...);  // 읽은 항목 회색 처리 갱신
}

// ESC 키 닫기
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeVnPlayer(currentEpisodeNumber);
});
```

---

### 2.5 VN 플레이어 변경점 (`player.js`)

기존 `novelId` 수신 → `{ seriesId, episodeNumber }` 수신으로 변경.

```javascript
// 기존
const novelId = event.data?.novelId;
await loadNovel(novelId);  // GET /novels/:id/vn-script

// 변경 후
const { seriesId, episodeNumber } = event.data ?? {};
if (!seriesId || !episodeNumber) return;
await loadScript(seriesId, episodeNumber);  // GET /series/:id/episodes/:num/vn-script
```

`loadScript` 함수 API 경로만 변경, 스크립트 파싱 및 엔진 로직은 그대로 유지.

---

### 2.6 작가 관리 화면 (`mine.html` / `mine.js`)

#### HTML 구조

```html
<header> ... </header>

<!-- 미로그인 상태 -->
<div id="login-prompt" class="hidden">
  <p>내 작품을 관리하려면 로그인하세요.</p>
  <button onclick="Auth.showLoginModal()">로그인</button>
</div>

<!-- 로그인 상태 -->
<div id="mine-content" class="hidden">
  <div class="mine-header">
    <h2>내 작품</h2>
    <button id="new-series-btn" onclick="showNewSeriesModal()">+ 새 작품 만들기</button>
  </div>
  <div id="mine-grid" class="card-grid"> ... </div>
</div>

<!-- 새 작품 만들기 모달 -->
<div id="new-series-modal" class="modal hidden">
  <input id="ns-title" placeholder="작품 제목">
  <textarea id="ns-desc" placeholder="작품 소개 (선택)"></textarea>
  <button onclick="submitNewSeries()">만들기</button>
</div>

<!-- 작품 상세 모달 -->
<div id="series-detail-modal" class="modal hidden">
  <div class="tab-bar">
    <button data-tab="episodes" class="active">회차</button>
    <button data-tab="assets">에셋</button>
  </div>

  <!-- 회차 탭 -->
  <div id="ep-tab">
    <ul id="ep-list"> ... </ul>
    <button id="add-episode-btn">+ 다음 회차 추가</button>
  </div>

  <!-- 에셋 탭 -->
  <div id="assets-tab" class="hidden">
    <section class="char-gallery"> ... </section>
    <section class="bg-gallery"> ... </section>
  </div>
</div>

<!-- 회차 추가 모달 -->
<div id="add-episode-modal" class="modal hidden">
  <input id="ep-title" placeholder="회차 제목">
  <input id="ep-file" type="file" accept=".txt">
  <button onclick="submitAddEpisode()">업로드</button>
</div>
```

#### `mine.js` 주요 로직

```javascript
async function init() {
  if (!Auth.isLoggedIn()) {
    show('login-prompt'); return;
  }
  show('mine-content');
  await loadMySeries();
}

// 내 작품 목록
async function loadMySeries() {
  const data = await Auth.authFetch('/series/mine').then(r => r.json());
  renderMineGrid(data.data);
}

// 새 작품 생성
async function submitNewSeries() {
  const title = document.getElementById('ns-title').value.trim();
  const description = document.getElementById('ns-desc').value.trim();
  await Auth.authFetch('/series', {
    method: 'POST',
    body: JSON.stringify({ title, description }),
  });
  closeModal('new-series-modal');
  await loadMySeries();
}

// 작품 상세 모달 열기
async function openSeriesDetail(seriesId) {
  currentSeriesId = seriesId;
  const [detail, assets] = await Promise.all([
    fetch(`/series/${seriesId}`).then(r => r.json()),
    fetch(`/series/${seriesId}/assets`).then(r => r.json()),
  ]);
  renderEpisodeList(detail.data.episodes);
  renderAssetsGallery(assets.data);
  checkAddEpisodeBtn(detail.data.episodes);
  show('series-detail-modal');
}

// 회차 추가 버튼 활성화 여부
function checkAddEpisodeBtn(episodes) {
  const isProcessing = episodes.some(e => e.status === 'PROCESSING');
  document.getElementById('add-episode-btn').disabled = isProcessing;
}

// 회차 추가 제출 (multipart/form-data)
async function submitAddEpisode() {
  const title = document.getElementById('ep-title').value.trim();
  const file = document.getElementById('ep-file').files[0];

  const formData = new FormData();
  formData.append('title', title);
  formData.append('file', file);

  await Auth.authFetch(`/series/${currentSeriesId}/episodes`, {
    method: 'POST',
    headers: {},               // Content-Type은 FormData가 자동 설정 (multipart boundary 포함)
    body: formData,
  });
  closeModal('add-episode-modal');
  startPolling(currentSeriesId);
}

// 파이프라인 폴링 (3초 간격)
// PROCESSING 중인 에피소드가 없어지면 자동 중단
let pollingTimer = null;
function startPolling(seriesId) {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(async () => {
    const detail = await fetch(`/series/${seriesId}`).then(r => r.json());
    renderEpisodeList(detail.data.episodes);
    checkAddEpisodeBtn(detail.data.episodes);
    const stillProcessing = detail.data.episodes.some(e => e.status === 'PROCESSING');
    if (!stillProcessing) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }, 3000);
}

// 파이프라인 진행도 스텝 인디케이터 렌더링
const STEP_LABELS = {
  parseCharacters:          '캐릭터 분석',
  parseBackgrounds:         '배경 분석',
  parseScenes:              '씬 분석',
  generateCharacterImages:  '캐릭터 이미지 생성',
  generateBackgroundImages: '배경 이미지 생성',
};

const STEP_ICONS = {
  PENDING:    '○',
  PROCESSING: '⟳',
  DONE:       '✓',
  FAILED:     '✕',
};

function renderPipelineSteps(episode) {
  if (episode.status !== 'PROCESSING' && episode.status !== 'FAILED') return '';
  const steps = episode.pipelineSteps;

  const items = Object.entries(STEP_LABELS).map(([key, label]) => {
    const status = steps[key] ?? 'PENDING';
    const isFailed = status === 'FAILED';
    return `
      <li class="pipeline-step ${status.toLowerCase()}">
        <span class="step-icon">${STEP_ICONS[status]}</span>
        <span class="step-label">${label}</span>
        ${isFailed ? `<button onclick="retryStep('${episode.seriesId}', ${episode.episodeNumber}, '${key}')">재실행</button>` : ''}
      </li>
    `;
  }).join('');

  return `<ul class="pipeline-steps">${items}</ul>`;
}

// 특정 단계 단독 재실행 (stepKey는 StepKey enum 값과 동일한 문자열)
async function retryStep(seriesId, episodeNumber, stepKey) {
  const STEP_ENDPOINTS = {
    parseCharacters:          `/parsing/characters`,
    parseBackgrounds:         `/parsing/backgrounds`,
    parseScenes:              `/parsing/scenes`,
    generateCharacterImages:  `/images/characters`,
    generateBackgroundImages: `/images/backgrounds`,
  };
  const url = STEP_ENDPOINTS[stepKey];
  if (!url) return;

  await Auth.authFetch(url, {
    method: 'POST',
    body: JSON.stringify({ seriesId, episodeNumber }),
  });
  startPolling(seriesId);
}

// 회차 삭제
async function deleteEpisode(episodeNumber) {
  if (!confirm(`${episodeNumber}화를 삭제하시겠습니까?`)) return;
  await Auth.authFetch(`/series/${currentSeriesId}/episodes/${episodeNumber}`, {
    method: 'DELETE',
  });
  await openSeriesDetail(currentSeriesId);  // 목록 갱신
}

// 에셋 갤러리 (캐릭터 감정별 이미지)
function renderCharGallery(characters) {
  return characters.map(char => `
    <div class="char-card">
      <h4>${char.name}</h4>
      <div class="emotion-grid">
        ${char.images.map(img => `
          <div class="emotion-item">
            <img src="${img.nobgUrl ?? img.url}" alt="${img.emotion}">
            <span>${img.emotion}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}
```

---

### 2.7 로그인/회원가입 모달 (공통 `auth.js`)

```javascript
// 로그인 모달
Auth.showLoginModal = () => {
  // loginId + password 입력 폼 표시
  // 제출 시 POST /auth/login → 성공하면 token 저장, 모달 닫기, header 갱신
};

// 회원가입 모달
Auth.showRegisterModal = () => {
  // loginId + email + password + nickname 입력 폼 표시
  // 제출 시 POST /auth/register → 성공하면 자동 로그인(POST /auth/login) → token 저장
};

// 헤더 갱신
Auth.updateHeader = async () => {
  const area = document.getElementById('auth-area');
  if (!Auth.isLoggedIn()) {
    area.innerHTML = `<button onclick="Auth.showLoginModal()">로그인</button>`;
    return;
  }
  const me = await Auth.authFetch('/auth/me').then(r => r.json()).catch(() => null);
  if (!me?.data) {
    Auth.removeToken();
    area.innerHTML = `<button onclick="Auth.showLoginModal()">로그인</button>`;
    return;
  }
  area.innerHTML = `
    <span class="nickname">${me.data.nickname}</span>
    <a href="/mine.html">내 작품</a>
    <button onclick="Auth.logout()">로그아웃</button>
  `;
};

Auth.logout = () => {
  Auth.removeToken();
  location.reload();
};
```

---

## 3. 스타일 가이드 (`style.css`)

### 주요 공통 클래스

```css
/* 전체화면 모달 (VN 플레이어) */
.modal-fullscreen {
  position: fixed; inset: 0;
  z-index: 9999;
  background: #000;
}
.modal-fullscreen #vn-close-btn {
  position: absolute; top: 16px; right: 16px;
  z-index: 10000;
  background: rgba(255,255,255,0.2);
  border: none; color: #fff;
  padding: 8px 12px; cursor: pointer;
}
.modal-fullscreen iframe {
  width: 100%; height: 100%; border: none;
}

/* 읽은 회차 회색 처리 */
.episode-item.read {
  opacity: 0.45;
  color: #888;
}

/* 상태 배지 */
.badge.processing { background: #f0ad4e; color: #fff; }
.badge.failed     { background: #d9534f; color: #fff; }

/* 카드 그리드 */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
```

---

## 4. 환경변수 (`.env`) 추가 항목

```
JWT_SECRET=<랜덤 32바이트 이상 문자열>
```

기존 항목:
```
DB_HOST / DB_PORT / DB_USER / DB_PASS / DB_NAME
AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION / S3_BUCKET
GEMINI_API_KEY / LEONARDO_API_KEY
```

---

## 5. 패키지 추가

```bash
# 백엔드
npm install @nestjs/passport @nestjs/jwt passport passport-jwt bcrypt
npm install -D @types/passport-jwt @types/bcrypt
npm install @nestjs/platform-express multer
npm install -D @types/multer
```

---

## 6. 구현 우선순위 (Phase)

### Phase 1 — 백엔드 기반

| 순서 | 작업 | 파일 |
|---|---|---|
| 1 | 마이그레이션 도입, 엔티티 수정/신규 | `entities/`, `migrations/` |
| 2 | `RepositoryProvider` 확장 | `common/repository.provider.ts` |
| 3 | `AuthModule` 구현 | `auth/` |
| 4 | `SeriesModule` 구현 | `series/` |
| 5 | `EpisodeModule` + `EpisodePipelineService` | `episode/` |
| 6 | `ParsingModule` 리팩토링 (병합 전략) | `parsing/` |
| 7 | `ImageModule` 리팩토링 (S3 경로, 버그 수정) | `image/` |

### Phase 2 — 프론트엔드

| 순서 | 작업 | 파일 |
|---|---|---|
| 8 | `auth.js` 공통 헬퍼 | `frontend/auth.js` |
| 9 | 독자 메인 | `frontend/index.html`, `index.js` |
| 10 | 작품 상세 + VN 플레이어 모달 | `frontend/series.html`, `series.js` |
| 11 | `player.js` 수신 파라미터 수정 | `frontend/player.js` |
| 12 | 작가 관리 화면 | `frontend/mine.html`, `mine.js` |

### Phase 3 — 완성도

| 순서 | 작업 |
|---|---|
| 13 | 에러 토스트 UI (공통 헬퍼) |
| 14 | 로딩 스피너 (파이프라인 중 skeleton UI) |
| 15 | 반응형 CSS (모바일 대응) |
| 16 | `player.js` postMessage origin 검증 |

---

## 7. 기존 코드 삭제 대상

| 파일/경로 | 처리 |
|---|---|
| `src/novel/` | `src/series/`로 교체 후 삭제 |
| `src/entities/novel.entity.ts` | `series.entity.ts`로 교체 후 삭제 |
| `frontend/app.js` | `index.js` + `series.js` + `mine.js`로 분리 후 삭제 |
| `src/image/image.controller.ts` 외부 라우트 | 내부 전용으로 전환 (컨트롤러 비활성화 또는 Guard 적용) |
