# N2VN Development — 구현 상세 명세

> **기반 문서**: [plan.md](plan.md) · [structure.md](structure.md)  
> **목표**: Monogatari 비주얼 노벨 플레이어 통합

---

## 목차

1. [Backend — sceneSchema 수정 (`isEntry`, `isExit`, `position`)](#1-backend--sceneschema-수정)
2. [Backend — scene_prompt 수정](#2-backend--scene_prompt-수정)
3. [Backend — `GET /novels/:id/vn-script` 엔드포인트](#3-backend--get-novelsidvn-script-엔드포인트)
4. [Backend — scenes.json → Monogatari 변환 로직](#4-backend--scenesjson--monogatari-변환-로직)
5. [Frontend — `vn.html` 생성](#5-frontend--vnhtml-생성)
6. [Frontend — `vn.js` 생성](#6-frontend--vnjs-생성)
7. [Frontend — `index.html` Visual Novel 탭 추가](#7-frontend--indexhtml-visual-novel-탭-추가)
8. [Frontend — `app.js` postMessage 연동](#8-frontend--appjs-postmessage-연동)

---

## 1. Backend — sceneSchema 수정

**파일**: `backend/src/parsing/novel-parsing.service.ts`  
**위치**: `extractScenesMetadata()` 내 `sceneSchema` 정의부 (현재 162~170 라인)

현재 `dialogues` 배열의 각 항목에 `isEntry`, `isExit`, `position` 3개 필드를 추가한다.

### 변경 전 (현재 코드)

```typescript
dialogues: z.array(z.object({
  characterId: z.string()...,
  dialog: z.string()...,
  action: z.enum(['IDLE', 'ATTACK', 'SHAKE'])...,
  emotion: z.nativeEnum(Emotion)...,
  look: z.string()...
}))
```

### 변경 후

```typescript
dialogues: z.array(z.object({
  characterId: z.string().describe("화자의 고유 ID (characters_info 참고. 예: 1_char_1). 나레이션인 경우 'narrator'"),
  dialog: z.string().describe("대사 또는 서술 내용 문장 원문 (번역 금지)"),
  action: z.enum(['IDLE', 'ATTACK', 'SHAKE']).describe("화자의 행동/동작 (반드시 다음 중 한 가지만 선택: IDLE, ATTACK, SHAKE)"),
  emotion: z.nativeEnum(Emotion).describe(`화자의 감정 (반드시 다음 중 한 가지만 선택: ${Object.values(Emotion).join(', ')})`),
  look: z.string().describe("화자의 표정이나 드러나는 외모를 묘사하는 짧은 영어 구문 (알 수 없으면 'unknown')"),
  isEntry: z.boolean().describe("이 대사가 해당 캐릭터의 씬 내 첫 번째 등장인 경우 true. narrator는 항상 false"),
  isExit: z.boolean().describe("이 대사가 해당 캐릭터가 씬에서 마지막으로 말하는 대사인 경우 true. narrator는 항상 false"),
  position: z.enum(['left', 'center', 'right']).describe("캐릭터의 화면 위치. 캐릭터 혼자 화면에 있으면 center. 두 명 이상이 동시에 화면에 있으면 left/right로 자연스럽게 배치. narrator는 center"),
})).describe("이 씬에 포함되는 모든 대사와 나레이션을 순서대로 담은 배열")
```

> **주의**: `sceneSchema` 변경 후 기존 S3의 `scenes.json`은 새 필드가 없는 구버전이므로, 변환 로직에서 `isEntry`/`isExit`/`position`이 없는 경우를 방어적으로 처리해야 한다 (아래 §4 참조).

---

## 2. Backend — scene_prompt 수정

**파일**: `backend/src/parsing/prompt/prompt.ts`  
**위치**: `scene_prompt` 상수의 `[CRITICAL INSTRUCTIONS]` 블록 하단

### 추가할 지시사항 (기존 마지막 줄 아래에 삽입)

```
- isEntry / isExit rules:
  * Set isEntry: true on the FIRST dialogue line of a character within a scene.
  * Set isExit: true on the LAST dialogue line of a character within a scene.
  * A single-line character (appears once in a scene) has both isEntry AND isExit both true.
  * narrator always has isEntry: false and isExit: false.
- position rules:
  * If only one character is currently on screen: position = "center".
  * If two or more characters are simultaneously on screen (between their isEntry and isExit), assign "left" or "right" based on natural conversation flow (typically the main speaker is "right", the listener is "left", but use narrative context).
  * narrator always has position = "center".
```

### 최종 `scene_prompt` 끝부분 형태

```typescript
export const scene_prompt = `
...
[CRITICAL INSTRUCTIONS]
- For character dialogues: Ensure NO dialogue is skipped. Retain the exact original language for the "dialog" field.
- For narrations/descriptions (characterId: "narrator"): EXCLUDE purely visual descriptions...
- Do NOT translate names. Use the original character names from the text.
- Provide "action", "emotion", "look", and "bgm_prompt" ONLY in English.
- isEntry / isExit rules:
  * Set isEntry: true on the FIRST dialogue line of a character within a scene.
  * Set isExit: true on the LAST dialogue line of a character within a scene.
  * A single-line character (appears once in a scene) has both isEntry AND isExit both true.
  * narrator always has isEntry: false and isExit: false.
- position rules:
  * If only one character is currently on screen: position = "center".
  * If two or more characters are simultaneously on screen (between their isEntry and isExit), assign "left" or "right" based on natural conversation flow.
  * narrator always has position = "center".
...
"""`;
```

---

## 3. Backend — `GET /novels/:id/vn-script` 엔드포인트

### 3-1. `novel.controller.ts` — 라우트 등록

**파일**: `backend/src/novel/novel.controller.ts`

기존 `@Get(':id/assets')` 아래에 추가:

```typescript
@Get(':id/vn-script')
async getVnScript(@Param('id') id: string) {
  const data = await this.novelService.getVnScript(Number(id));
  return {
    success: true,
    data,
  };
}
```

### 3-2. `novel.service.ts` — `getVnScript()` 메서드

**파일**: `backend/src/novel/novel.service.ts`

`NovelService`에 `S3HelperService` 의존성을 추가하고, `getVnScript()` 메서드를 구현한다.

#### 생성자 수정

현재 생성자:
```typescript
constructor(
  private readonly repo: RepositoryProvider,
  private readonly configService: ConfigService,
) {}
```

변경 후:
```typescript
constructor(
  private readonly repo: RepositoryProvider,
  private readonly configService: ConfigService,
  private readonly s3Helper: S3HelperService,
) {}
```

`S3HelperService` 및 TypeORM `In` import 추가:
```typescript
import { S3HelperService } from '../common/s3-helper.service';
import { In } from 'typeorm';
```

#### `getVnScript()` 메서드 전체 구현

```typescript
async getVnScript(id: number) {
  const novel = await this.repo.novel.findOne({ where: { id } });
  if (!novel) throw new HttpException('Novel not found', HttpStatus.NOT_FOUND);

  const bucket = this.configService.get<string>('AWS_S3_BUCKET_NAME');
  const region = this.configService.get<string>('AWS_REGION');
  const baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;

  // 1. S3에서 scenes.json 읽기
  const scenesData = await this.s3Helper.readJson(`${id}/scenes.json`);

  // 2. DB에서 캐릭터, 배경, 캐릭터 이미지 조회 (단일 쿼리로 N+1 방지)
  const characters = await this.repo.character.find({ where: { novelId: id } });
  const backgrounds = await this.repo.background.find({ where: { novelId: id } });

  const charIds = characters.map(c => c.id);
  const allImages = charIds.length
    ? await this.repo.characterImg.find({ where: { characterId: In(charIds) } })
    : [];

  // characterId 기준으로 그룹화
  const imagesByChar = new Map<string, typeof allImages>();
  for (const img of allImages) {
    if (!imagesByChar.has(img.characterId)) imagesByChar.set(img.characterId, []);
    imagesByChar.get(img.characterId)!.push(img);
  }

  // 3. 캐릭터별 스프라이트 맵 구성 (emotion -> NOBG URL)
  const characterMap: Record<string, { name: string; sprites: Record<string, string> }> = {};
  for (const char of characters) {
    const images = imagesByChar.get(char.id) ?? [];
    const sprites: Record<string, string> = {};
    for (const img of images) {
      if (img.nobgGenId) {
        // NOBG 이미지 우선 사용
        sprites[img.emotion] = `${baseUrl}/${id}/characters/${char.id}_${img.emotion}_NOBG.png`;
      } else if (img.genId) {
        // NOBG 없으면 원본 이미지로 폴백
        sprites[img.emotion] = `${baseUrl}/${id}/characters/${char.id}_${img.emotion}.png`;
      }
    }
    characterMap[char.id] = { name: char.name, sprites };
  }

  // 4. 배경 맵 구성 (bgId -> URL)
  const sceneMap: Record<string, string> = {};
  for (const bg of backgrounds) {
    if (bg.genId) {
      sceneMap[bg.id] = `${baseUrl}/${id}/backgrounds/${bg.id}.png`;
    }
  }

  // 5. scenes.json -> Monogatari script 변환
  const script = buildMonogatariScript(scenesData.scenes, characterMap);

  return { characters: characterMap, scenes: sceneMap, script };
}
```

### 3-3. `novel.module.ts` — S3HelperService 추가 확인

`novel.module.ts`에서 `S3HelperService`가 providers에 포함되어 있는지 확인하고 없으면 추가한다:

```typescript
import { S3HelperService } from '../common/s3-helper.service';

@Module({
  imports: [TypeOrmModule.forFeature([Novel, Character, CharacterImg, Background])],
  controllers: [NovelController],
  providers: [NovelService, RepositoryProvider, S3HelperService],
})
export class NovelModule {}
```

---

## 4. Backend — scenes.json → Monogatari 변환 로직

**파일**: `backend/src/novel/novel.service.ts` (같은 파일 내 독립 함수로 배치, 클래스 외부)

### `buildMonogatariScript()` 함수 전체 구현

```typescript
type VnCharacterMap = Record<string, { name: string; sprites: Record<string, string> }>;
type MonogatariCommand = string | Record<string, string>;

function buildMonogatariScript(
  scenes: any[],
  characterMap: VnCharacterMap,
): MonogatariCommand[] {
  const script: MonogatariCommand[] = [];

  for (const scene of scenes) {
    // 씬 시작: 배경 전환
    script.push(`show scene ${scene.backgroundId} with fade`);

    // 현재 씬에서 화면에 있는 캐릭터 추적 (charId -> { emotion, position })
    const onScreen = new Map<string, { emotion: string; position: string }>();

    for (const dialogue of scene.dialogues) {
      const { characterId, dialog, emotion, isEntry, isExit, position } = dialogue;

      // isEntry/isExit/position 방어 처리 (구버전 scenes.json 대응)
      const entry = isEntry    ?? false;
      const exit  = isExit     ?? false;
      const pos   = position   ?? 'center';
      const emo   = emotion    ?? 'DEFAULT';

      if (characterId === 'narrator' || characterId === 'unknown') {
        // 나레이션: 문자열 형태로 추가
        script.push(dialog);
        continue;
      }

      const charMeta = characterMap[characterId];
      const charName = charMeta?.name ?? characterId;

      // 캐릭터 첫 등장 (show character)
      if (entry) {
        script.push(`show character ${characterId} ${emo} ${pos}`);
        onScreen.set(characterId, { emotion: emo, position: pos });
      } else if (onScreen.has(characterId)) {
        // 동일 씬 내 감정 또는 위치가 실제로 바뀐 경우에만 재렌더링
        // (변화 없이 매 대사마다 show를 반복하면 Monogatari에서 불필요한 깜빡임 발생)
        const prev = onScreen.get(characterId)!;
        if (prev.emotion !== emo || prev.position !== pos) {
          script.push(`show character ${characterId} ${emo} ${pos}`);
          onScreen.set(characterId, { emotion: emo, position: pos });
        }
      }

      // 대사
      script.push({ [charName]: dialog });

      // 캐릭터 퇴장 (hide character)
      if (exit) {
        script.push(`hide character ${characterId}`);
        onScreen.delete(characterId);
      }
    }

    // 씬 종료 시 아직 화면에 남아있는 캐릭터 정리 (isExit 누락 방어)
    for (const charId of onScreen.keys()) {
      script.push(`hide character ${charId}`);
    }
    onScreen.clear();
  }

  script.push('end');
  return script;
}
```

### 변환 규칙 요약

| 조건 | 생성되는 명령 | 예시 |
|---|---|---|
| 씬 시작 | `show scene {bgId} with fade` | `show scene 1_bg_1 with fade` |
| BGM | ~~`play music {bgmId}`~~ | **미구현** — BGM 생성 파이프라인 미완성으로 이번 버전 제외 |
| `isEntry: true` (첫 등장) | `show character {id} {emotion} {pos}` → 대사 | `show character 1_char_1 DEFAULT center` |
| 동일 씬 내 감정/위치 **실제 변화** 시 | `show character {id} {emotion} {pos}` → 대사 | `show character 1_char_1 SMILE right` |
| `isExit: true` (마지막) | 대사 → `hide character {id}` | `hide character 1_char_1` |
| narrator / unknown | `'{dialog}'` 문자열 | `'밤이 깊어갔다.'` |
| 캐릭터 대사 | `{ '{name}': '{dialog}' }` | `{ '백무진': '흥!' }` |
| 씬 종료 후 화면 잔류 캐릭터 | `hide character {id}` | - |
| 전체 마지막 | `'end'` | - |

### 반환 JSON 구조 예시

```json
{
  "characters": {
    "1_char_1": {
      "name": "백무진",
      "sprites": {
        "DEFAULT": "https://.../_DEFAULT_NOBG.png",
        "SMILE":   "https://.../_SMILE_NOBG.png",
        "ANGRY":   "https://.../_ANGRY_NOBG.png"
      }
    }
  },
  "scenes": {
    "1_bg_1": "https://.../backgrounds/1_bg_1.png",
    "1_bg_2": "https://.../backgrounds/1_bg_2.png"
  },
  "script": [
    "show scene 1_bg_1 with fade",
    "show character 1_char_1 DEFAULT center",
    { "백무진": "어디 한 번 덤벼보거라." },
    "show character 1_char_2 SERIOUS left",
    "show character 1_char_1 SMILE right",
    { "백무진": "흥." },
    { "진소룡": "..." },
    "hide character 1_char_1",
    "hide character 1_char_2",
    "end"
  ]
}
```

---

## 5. Frontend — `vn.html` 생성

**파일**: `frontend/vn.html` (신규 생성)

Monogatari v2를 CDN으로 로드하고, API 데이터를 동적으로 주입받아 플레이어를 초기화하는 단독 페이지.

### Monogatari v2 CDN 주소

```
https://unpkg.com/@monogatari/core@2.0.0-alpha.10/dist/monogatari.min.js
https://unpkg.com/@monogatari/core@2.0.0-alpha.10/dist/monogatari.css
```

> v2.0.0-alpha.10이 현재 가장 안정적인 alpha 버전. stable 출시 시 버전 고정값 변경 필요.

### `vn.html` 전체 구조

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>N2VN Player</title>
  <link rel="stylesheet" href="https://unpkg.com/@monogatari/core@2.0.0-alpha.10/dist/monogatari.css">
  <style>
    html, body {
      margin: 0; padding: 0;
      width: 100%; height: 100%;
      background: #000;
      overflow: hidden;
    }
    #monogatari {
      width: 100%;
      height: 100%;
    }
    #loading-overlay {
      position: fixed;
      inset: 0;
      background: #0d0d0d;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-family: sans-serif;
      z-index: 9999;
    }
    #loading-overlay.hidden { display: none; }
    #loading-text { margin-top: 16px; font-size: 0.9rem; color: #888; }
  </style>
</head>
<body>
  <div id="loading-overlay">
    <div style="font-size: 2rem;">⏳</div>
    <div id="loading-text">소설 데이터를 불러오는 중...</div>
  </div>

  <div id="monogatari">
    <div data-ui="screen" data-screen="game"></div>
  </div>

  <script src="https://unpkg.com/@monogatari/core@2.0.0-alpha.10/dist/monogatari.min.js"></script>
  <script src="vn.js"></script>
</body>
</html>
```

---

## 6. Frontend — `vn.js` 생성

**파일**: `frontend/vn.js` (신규 생성)

`postMessage`로 `novelId`를 수신한 뒤 `GET /novels/:id/vn-script`를 호출하고, 응답 데이터로 Monogatari를 초기화한다.

### `vn.js` 전체 구현

```javascript
const BASE_URL = 'http://localhost:3000';

// postMessage로 novelId 수신 대기
window.addEventListener('message', async (event) => {
  // origin 검증: 같은 출처에서 온 메시지만 처리
  if (event.origin !== window.location.origin) return;

  const novelId = event.data?.novelId;
  if (!novelId) return;

  const overlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');

  overlay.classList.remove('hidden');
  loadingText.textContent = `소설 #${novelId} 데이터를 불러오는 중...`;

  try {
    const res = await fetch(`${BASE_URL}/novels/${novelId}/vn-script`);
    const result = await res.json();

    if (!result.success) {
      loadingText.textContent = '데이터 로드 실패: ' + (result.message ?? 'Unknown error');
      return;
    }

    initMonogatari(result.data);
  } catch (err) {
    console.error('VN script fetch error:', err);
    loadingText.textContent = '서버 연결 실패';
  }
});

function initMonogatari({ characters, scenes, script }) {
  const monogatari = Monogatari.default;

  // 캐릭터 등록
  // sprites 값에 절대 URL이 있으므로 directory는 빈 문자열 사용
  for (const [charId, charData] of Object.entries(characters)) {
    monogatari.characters({
      [charId]: {
        name: charData.name,
        sprites: charData.sprites,
        directory: '',
      }
    });
  }

  // 배경 등록 (scene 명령에서 키로 참조됨)
  monogatari.assets('scenes', scenes);

  // 스크립트 등록
  monogatari.script({ 'main': script });

  // 엔진 설정
  monogatari.settings({
    'game-name': 'N2VN Visual Novel',
    'engine-version': '2.0.0-alpha.10',
    'force-load': false,
    'skip-unseen': false,
  });

  // 초기화 및 새 게임 시작
  monogatari.init('#monogatari').then(() => {
    document.getElementById('loading-overlay').classList.add('hidden');
    monogatari.element().find('[data-action="new"]').trigger('click');
  }).catch(err => {
    console.error('Monogatari init error:', err);
    document.getElementById('loading-text').textContent = '플레이어 초기화 실패';
  });
}
```

### 주의사항

- Monogatari v2의 `sprites`에 절대 URL을 사용할 때 `directory: ''`로 설정해야 경로 중복 없이 그대로 사용된다. 실제 동작은 버전에 따라 다를 수 있으므로 테스트 필수.
- `2.0.0-alpha.10`은 unstable 버전이므로 `Monogatari.default` 진입점, `monogatari.characters()` / `monogatari.assets()` / `monogatari.script()` 메서드 시그니처, `element().find().trigger()` 체이닝이 실제로 동작하는지 사전 검증이 필요하다. `vn.html`을 단독으로 열어 콘솔에서 `Monogatari.default` 구조를 먼저 확인한다.
- 소설 재선택은 `app.js`에서 iframe을 `src` 재지정으로 리로드하는 방식으로 처리한다 (§8 변경사항 3 참조). `vn.js` 자체는 페이지 로드 시 최초 1회만 초기화된다고 가정하면 된다.

---

## 7. Frontend — `index.html` Visual Novel 탭 추가

**파일**: `frontend/index.html`

### 변경사항 1 — 탭 추가 (28~31 라인 `<div class="tabs">` 내부)

```html
<!-- 변경 전 -->
<div class="tabs">
  <div class="tab active" data-tab="characters">Characters</div>
  <div class="tab" data-tab="backgrounds">Backgrounds</div>
</div>

<!-- 변경 후 -->
<div class="tabs">
  <div class="tab active" data-tab="characters">Characters</div>
  <div class="tab" data-tab="backgrounds">Backgrounds</div>
  <div class="tab" data-tab="vn">Visual Novel</div>
</div>
```

### 변경사항 2 — VN 뷰 컨테이너 추가 (`backgrounds-view` div 바로 아래)

```html
<!-- 기존 -->
<div id="backgrounds-view" class="gallery-grid" style="display: none;">
  <!-- Background cards will be loaded here -->
</div>

<!-- 추가 -->
<div id="vn-view" style="display: none; width: 100%; height: 600px;">
  <iframe
    id="vn-iframe"
    src="vn.html"
    style="width: 100%; height: 100%; border: none; border-radius: 8px;"
    allow="autoplay"
  ></iframe>
</div>
```

> iframe 높이 600px은 초기 기본값이며, CSS로 `content-viewer` 높이에 맞게 조정 가능하다.

---

## 8. Frontend — `app.js` postMessage 연동

**파일**: `frontend/app.js`

### 변경사항 1 — 전역 변수에 VN 뷰 엘리먼트 추가 (상단 DOM Elements 섹션)

```javascript
// 기존 (9 라인)
const backgroundsViewEl = document.getElementById('backgrounds-view');

// 추가
const vnViewEl   = document.getElementById('vn-view');
const vnIframeEl = document.getElementById('vn-iframe');
```

### 변경사항 2 — `setupEventListeners()` 탭 전환 로직 수정 (79~88 라인)

```javascript
// 변경 전
if (activeTab === 'characters') {
  charactersViewEl.style.display = 'grid';
  backgroundsViewEl.style.display = 'none';
} else {
  charactersViewEl.style.display = 'none';
  backgroundsViewEl.style.display = 'grid';
}

// 변경 후
if (activeTab === 'characters') {
  charactersViewEl.style.display = 'grid';  // 'block'이 아닌 'grid' 유지
  backgroundsViewEl.style.display = 'none';
  vnViewEl.style.display = 'none';
} else if (activeTab === 'backgrounds') {
  charactersViewEl.style.display = 'none';
  backgroundsViewEl.style.display = 'grid';
  vnViewEl.style.display = 'none';
} else if (activeTab === 'vn') {
  charactersViewEl.style.display = 'none';
  backgroundsViewEl.style.display = 'none';
  vnViewEl.style.display = 'block';
  if (currentNovelId) {
    sendNovelIdToVnPlayer(currentNovelId);
  }
}
```

### 변경사항 3 — `sendNovelIdToVnPlayer()` 함수 추가

`setupEventListeners()` 함수 아래에 추가:

```javascript
function sendNovelIdToVnPlayer(novelId) {
  // iframe을 리로드한 뒤 load 완료 후 postMessage 전송
  // → Monogatari 인스턴스 재초기화 문제를 근본적으로 회피
  vnIframeEl.src = 'vn.html';
  vnIframeEl.onload = () => {
    vnIframeEl.contentWindow.postMessage({ novelId }, window.location.origin);
    vnIframeEl.onload = null;
  };
}
```

### 변경사항 4 — `selectNovel()` 내 VN 탭 활성 상태 시 자동 전달 (63~66 라인 부근)

```javascript
// 변경 전
if (result.success) {
  currentAssets = result.data;
  renderAssets();
  noNovelEl.style.display = 'none';
  novelContentEl.style.display = 'flex';
  novelTitleEl.textContent = currentAssets.novel.novelTitle;
}

// 변경 후
if (result.success) {
  currentAssets = result.data;
  renderAssets();
  noNovelEl.style.display = 'none';
  novelContentEl.style.display = 'flex';
  novelTitleEl.textContent = currentAssets.novel.novelTitle;
  // VN 탭 활성 상태에서 소설을 변경하면 즉시 전달
  if (activeTab === 'vn') {
    sendNovelIdToVnPlayer(currentNovelId);
  }
}
```

---

## 구현 순서 (권장)

```
1. novel-parsing.service.ts  — sceneSchema에 isEntry/isExit/position 추가     (§1)
2. prompt/prompt.ts          — scene_prompt에 지시사항 추가                    (§2)
3. novel.service.ts          — getVnScript() + buildMonogatariScript() 구현    (§3-2, §4)
4. novel.controller.ts       — GET /novels/:id/vn-script 라우트 등록           (§3-1)
5. novel.module.ts           — S3HelperService providers 추가 확인             (§3-3)
6. frontend/vn.html          — 신규 생성                                       (§5)
7. frontend/vn.js            — 신규 생성                                       (§6)
8. frontend/index.html       — Visual Novel 탭 + iframe 컨테이너 추가          (§7)
9. frontend/app.js           — 탭 전환 로직 + postMessage 연동                 (§8)
```

---

## 테스트 체크리스트

| # | 항목 | 검증 방법 |
|---|---|---|
| 1 | `POST /parsing/scenes` 재호출 후 `isEntry`/`isExit`/`position` 필드가 scenes.json에 포함되는지 | S3 파일 직접 다운로드 후 확인 |
| 2 | `GET /novels/:id/vn-script` 응답에 `characters`, `scenes`, `script` 키 존재 | API 직접 호출 (api_test.http) |
| 3 | `script` 배열에 `show scene`, `show character`, `hide character`, `end` 순서 정확한지 | 응답 JSON 육안 검토 |
| 4 | 구버전 scenes.json (isEntry 없음) 처리 시 서버 오류 없이 기본값으로 변환 | isEntry 없는 JSON으로 직접 호출 |
| 5 | `vn.html` 단독 브라우저 접근 시 로딩 오버레이만 표시, 콘솔 오류 없음 | 브라우저 직접 접근 |
| 6 | 소설 선택 → Visual Novel 탭 전환 → Monogatari 플레이어 초기화 완료 | 브라우저 E2E |
| 7 | 다른 소설로 전환 시 Monogatari 스크립트 갱신 | 두 소설을 번갈아 선택 |
| 8 | Characters / Backgrounds 탭 기능 유지 확인 | VN 탭 전환 후 되돌아오기 |
