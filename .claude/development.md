# development.md — 씬 내 캐릭터 화면 배치 개편

> plan.md 기반 개발 상세 기획서.
> 아키텍처/스키마 배경지식은 structure.md 참조.

---

## 1. 변경 범위 요약

| 파일 | 변경 유형 | 내용 |
|---|---|---|
| `backend/src/parsing/prompt/prompt.ts` | 수정 | scene_prompt DIALOGUE RULES 교체 |
| `backend/src/parsing/parsing.service.ts` | 수정 | Zod 스키마 — `position`, `isEntry`, `isExit` 제거, `currentScreen[]` 추가 |
| `backend/src/episode/episode.service.ts` | 수정 | `buildVnScript` 로직 전면 교체 (currentScreen diff 기반) |
| `frontend/player.js` | 변경 없음 | 스크립트 포맷이 동일하게 유지되므로 수정 불필요 |

> **기존 소설 영향 없음:** `buildVnScript`에서 `??` 기본값 처리로 구버전 scenes.json도 계속 동작.

---

## 2. scenes.json 포맷 변경

### 2.1 AS-IS (dialogue 구조)

```json
{
  "characterId": "1_char_1",
  "dialog": "에이, 선생님도 참.",
  "action": "IDLE",
  "emotion": "SMILE",
  "look": "cheerful smile",
  "isEntry": false,
  "isExit": false,
  "position": "right"
}
```

### 2.2 TO-BE (dialogue 구조)

```json
{
  "characterId": "1_char_1",
  "dialog": "에이, 선생님도 참.",
  "currentScreen": [
    {
      "characterId": "1_char_1",
      "position": "left",
      "emotion": "SMILE",
      "look": "cheerful smile",
      "action": "IDLE"
    },
    {
      "characterId": "helmet-gang-id",
      "position": "right",
      "emotion": "ANGRY",
      "look": "holding weapons",
      "action": "SHAKE"
    }
  ]
}
```

**변경 포인트:**
- `action` / `emotion` / `look` 필드 삭제 (dialogue 최상위에서 제거) — 해당 정보는 `currentScreen` 내 캐릭터 항목에 포함
- `position` 필드 삭제 (dialogue 최상위에서 제거)
- `isEntry` / `isExit` 필드 삭제 — 등장/퇴장 여부는 `currentScreen`의 포함 여부로 결정
- `currentScreen` 배열 추가 — 해당 대사가 출력되는 순간 화면에 있는 **모든** 캐릭터 목록 (action/emotion/look/position 포함)
- narrator의 경우 `currentScreen`은 현재 화면 상태를 그대로 유지 (narration 중에도 화면 구성은 존재)

---

## 3. `parsing/prompt/prompt.ts` 변경

`scene_prompt` 내 `[DIALOGUE RULES]` 블록을 아래로 교체한다.

```
[DIALOGUE RULES]

# 1. Text & Metadata Rules
- Ensure NO dialogue is skipped. Retain the exact original language for the "dialog" field. Do NOT translate.
- characterId: match the speaker to their ID using characters_info. Use "narrator" for narration, "unknown" for unidentified characters.
- Narrator Blocks: EXCLUDE purely visual descriptions or emotional expositions. ONLY keep essential plot advancements. Summarize and compress. Avoid consecutive narrator blocks.

# 2. Screen State & Positioning Rules (CRITICAL)
- "currentScreen" Field: Every dialogue block MUST include a "currentScreen" array detailing ONLY the visible characters on screen during that turn. Do NOT use entry/exit flags. The presence or absence of a character in this array dictates their entry or exit.
- Narrator Exclusion: The narrator is EXCLUDED from the "currentScreen" array.

# 3. Dynamic Layout Adjustment (Inside "currentScreen")
- Each currentScreen entry contains: characterId, position, emotion, look, action — for that character AT THIS MOMENT.
- emotion / look: Provide ONLY in English.
- action: MUST ONLY be one of: ["IDLE", "ATTACK", "SHAKE"].
- 1 Character: MUST be "center".
- 2 Characters: MUST be "left" and "right". (If a 2nd character joins a single character, the existing character must be moved to "left" or "right").
- 3 Characters: MUST be "left", "center", and "right".
- Overcrowding Prevention: MAX 3 characters. If a 4th must appear, REMOVE the least active character from the "currentScreen" array to make room.

# 4. Group Character Monopoly Exception
- If a character represents a group (e.g., crowd, mob, gang):
  * They MUST be alone on screen.
  * ALL other characters MUST be completely removed from the "currentScreen" array in that turn.
  * The group character's position MUST be "center".
```

