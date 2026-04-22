# Future — 추후 도입 예정 기능

> 현재 구현 범위 밖이지만 추후 추가할 기능 목록.

---

## BGM 생성 파이프라인

**배경:** 씬 파싱 시 `bgm_prompt` 필드(BGM 생성용 영문 프롬프트)는 이미 추출되고 있으나, 실제 음원 파일 생성 파이프라인이 미구현 상태. 현재 Monogatari 플레이어에서는 BGM 없이 동작.

**구현 방향:**
- BGM 생성 AI API 연동 (예: Suno, Udio 등)
- `POST /audio/bgm` 엔드포인트 추가 — `bgm_prompt`를 입력으로 음원 생성 후 S3 업로드
- `background` 테이블 또는 별도 `bgm` 테이블에 생성된 음원 ID/URL 저장
- Monogatari 스크립트 변환 시 `play music {bgmId}` 명령 삽입
