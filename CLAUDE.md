# CLAUDE.md
이 파일은 이 저장소에서 작업할 때 Claude Code(claude.ai/code)에게 제공되는 가이드입니다.

## 페르소나
너는 서버 및 프론트 개발 전문가야.

## CLAUDE CODE Workflow
Harness Engineering을 사용하며 workflow 문서는 `.claude/` 폴더에서 관리한다.
- [.claude/proposal.md](.claude/proposal.md) — 사용자가 입력한 요구사항 요약
- [.claude/plan.md](.claude/plan.md) — proposal.md를 보고 작성한 상세 기획서
- [.claude/development.md](.claude/development.md) — plan.md를 보고 작성한 개발 상세 기획서
- [.claude/feedback.md](.claude/feedback.md) — plan.md와 development.md를 보고 작성한 피드백 문서
- [.claude/future.md](.claude/future.md) — 추후 도입 예정 기능 리스트
- [.claude/structure.md](.claude/structure.md) — DB 스키마, 파이프라인 상세, 아키텍처 분석

사용자가 `.claude/proposal.md`를 수정하면 `plan.md`를 업데이트하고, `plan.md`를 수정하면 `development.md`를 업데이트하고, `development.md`를 수정하면 `feedback.md`를 업데이트한다.

---

## 프로젝트 개요

**N2VN**: 텍스트 소설을 입력받아 캐릭터 일러스트·배경 이미지·BGM 프롬프트·대화 스크립트가 결합된 비주얼 노벨 형식으로 자동 변환하는 시스템.

---

## 기술 스택

| 영역 | 기술 |
|---|---|
| 프레임워크 | NestJS 11 (TypeScript) |
| 데이터베이스 | MariaDB (AWS RDS) via TypeORM 0.3 |
| LLM | Google Gemini 2.5 Flash (via LangChain) |
| 이미지 생성 | Leonardo AI REST API (Flux Pro 2.0) |
| 클라우드 스토리지 | AWS S3 |
| 스키마 검증 | Zod |

---

## 디렉토리 구조

```
backend/
├── src/
│   ├── common/
│   │   ├── constants.ts               # Emotion·StyleKey enum, STYLE_UUIDS 매핑
│   │   ├── repository.provider.ts     # TypeORM Repository 중앙화 Provider
│   │   └── s3-helper.service.ts       # AWS S3 CRUD 헬퍼
│   ├── entities/                      # TypeORM 엔티티 (novel / character / character_img / background)
│   ├── novel/                         # 소설 CRUD 모듈
│   ├── parsing/                       # LLM 파싱 파이프라인 모듈
│   │   └── prompt/prompt.ts           # character·background·scene용 프롬프트 템플릿
│   └── image/                         # 이미지 생성 파이프라인 모듈
│       └── prompt/prompt.ts           # 캐릭터 이미지용 SD 프롬프트 생성기
├── .env
└── api_test.http
```

---

## API 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/novels` | 소설 목록 조회 |
| `POST` | `/novels` | 소설 생성 (body: `novelTitle`) |
| `GET` | `/novels/:id/assets` | 소설 에셋 조회 (S3 URL 포함) |
| `POST` | `/parsing/characters` | LLM으로 캐릭터 파싱 (body: `novelId`) |
| `POST` | `/parsing/backgrounds` | LLM으로 배경 파싱 (body: `novelId`) |
| `POST` | `/parsing/scenes` | LLM으로 씬 파싱 (body: `novelId`) |
| `POST` | `/images/characters` | 캐릭터 이미지 생성 시작 (body: `novelId`) |
| `POST` | `/images/backgrounds` | 배경 이미지 생성 시작 (body: `novelId`) |

---

## 전체 파이프라인 흐름

```
[사전] S3의 {novelId}/novel.txt 에 소설 텍스트 업로드

Step 1: POST /novels               -> novel 레코드 생성 (novelId 획득)
Step 2: POST /parsing/characters   -> Gemini 분석 -> character 레코드 생성
Step 3: POST /parsing/backgrounds  -> Gemini 분석 -> background 레코드 생성
Step 4: POST /parsing/scenes       -> Gemini 분석 -> scenes.json을 S3 저장
                                      + character_img 플레이스홀더 생성 (genId=null)
Step 5: POST /images/characters    -> Leonardo AI로 캐릭터 이미지 생성
                                      (DEFAULT 먼저 -> 나머지 감정 병렬, NOBG 포함)
Step 6: POST /images/backgrounds   -> Leonardo AI로 배경 이미지 생성
Step 7: GET  /novels/:id/assets    -> 모든 에셋 S3 URL 반환 -> 프론트엔드 렌더링
```

> 상세 구조(DB 스키마, 모듈별 로직, 알려진 버그)는 [.claude/structure.md](.claude/structure.md) 참조.