---

## 4. `parsing.service.ts` 변경 — Zod 스키마

### 4.1 현재 dialogue 스키마

```typescript
dialogues: z.array(z.object({
  characterId: z.string(),
  dialog:      z.string(),
  action:      z.enum(['IDLE', 'ATTACK', 'SHAKE']),  // ← 삭제
  emotion:     z.nativeEnum(Emotion),                // ← 삭제
  look:        z.string(),                           // ← 삭제
  isEntry:     z.boolean(),                          // ← 삭제
  isExit:      z.boolean(),                          // ← 삭제
  position:    z.enum(['left', 'center', 'right']),  // ← 삭제
}))
```

### 4.2 변경 후 dialogue 스키마

```typescript
const currentScreenEntrySchema = z.object({
  characterId: z.string().describe('화면에 표시된 캐릭터 ID'),
  position:    z.enum(['left', 'center', 'right']).describe('현재 이 캐릭터의 화면 위치'),
  emotion:     z.nativeEnum(Emotion).describe('현재 이 캐릭터의 감정'),
  look:        z.string().describe('현재 이 캐릭터의 외모/표정 (영어)'),
  action:      z.enum(['IDLE', 'ATTACK', 'SHAKE']).describe('현재 이 캐릭터의 동작'),
});

dialogues: z.array(z.object({
  characterId:   z.string(),
  dialog:        z.string(),
  // action, emotion, look, isEntry, isExit, position 필드 삭제
  currentScreen: z.array(currentScreenEntrySchema).describe(
    '이 대사가 출력되는 순간 화면에 있는 모든 캐릭터 목록 (narrator 제외)',
  ),
}))
```

### 4.3 character_img 플레이스홀더 생성 로직 변경

현재는 `dialogue.emotion`에서 수집. 변경 후에는 `dialogue.emotion` 필드가 삭제되므로 `currentScreen`의 각 항목 `emotion`에서만 수집.

```typescript
// 변경 전
emotionMap.get(charId)!.add(dialogue.emotion as Emotion);

// 변경 후 — currentScreen 내 모든 캐릭터 emotion에서만 수집
for (const scene of resolvedScenes) {
  for (const dialogue of scene.dialogues) {
    for (const entry of dialogue.currentScreen ?? []) {
      if (!emotionMap.has(entry.characterId)) emotionMap.set(entry.characterId, new Set([Emotion.DEFAULT]));
      emotionMap.get(entry.characterId)!.add(entry.emotion as Emotion);
    }
  }
}
```

---

## 5. `episode.service.ts` 변경 — `buildVnScript`

### 5.1 핵심 변경 로직

기존: `isEntry`/`isExit`/`position`(dialogue 최상위)으로 show/hide 결정  
변경: `currentScreen` 배열의 포함 여부로 등장/퇴장을 결정 (diff 방식)

각 dialogue 처리 시:
1. 이전 대사의 `currentScreen`과 현재 대사의 `currentScreen`을 비교
2. 새로 나타난 캐릭터(혹은 position/emotion이 변경된 캐릭터) → `show character` 명령 추가
3. 사라진 캐릭터 → `hide character` 명령 추가
4. 이후 dialogue 또는 narrator 명령 추가

### 5.2 변경 후 `buildVnScript` 구현

