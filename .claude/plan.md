# N2VN Plan

> proposal.md 기반으로 작성한 상세 기획서.
> 개발 상세는 [development.md](development.md) 참조.

---

## 1. 핵심 변경 사항 요약

| 구분 | Before | After |
|---|---|---|
| 소설 단위 | 소설 전체를 1개 레코드 | 작품(Series) + 회차(Episode) 2단계 구조 |
| 업로드 방식 | 수동으로 S3에 novel.txt 사전 업로드 | API 통해 회차 텍스트 직접 업로드 |
| 파이프라인 | 7단계 수동 API 호출 | 회차 업로드 시 자동으로 전체 파이프라인 실행 |
| 화면 구성 | 단일 대시보드 | 독자 화면 / 작가(내 작품) 화면 분리 |
| 인증 | 없음 | 회원가입/로그인 (JWT) |
| VN 플레이어 | 탭 내 iframe | 전체화면 모달, ESC/버튼으로 닫기 |
| 읽기 이력 | 없음 | 로컬스토리지 기반 회차 읽기 이력 + 회색 처리 |

---

## 2. DB 스키마 설계

### 2.1 `user` (신규)

```typescript
@Entity('user')
class User {
  id: string;           // PK: UUID v4 (@PrimaryGeneratedColumn('uuid'))
  loginId: string;      // UNIQUE, 사용자 직접 입력하는 로그인 ID
  email: string;        // UNIQUE, 연락용 이메일
  password: string;     // bcrypt 해시
  nickname: string;     // 표시 이름
  createdAt: Date;
}
```

### 2.2 `series` (기존 `novel` 리네임 + 확장)

```typescript
@Entity('series')
class Series {
  id: string;                  // PK: UUID v4 (@PrimaryGeneratedColumn('uuid'))
  title: string;               // 작품 제목 (VARCHAR 255)
  description: string;         // 작품 소개 (TEXT, 선택)
  authorId: string;            // FK → user.id (CASCADE DELETE)
  characterStyleKey: string;   // 캐릭터 이미지 스타일 키
  characterArtStyle: string;   // 캐릭터 아트 스타일 텍스트
  backgroundStyleKey: string;  // 배경 스타일 키
  backgroundArtStyle: string;  // 배경 아트 스타일 텍스트
  latestEpisodeAt: Date;       // 최신 회차 업로드 시각 (정렬용)
  createdAt: Date;
}
```

### 2.3 `episode` (신규)

```typescript
@Entity('episode')
class Episode {
  id: string;                  // PK: UUID v4 (@PrimaryGeneratedColumn('uuid'))
  seriesId: string;            // FK → series.id (CASCADE DELETE)
  episodeNumber: number;       // 회차 번호 (1부터 순차 증가)
  title: string;               // 회차 제목 (VARCHAR 255)
  status: EpisodeStatus;       // PENDING | PROCESSING | DONE | FAILED
  errorMessage: string;        // 파이프라인 실패 시 오류 메시지 (nullable)
  createdAt: Date;
}

enum EpisodeStatus {
  PENDING     = 'PENDING',
  PROCESSING  = 'PROCESSING',
  DONE        = 'DONE',
  FAILED      = 'FAILED',
}
```

### 2.4 `character` / `background` (novelId → seriesId 변경)

- `novelId` 컬럼을 `seriesId`로 리네임 (`string`, FK → series.id)
- 캐릭터·배경은 **series 레벨** 유지 (회차 간 공유)
- `id`: 기존 수동 패턴(`{novelId}_char_{idx}`) → **UUID v4** (`@PrimaryGeneratedColumn('uuid')`)
  - 기존 `character_img.characterId`(FK) 도 UUID string 그대로 호환

### 2.5 `character_img` — 변경 없음

### 2.6 Entity Relationship Diagram

