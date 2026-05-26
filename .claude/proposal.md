# AS-IS
1. 현재 dialouges 구조는 처음 캐릭터가 center에 위치하고 있다가 캐릭터의 추가로 인해 left로 위치 이동, 혹은 동시에 2명 이상의 캐릭터 삭제 로직이 불가능한 상황.
"dialogues": [
        {
          "characterId": "025ba242-92f9-4402-bbe3-d2908f106083",
          "dialog": "저기, 선생님? 지금 혹시 숨쉬는 거 잊어버리신 거 아니죠?",
          "action": "IDLE",
          "emotion": "SMILE",
          "look": "bright smile, holding an assault rifle",
          "isEntry": true,
          "isExit": false,
          "position": "right"
        },
        {
          "characterId": "narrator",
          "dialog": "눈앞에서 포탄이 날아다니고 있었다. 120mm 활강포의 철갑탄이 내 머리 위를 스치고 지나갔다. 콰아아앙-! 하는 굉음과 함께 편의점의 유리창이 산산조각 났다.",
          "action": "SHAKE",
          "emotion": "DEFAULT",
          "look": "unknown",
          "isEntry": false,
          "isExit": false,
          "position": "center"
        },
        {
          "characterId": "narrator",
          "dialog": "콜록, 콜록! 숨... 숨은 쉬고 있어! 다만 내 심장이 지금 갈비뼈를 부수고 튀어나오려고 할 뿐이야!",
          "action": "SHAKE",
          "emotion": "PAIN",
          "look": "shocked and coughing",
          "isEntry": false,
          "isExit": false,
          "position": "center"
        },
        {
          "characterId": "narrator",
          "dialog": "무너진 진열대 뒤에 웅크린 채, 탄창을 갈아 끼우는 아미를 보았다. 그녀는 [방과후 위기관리 위원회] 소속 학생이다.",
          "action": "IDLE",
          "emotion": "DEFAULT",
          "look": "unknown",
          "isEntry": false,
          "isExit": false,
          "position": "center"
        },
        {
          "characterId": "025ba242-92f9-4402-bbe3-d2908f106083",
          "dialog": "에이, 선생님도 참. 이 정도는 아르카디아에서 흔한 아침 인사 같은 거라구요. 저기 저 불량 서클 '헬멧단' 애들 보세요. 아침부터 한정판 딸기 우유를 차지하겠다고 전차까지 끌고 오다니, 열정이 대단하지 않나요?",
          "action": "IDLE",
          "emotion": "SMILE",
          "look": "cheerful smile",
          "isEntry": false,
          "isExit": false,
          "position": "right"
        },
        {
          "characterId": "narrator",
          "dialog": "아미가 총을 쏘자 불량 학생들의 비명이 들렸다.",
          "action": "ATTACK",
          "emotion": "DEFAULT",
          "look": "unknown",
          "isEntry": false,
          "isExit": false,
          "position": "center"
        }
      ]
    },
    {
      "backgroundId": "9c848c13-5dd1-488d-991d-bf4f95510b38",
      "bgmId": "41197c63-dc4b-43ba-858a-189337207d9a",
      "timeOfDay": "Morning",
      "dialogues": [
        {
          "characterId": "narrator",
          "dialog": "불과 3시간 전. 나는 아르카디아 학원연합 중앙역에 도착했다. 총기를 든 학생들과 헤일로가 가득한 도시였다. 나는 이곳에서 가장 나약한 평범한 어른이었다.",
          "action": "IDLE",
          "emotion": "DEFAULT",
          "look": "unknown",
          "isEntry": false,
          "isExit": false,
          "position": "center"
        }
      ]
    }

