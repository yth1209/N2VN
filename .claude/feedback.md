# N2VN Feedback — Monogatari 비주얼 노벨 플레이어 통합

> **검토 대상**: [plan.md](plan.md) · [development.md](development.md)  
> **작성일**: 2026-04-19

---

## 요약

전체적인 설계 방향과 변환 로직은 타당하다. 다만 아래 항목들이 구현 전 또는 구현 중 리스크가 될 수 있으므로 우선순위별로 정리한다.

---

## 🔴 Critical (구현 전 반드시 확인)

### 1. Monogatari v2 alpha — 실제 API 존재 여부 불확실

`development.md §6`에서 사용하는 `Monogatari.default`, `monogatari.characters()`, `monogatari.assets('scenes', ...)`, `monogatari.script({ 'main': ... })` 메서드 시그니처는 **v2.0.0-alpha.10 기준 검증되지 않은 가정**이다.

- Monogatari v2 alpha는 공개 문서가 부족하고 API가 버전마다 크게 다름
- 실제로는 `Monogatari.init()` 이전에 전역 배열 `Script`, `Characters`, `Assets` 를 직접 조작하는 방식이거나, v1 방식과 혼용일 가능성 있음
- `monogatari.element().find('[data-action="new"]').trigger('click')` 체이닝도 jQuery 없이는 동작하지 않을 수 있음

**권장 조치**: `vn.html`을 먼저 로컬에서 단독으로 열어 `Monogatari.default`가 실제로 존재하는지, 어떤 메서드를 노출하는지 콘솔에서 확인한 뒤 `vn.js` 구현을 진행한다. 필요 시 v1 문서 기반 방식(`window.script`, `window.characters` 전역 수정)으로 대체.

---

### 2. Monogatari에서 절대 URL 스프라이트 지원 여부

`development.md §6` 주의사항에서 `directory: ''` 설정으로 절대 URL이 동작할 것을 가정하지만, Monogatari는 내부적으로 `assets/` 기준 상대 경로로 이미지를 처리한다.

- S3 절대 URL을 `sprites` 값으로 직접 넘기면 **경로가 무시되거나 404 발생** 가능성이 있음
- `directory: ''` 옵션이 v2 alpha에 존재하는지도 불확실

**권장 조치**: 스프라이트 1개로 최소 테스트 케이스를 먼저 작성하여 절대 URL 방식이 실제로 렌더링되는지 검증. 안 될 경우 Monogatari 대신 자체 Canvas/DOM 기반 VN 렌더러로 대안 검토.

---

## 🟡 Warning (구현 품질에 영향)

### 3. `isEntry` / `isExit` LLM 생성 신뢰도

LLM이 `isEntry`/`isExit`를 정확하게 생성한다고 보장할 수 없다.

- 같은 씬에서 캐릭터가 잠시 사라졌다 재등장하는 경우 처리 불명확
- 한 캐릭터의 대사가 연속으로 반복될 때 `isEntry: true`가 여러 번 나올 수 있음
- `isExit: true`인데 이후 같은 씬에 동일 캐릭터가 다시 등장하는 LLM 오류 가능

`buildMonogatariScript()`의 현재 로직은 `isEntry`를 그대로 신뢰하므로, LLM 오류 시 동일 캐릭터에 대해 `show character`가 중복 실행된다.

**권장 조치**: `onScreen` Map 기준으로 이미 화면에 있는 캐릭터에 `isEntry: true`가 오면 무시하거나, 위치/감정 변경으로 처리하는 방어 로직 추가.

```typescript
// isEntry가 true여도 이미 onScreen에 있으면 위치/감정 변화로 처리
if (entry && !onScreen.has(characterId)) {
  script.push(`show character ${characterId} ${emo} ${pos}`);
  onScreen.set(characterId, { emotion: emo, position: pos });
} else if (onScreen.has(characterId)) {
  // 감정/위치 변화 체크
  ...
}
```

---

### 4. `S3HelperService.readJson()` 메서드 존재 여부 확인 필요

`development.md §3-2`에서 `this.s3Helper.readJson(...)` 호출을 가정하는데, 현재 `s3-helper.service.ts`에 해당 메서드가 실제로 구현되어 있는지 확인이 필요하다.

**권장 조치**: `structure.md` 또는 `s3-helper.service.ts` 소스를 직접 확인 후, 없으면 `getObject()` 기반으로 직접 파싱하는 인라인 코드로 대체.