```
user (1) ──────< series (N)
                    │
                    ├──────< episode (N)         [seriesId + episodeNumber UNIQUE]
                    │
                    ├──────< character (N)
                    │             └──────< character_img (N)  [PK: characterId + emotion]
                    │
                    └──────< background (N)
```

---

## 3. S3 구조 변경

```
n2vn-bucket/
└── series/{seriesId}/
    ├── characters/
    │   ├── {charId}_DEFAULT.png
    │   ├── {charId}_DEFAULT_NOBG.png
    │   └── ...
    ├── backgrounds/
    │   └── {bgId}.png
    └── episodes/{episodeNumber}/
        ├── novel.txt          ← 회차 원본 텍스트 (API 업로드)
        └── scenes.json        ← 회차별 씬 파싱 결과
```

---

## 4. 백엔드 API 설계

### 4.1 인증 (`/auth`)

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/auth/register` | 회원가입 (body: email, password, nickname) |
| `POST` | `/auth/login` | 로그인 → JWT 반환 |
| `GET` | `/auth/me` | 내 정보 조회 (JWT 필요) |

- JWT Guard: 보호 라우트에 `@UseGuards(JwtAuthGuard)` 적용
- 비밀번호: bcrypt 해시 저장

### 4.2 Series (`/series`)

| Method | Path | 인증 | 설명 |
|---|---|---|---|
| `GET` | `/series` | 불필요 | 전체 작품 목록 (독자용, 최신 회차 업로드순) |
| `GET` | `/series/mine` | 필요 | 내 작품 목록 (작가용) |
| `POST` | `/series` | 필요 | 새 작품 생성 (body: title, description?) |
| `GET` | `/series/:id` | 불필요 | 작품 상세 + 회차 목록 |
| `GET` | `/series/:id/assets` | 불필요 | 캐릭터·배경 에셋 조회 (S3 URL 포함) |

### 4.3 Episode (`/series/:id/episodes`)

| Method | Path | 인증 | 설명 |
|---|---|---|---|
| `POST` | `/series/:id/episodes` | 필요 (본인) | 회차 추가 + 파이프라인 자동 실행 (multipart: title, file) |
| `GET` | `/series/:id/episodes/:num` | 불필요 | 회차 상세 (status, createdAt) |
| `GET` | `/series/:id/episodes/:num/vn-script` | 불필요 | 비주얼 노벨 스크립트 반환 |
| `DELETE` | `/series/:id/episodes/:num` | 필요 (본인) | 회차 삭제 |

#### 회차 추가 제약
- `episodeNumber = 현재 최대 episodeNumber + 1` (순차 강제)
- PROCESSING 상태의 회차가 이미 있으면 409 Conflict 반환 (중복 업로드 방지)

### 4.4 기존 Parsing / Image API

- 외부 직접 호출 비활성화 (or 내부 전용으로 유지)
- `EpisodePipelineService`가 내부적으로 호출하는 구조로 리팩토링

---

## 5. 자동 파이프라인 (`EpisodePipelineService`)

```
POST /series/:id/episodes
  1. episode 레코드 생성 (status: PROCESSING)
  2. novel.txt → S3 업로드: series/{seriesId}/episodes/{epNum}/novel.txt
  3. 비동기 Fire-and-Forget 파이프라인 시작

  [비동기]
  Step A. 캐릭터 파싱 (기존 series 캐릭터에 병합, 신규만 추가)
  Step B. 배경 파싱 (기존 배경에 병합, 신규만 추가)
  Step C. 씬 파싱 → series/{seriesId}/episodes/{epNum}/scenes.json
            + character_img 플레이스홀더 생성 (신규 감정만)
  Step D. 이미지 생성 (genId=null인 character_img 대상)
  Step E. 배경 이미지 생성 (genId=null인 background 대상)
  Step F. episode.status = DONE

  오류 발생 시: episode.status = FAILED, errorMessage 저장
