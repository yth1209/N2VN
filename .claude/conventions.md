# N2VN Code Conventions

> 코드 작성 전 반드시 확인하는 규칙 문서.
> 아키텍처/스키마는 [structure.md](structure.md) 참조.

---

## 1. API 응답 DTO 규칙

**모든 API 응답은 Entity를 직접 반환하지 않고 별도 Response DTO 클래스로 wrapping한다.**

Entity는 DB 스키마와 결합되어 있어 언제든 컬럼이 추가/변경/삭제될 수 있다.
DTO를 두면 Entity가 바뀌어도 API 계약을 독립적으로 유지할 수 있다.

### 디렉토리 규칙

각 모듈 내 `dto/` 폴더에 Request DTO와 Response DTO를 함께 둔다.

```
src/
├── auth/dto/
│   ├── register.dto.ts              # Request
│   ├── login.dto.ts                 # Request
│   └── me.response.dto.ts           # Response
├── series/dto/
│   ├── create-series.dto.ts         # Request
│   ├── series-list.response.dto.ts
│   ├── series-detail.response.dto.ts
│   └── series-assets.response.dto.ts
├── episode/dto/
│   ├── create-episode.dto.ts        # Request
│   ├── episode.response.dto.ts
│   ├── vn-script.response.dto.ts
│   └── pipeline-step.response.dto.ts
└── parsing/dto/
    ├── parse-episode.dto.ts         # Request (seriesId, episodeNumber 공통)
    └── parse.response.dto.ts
```

### Response DTO 작성 규칙

1. **클래스 + 생성자 패턴** — Entity를 인자로 받아 필요한 필드만 노출한다.
2. **민감 필드 제외** — `password` 등은 DTO에 포함하지 않는다.
3. **관계 필드 중첩** — 연관 엔티티는 별도 DTO로 감싼다.

```typescript
// 예시: episode/dto/episode.response.dto.ts
export class PipelineStepDto {
  stepKey:      string;
  status:       string;
  errorMessage: string | null;
  startedAt:    Date | null;
  finishedAt:   Date | null;

  constructor(step: EpisodePipelineStep) {
    this.stepKey      = step.stepKey;
    this.status       = step.status;
    this.errorMessage = step.errorMessage ?? null;
    this.startedAt    = step.startedAt ?? null;
    this.finishedAt   = step.finishedAt ?? null;
  }
}

export class EpisodeResponseDto {
  id:            string;
  episodeNumber: number;
  title:         string;
  status:        string;
  errorMessage:  string | null;
  createdAt:     Date;
  pipelineSteps: PipelineStepDto[];

  constructor(episode: Episode) {
    this.id            = episode.id;
    this.episodeNumber = episode.episodeNumber;
    this.title         = episode.title;
    this.status        = episode.status;
    this.errorMessage  = episode.errorMessage ?? null;
    this.createdAt     = episode.createdAt;
    this.pipelineSteps = (episode.pipelineSteps ?? []).map((s) => new PipelineStepDto(s));
  }
}
```

---

## 2. 공통 응답 래퍼

모든 API는 아래 형태로 응답한다. Controller에서 직접 구성한다.

```typescript
// 성공 (단건)
return { success: true, data: new EpisodeResponseDto(episode) };

// 성공 (목록)
return { success: true, data: list.map((e) => new EpisodeResponseDto(e)) };
```

실패 응답은 NestJS Exception Filter로 통일하여 아래 형태로 반환한다.

```typescript
// 실패 (Exception Filter)
return { success: false, message: '에러 메시지' };
```