```typescript
private buildVnScript(
  scenes: any[],
  characterMap: VnCharacterMap,
): (string | Record<string, string>)[] {
  const script: (string | Record<string, string>)[] = [];
  let currentBgmId: string | null = null;

  for (const scene of scenes) {
    if (scene.bgmId && scene.bgmId !== currentBgmId) {
      script.push(`play bgm ${scene.bgmId}`);
      currentBgmId = scene.bgmId;
    }
    script.push(`show scene ${scene.backgroundId} with fade`);

    // 현재 화면 상태: charId → { position, emotion }
    let prevScreen = new Map<string, { position: string; emotion: string }>();

    for (const dialogue of scene.dialogues) {
      const { characterId, dialog, currentScreen } = dialogue;

      // currentScreen 없는 구버전 scenes.json → isEntry/isExit/position 폴백
      if (!currentScreen) {
        // 기존 로직 유지 (하위 호환)
        this.applyLegacyDialogue(dialogue, prevScreen, script, characterMap);
        continue;
      }

      // 신규 포맷: currentScreen diff
      const nextScreen = new Map<string, { position: string; emotion: string }>(
        currentScreen.map((e: any) => [e.characterId, { position: e.position, emotion: e.emotion }])
      );

      // 1. 퇴장: prevScreen에 있으나 nextScreen에 없는 캐릭터
      for (const [charId] of prevScreen) {
        if (!nextScreen.has(charId)) {
          script.push(`hide character ${charId}`);
        }
      }

      // 2. 등장 or 변경: nextScreen에 있는 캐릭터 중 prevScreen과 다른 경우
      for (const [charId, { position, emotion }] of nextScreen) {
        const prev = prevScreen.get(charId);
        if (!prev || prev.position !== position || prev.emotion !== emotion) {
          script.push(`show character ${charId} ${emotion} ${position}`);
        }
      }

      prevScreen = nextScreen;

      // 3. 대사 또는 나레이션 추가
      if (characterId === 'narrator' || characterId === 'unknown') {
        script.push(dialog);
      } else {
        const charName = characterMap[characterId]?.name ?? characterId;
        script.push({ [charName]: dialog });
      }
    }

    // 씬 종료 후 화면 잔류 캐릭터 제거
    for (const charId of prevScreen.keys()) {
      script.push(`hide character ${charId}`);
    }
    prevScreen.clear();
  }

  script.push('stop bgm');
  script.push('end');
  return script;
}
```

### 5.3 하위 호환 처리 (`applyLegacyDialogue`)

기존 소설의 scenes.json(`currentScreen` 없는 구버전)은 기존 `isEntry/isExit/position` 로직으로 처리.
별도 private 메서드(`applyLegacyDialogue`)로 분리하여 기존 코드 보존.

---

## 6. 프론트엔드 (`player.js`)

**변경 없음.** 백엔드 `buildVnScript`가 동일한 `show character` / `hide character` 명령 포맷으로 스크립트를 생성하므로 프론트엔드 플레이어는 현행 그대로 동작한다.

---

## 7. 작업 순서

1. `prompt.ts` — DIALOGUE RULES 교체
2. `parsing.service.ts` — Zod 스키마 수정 + 감정 수집 로직 수정
3. `episode.service.ts` — `buildVnScript` 교체 (레거시 폴백 포함)
4. 통합 테스트: 새 소설로 파이프라인 End-to-End 실행 확인

---

## 8. 체크리스트

- [ ] `currentScreen`이 없는 구버전 scenes.json(isEntry/isExit/position 포맷)에서 플레이어 정상 동작 확인
- [ ] narrator 대사 시 화면 캐릭터 유지 확인
- [ ] 2인 → 3인 진입 시 위치 재배치 확인
- [ ] 집단 캐릭터 진입 시 기존 캐릭터 전원 퇴장 확인
- [ ] character_img 플레이스홀더에 currentScreen 감정 포함 확인