아래는 기존 scene parser prompt
C:\Users\yth00\OneDrive - postech.ac.kr\1. Lecture\9th Semester\과제연구\N2VN\backend\src\parsing\prompt\prompt.ts
[DIALOGUE RULES]
- Ensure NO dialogue is skipped. Retain the exact original language for the "dialog" field. Do NOT translate.
- characterId: match the speaker to their ID using characters_info. Use "narrator" for narration, "unknown" for unidentified characters.
- For narrator blocks: EXCLUDE purely visual descriptions or emotional expositions. ONLY keep essential plot advancements. Summarize and compress. Avoid consecutive narrator blocks.
- Provide "emotion", "look" ONLY in English.
- The "action" field MUST ONLY be one of: ["IDLE", "ATTACK", "SHAKE"].
- isEntry: true on the FIRST line of a character within a scene. narrator always false.
- isExit: true on the LAST line of a character within a scene. narrator always false.
- A character appearing only once in a scene has both isEntry and isExit as true.
- position: "center" if alone on screen; "left" or "right" for 2+ characters. (Note: Narrator is always "center" and excluded from the character count).
- position Exception: If a single character image represents a group of multiple people (e.g., a crowd or mob), it must be positioned "center" alone, and all other characters must be cleared from the screen.



# TO-BE
1. 이를 각 dialouge 단위로 현재 화면의 모든 캐릭터 배치를 표출하도록 변경. 이 data structer에 맞춰 frontend 수정 작업도 필요. 기존 소설에 대한 마이그레이션은 X
{
  "characterId": "narrator",
  "dialog": "무너진 진열대 뒤에 웅크린 채, 탄창을 갈아 끼우는 아미를 보았다.",
  "action": "IDLE",
  "emotion": "DEFAULT",
  "look": "unknown",
  "currentScreen": [
    {
      "characterId": "025ba242-92f9-4402-bbe3-d2908f106083", // 아미
      "position": "center", // 혼자 있을 때는 center
      "emotion": "DEFAULT",
      "look": "unknown",
      "action": "IDLE"
    }
  ]
},
{
  "characterId": "025ba242-92f9-4402-bbe3-d2908f106083",
  "dialog": "에이, 선생님도 참. 저기 저 불량 서클 '헬멧단' 애들 보세요.",
  "action": "IDLE",
  "emotion": "SMILE",
  "look": "cheerful smile",
  "currentScreen": [
    {
      "characterId": "025ba242-92f9-4402-bbe3-d2908f106083", // 아미
      "position": "left", // 헬멧단이 등장하면서 자동으로 left로 이동!
      "emotion": "SMILE",
      "look": "cheerful smile",
      "action": "IDLE"
    },
    {
      "characterId": "helmet-gang-id", // 헬멧단 (군집 캐릭터 예시)
      "position": "right", 
      "emotion": "ANGRY",
      "look": "holding weapons",
      "action": "SHAKE"
    }
  ]
}

아래는 scene parser promt 변경안
C:\Users\yth00\OneDrive - postech.ac.kr\1. Lecture\9th Semester\과제연구\N2VN\backend\src\parsing\prompt\prompt.ts
[DIALOGUE RULES]

# 1. Text & Metadata Rules
- Ensure NO dialogue is skipped. Retain the exact original language for the "dialog" field. Do NOT translate.
- characterId: match the speaker to their ID using characters_info. Use "narrator" for narration, "unknown" for unidentified characters.
- Narrator Blocks: EXCLUDE purely visual descriptions or emotional expositions. ONLY keep essential plot advancements. Summarize and compress. Avoid consecutive narrator blocks.
- emotion / look: Provide ONLY in English.
- action: MUST ONLY be one of: ["IDLE", "ATTACK", "SHAKE"].

# 2. Screen State & Positioning Rules (CRITICAL)
- "currentScreen" Field: Every dialogue block MUST include a "currentScreen" array detailing ONLY the visible characters on screen during that turn. Do NOT use entry/exit flags. The presence or absence of a character in this array dictates their entry or exit.
- Narrator Exclusion: The narrator is EXCLUDED from the "currentScreen" array. The main dialogue block's position for the narrator is always "center".

# 3. Dynamic Layout Adjustment (Inside "currentScreen")
- 1 Character: MUST be "center".
- 2 Characters: MUST be "left" and "right". (If a 2nd character joins a single character, the existing character must be moved to "left" or "right").
- 3 Characters: MUST be "left", "center", and "right".
- Overcrowding Prevention: MAX 3 characters. If a 4th must appear, REMOVE the least active character from the "currentScreen" array to make room.

# 4. Group Character Monopoly Exception
- If a character represents a group (e.g., crowd, mob, gang):
  * They MUST be alone on screen.
  * ALL other characters MUST be completely removed from the "currentScreen" array in that turn.
  * The group character's position MUST be "center".