---

### 5. `novelId` 타입 불일치 가능성

`novel.controller.ts`에서 `@Param('id') id: string`을 `Number(id)`로 변환 후 `repo.character.find({ where: { novelId: id } })`에 넘기는데, `character` 엔티티의 `novelId` 컬럼이 `number` 타입이면 문제없지만 `string`이면 조회 결과가 빈 배열로 올 수 있다.

**권장 조치**: 기존 `getAssets()` 메서드의 타입 처리 방식을 그대로 따른다.

---

### 6. iframe `src` 재지정 방식의 깜빡임

`sendNovelIdToVnPlayer()`에서 소설 변경 시마다 `vnIframeEl.src = 'vn.html'`로 iframe을 리로드하면, 소설 전환 때마다 Monogatari 전체가 재로드되면서 로딩 화면이 다시 표시된다.

소설이 5~10개 이상이거나 네트워크가 느린 환경에서는 UX가 나쁠 수 있다.

**현재 판단**: plan.md §2-4에서 "iframe 리로드 방식으로 Monogatari 재초기화 문제를 근본적으로 회피"하기로 결정했으므로 허용 가능한 트레이드오프. **다만 로딩 오버레이 UX는 충분히 매끄럽게 구현되어야 한다.**

---

### 7. CORS — S3 이미지 직접 참조

Monogatari가 `<img>` 태그로 S3 URL을 직접 로드할 때, S3 버킷에 CORS 정책이 설정되어 있지 않으면 브라우저에서 이미지가 차단될 수 있다.

**권장 조치**: S3 버킷 CORS 설정에 프론트엔드 오리진(`http://localhost:*`, 배포 도메인)을 허용하는 규칙이 있는지 확인.

---

## 🟢 Minor (향후 개선 고려)

### 8. BGM 미구현 주석 처리

`buildMonogatariScript()`에서 BGM 관련 명령이 완전히 제외되어 있는 것은 맞지만, `scene_prompt`에는 여전히 `bgm_prompt` 필드가 생성된다. 나중에 BGM 파이프라인 추가 시 이 필드를 재활용할 수 있으므로 현재 상태 유지는 적절하다.

---

### 9. Visual Novel 탭 기본 상태 (소설 미선택 시)

VN 탭을 소설 선택 전에 클릭하면 `currentNovelId`가 없어 `sendNovelIdToVnPlayer()`가 호출되지 않고 `vn.html`이 로딩 오버레이 상태로 멈춘다.

**권장 조치**: VN 탭 전환 시 `currentNovelId`가 없으면 "소설을 먼저 선택해 주세요" 메시지를 iframe 내 오버레이에 표시하거나, 탭 자체를 비활성(disabled) 처리.

---

### 10. `app.js` `activeTab` 변수 스코프 확인

`development.md §8 변경사항 4`에서 `if (activeTab === 'vn')`를 참조하는데, `activeTab`이 `selectNovel()` 함수 스코프에서 접근 가능한 변수인지 확인이 필요하다. 현재 `app.js` 구조에서 `activeTab`이 모듈 최상단 전역 변수로 관리되고 있다면 문제없다.

---

## 구현 순서 재검토

development.md의 권장 순서(§1→§2→…→§9)는 적절하다. 다만 **리스크 1·2(Monogatari API 검증)는 §5·§6 작업 시작 전에 별도로 먼저 진행**하는 것을 강력히 권장한다. 백엔드를 모두 완성한 뒤 프론트엔드에서 Monogatari API 호환성 문제가 발견되면 전체 프론트엔드 구현을 다시 짜야 할 수 있다.

**수정 권장 순서**:
```
1. [사전] vn.html + unpkg CDN만으로 Monogatari v2 alpha 동작 최소 검증
2. § 1 novel-parsing.service.ts — sceneSchema 수정
3. § 2 prompt/prompt.ts — scene_prompt 수정
4. § 3-2, §4 novel.service.ts — getVnScript() + buildMonogatariScript()
5. § 3-1 novel.controller.ts — 라우트 등록
6. § 3-3 novel.module.ts — S3HelperService 확인
7. § 6 frontend/vn.js — 검증된 Monogatari API 기반으로 작성
8. § 5 frontend/vn.html — 최종화
9. § 7 frontend/index.html — 탭 + iframe 추가
10. § 8 frontend/app.js — postMessage 연동
```