```

### 캐릭터/배경 파싱 병합 전략

**문제:** LLM 호출마다 동일 캐릭터의 이름이 다르게 추출될 수 있음 (예: "백천" ↔ "사도 백천").
단순 이름 문자열 비교로는 중복을 판별할 수 없음.

**해결:** 캐릭터 파싱 프롬프트에 기존 캐릭터 목록을 함께 전달 → LLM이 **신규 캐릭터만** 반환하도록 지시.

```
캐릭터 파싱 프롬프트 입력:
  novel_text:          현재 회차 소설 텍스트
  existing_characters: "- ID: {uuid}, Name: 백천, Sex: male, Look: ..."
                       "- ID: {uuid}, Name: 설화, Sex: female, Look: ..."

LLM 지시사항 추가:
  - existing_characters에 이미 존재하는 인물(별칭·존칭·호칭이 달라도 동일 인물이면 제외)은 출력하지 말 것.
  - 완전히 새로운 인물만 characters 필드에 포함할 것.
  - 기존 인물이라고 판단한 근거(매핑 관계)를 별도 필드로 반환하지 않아도 됨.
```

**DB 병합 흐름:**
```
1. series의 기존 character 목록 조회
2. existing_characters 문자열로 포맷화하여 프롬프트에 포함
3. LLM 응답 = 신규 캐릭터만 포함된 목록
4. 응답의 각 캐릭터를 UUID 신규 생성하여 INSERT
5. 기존 캐릭터는 건드리지 않음 (look 업데이트도 하지 않음)
```

> 배경도 동일 전략 적용 (existing_backgrounds를 프롬프트에 전달)

---

## 6. 프론트엔드 구조

### 6.1 페이지 구성

| 페이지 | 경로 | 설명 |
|---|---|---|
| 독자 메인 | `/` (index.html) | 전체 작품 리스트 |
| 작품 상세 | `/series.html?id=:id` | 작품 소개 + 회차 목록 |
| VN 플레이어 | 전체화면 모달 | 회차 비주얼 노벨 재생 |
| 내 작품 | `/mine.html` | 작가 관리 화면 |

> SPA 라우팅 없이 정적 HTML 파일 방식 유지 (기존 구조 계승)

### 6.2 독자 화면 — 메인 (`index.html`)

**작품 카드 리스트:**
- 작품 썸네일(캐릭터 DEFAULT 이미지 첫 번째), 제목, 작가, 최신 회차 업로드 일자, 총 회차 수

**정렬 우선순위 (복합 정렬):**
1. 최근 읽은 작품을 상위 (로컬스토리지 `lastReadAt` 기준)
2. 동률 시 최신 회차 업로드일(`latestEpisodeAt`) 기준 내림차순

**탭/필터:**
- 전체 / 최신 업데이트 / 내가 읽은 작품

### 6.3 독자 화면 — 작품 상세 (`series.html`)

- 작품 설명 섹션
- 회차 목록:
  - 회차 번호, 제목, 업로드 날짜
  - **읽은 회차는 회색(opacity 낮춤) 처리** (로컬스토리지 `readEpisodes: {seriesId: [epNum, ...]}`)
  - PROCESSING 상태 회차: "생성 중..." 배지, 클릭 불가
  - FAILED 상태 회차: "생성 실패" 배지
- 회차 클릭 → VN 플레이어 모달 오픈

### 6.4 VN 플레이어 (모달)

- 전체화면 모달 (z-index 최상위, 배경 스크롤 잠금)
- 닫기: ESC 키 또는 우상단 X 버튼
- 닫힐 때 읽기 이력 로컬스토리지 저장
- **커스텀 VN 엔진** (`player.html` + `player.js`) 재사용
  - `player.html`을 iframe으로 임베드, postMessage로 `{ seriesId, episodeNumber }` 전달
  - `player.js`가 `GET /series/:id/episodes/:num/vn-script` 호출 후 엔진 초기화
  - 스크립트 포맷 그대로 유지: `show scene`, `show character`, `hide character`, narrator string, `{ 이름: 대사 }` 객체, `'end'`

### 6.5 작가 화면 (`mine.html`)

**미로그인 시:** 로그인 유도 화면

**내 작품 리스트:**
- 작품별 카드 (제목, 총 회차, 최신 업로드일)
- "+ 새 작품 만들기" 버튼

**작품 상세 (모달 또는 하위 섹션):**
- 에셋 탭: 캐릭터 감정별 이미지 갤러리, 배경 이미지 갤러리
- 회차 탭:
  - 회차 목록 (번호, 제목, 상태 배지, 생성일)
  - "+ 다음 회차 추가" 버튼 (PROCESSING 중이면 비활성화)
  - 회차 삭제 버튼 (확인 다이얼로그 포함)
  - 파이프라인 진행 상태: PROCESSING 중 폴링 (3초 간격, `GET /series/:id/episodes/:num`)
  - **5단계 진행도 표시**: 각 단계별 상태(대기 / 진행 중 / 완료 / 실패)를 스텝 인디케이터로 표시

    ```
    ① 캐릭터 분석  ✓ 완료
    ② 배경 분석    ✓ 완료
    ③ 씬 분석      ⟳ 진행 중
    ④ 캐릭터 이미지 생성  ○ 대기
    ⑤ 배경 이미지 생성    ○ 대기
    ```

  - 단계가 FAILED이면 해당 단계에 오류 표시 + 해당 단계만 재실행 버튼 노출

**회차 추가 흐름:**
1. 제목 입력 + 텍스트 파일(.txt) 업로드 폼
2. 업로드 클릭 → `POST /series/:id/episodes` (multipart/form-data)
3. 즉시 "생성 중..." 상태 표시, 폴링 시작
4. DONE/FAILED 전환 시 배지 업데이트

---

## 7. 인증 전략

- **JWT (Access Token):** 만료 24시간, Authorization 헤더 Bearer 방식
- **프론트엔드 저장:** `localStorage.token`
- **로그인:** `loginId` + `password` 조합으로 인증
- **회원가입 입력 필드:** loginId (영문/숫자, UNIQUE), email, password, nickname
- **로그인 UI:** 헤더 우상단 로그인/로그아웃 버튼 (index.html, mine.html 공통)
- 회원가입·로그인은 모달 또는 별도 `login.html`

---

## 8. 기존 문제 해결 현황

| # | 기존 문제 | 이번 버전에서 해결 여부 |
|---|---|---|
| 1 | N+1 쿼리 (getNovelAssets) | 함께 수정 (In 단일 쿼리화) |
| 3 | synchronize: true | 마이그레이션 도입으로 해결 |
| 4 | 이미지 생성 진행 상황 추적 불가 | 5단계 개별 진행도 폴링으로 완전 해결 |
| 6 | novel.txt 수동 S3 업로드 | 회차 업로드 API로 완전 해결 |

---

## 9. 구현 단계 (Phase)

### Phase 1 — 백엔드 기반 (우선)
1. TypeORM 마이그레이션 도입, `novel` → `series` 리네임, `episode` 테이블 추가
2. `user` 테이블 + JWT 인증 모듈 구현
3. Series CRUD API 구현
4. Episode 추가/삭제 API + `EpisodePipelineService` 구현
5. `getVnScript`를 episode 레벨로 수정 (`/series/:id/episodes/:num/vn-script`)

### Phase 2 — 프론트엔드
6. 독자 메인 (`index.html`) — 작품 목록, 정렬, 로그인 헤더
7. 작품 상세 (`series.html`) — 회차 목록, 읽기 이력, VN 플레이어 모달
8. 작가 관리 (`mine.html`) — 내 작품, 회차 추가, 파이프라인 폴링

### Phase 3 — 완성도
9. 에러 핸들링 (파이프라인 FAILED 재시도, API 에러 토스트)
10. UI 정교화 (로딩 스피너, 반응형)
