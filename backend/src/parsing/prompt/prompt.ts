export const character_prompt = `
You are an expert Art Director for a Visual Novel.
Read the following novel text carefully and extract detailed character design information to create a definitive "Character Bible" for ALL **NEW** characters appearing in the text.

{format_instructions}

[EXISTING CHARACTERS — DO NOT RE-EXTRACT THESE]
The following characters already exist in the system. Even if they appear under different aliases, titles, or honorifics, do NOT include them in your output.
Only extract characters that are completely new and not represented below.
{existing_characters}

[CRITICAL INSTRUCTIONS]
- Do NOT translate the character's name into English. Keep the original name exactly as it appears in the text.
- [STRICTLY FORBIDDEN] Do NOT include any facial expressions, emotions, or mood descriptions in the 'look' field.
- The 'look' field MUST be a dense, comma-separated English prompt designed for Stable Diffusion / Leonardo API.
- [VITAL: CREATIVE INFERENCE] If specific physical traits or clothing details are not explicitly mentioned, INFER and CREATE highly specific details based on the character's job, personality, and genre. Do not use generic words or "unknown".
- Format the 'look' field by strictly combining these 5 elements: 1. Age/Gender, 2. Detailed Hair, 3. Face/Body features, 4. Detailed Clothing, 5. Props/Weapons.
- If there are NO new characters in this episode, return an empty object for the "characters" field.

Novel Text:
"""
{novel_text}
"""`;

export const scene_prompt = `
You are an expert novel scriptwriter and director.
Your task is to analyze the provided novel text and break it down into multiple Scenes based on changes in Location or Time.

Before listing scenes, you MUST declare all NEW backgrounds and BGMs in the newBackgrounds and newBgms arrays.
Then reference them by tempId in the scenes array.

{format_instructions}

[BACKGROUND RULES]
- If the scene location matches an entry in the existing backgrounds list, reuse that ID directly as backgroundId.
- If it is a NEW location not in the list, add it to newBackgrounds with tempId like "new_bg_1", "new_bg_2", etc., then use that tempId as backgroundId.
- timeOfDay is specified per scene and must NOT appear in the background description.
- If the location is completely unknown, use "bg_unknown" as backgroundId.

[BGM RULES]
- If the scene mood/category matches an existing BGM, reuse that ID as bgmId.
- If it requires NEW music, add it to newBgms with tempId like "new_bgm_1", "new_bgm_2", etc., then use that tempId as bgmId.
- Consecutive scenes with a similar mood SHOULD share the same bgmId to preserve musical continuity.
- BGM prompt must be in English, under 30 words (e.g., "calm piano melody with soft strings, peaceful ambient").

[DIALOGUE RULES]
- Ensure NO dialogue is skipped. Retain the exact original language for the "dialog" field. Do NOT translate.
- characterId: match the speaker to their ID using characters_info. Use "narrator" for narration, "unknown" for unidentified characters.
- For narrator blocks: EXCLUDE purely visual descriptions or emotional expositions. ONLY keep essential plot advancements. Summarize and compress. Avoid consecutive narrator blocks.
- Provide "action", "emotion", "look" ONLY in English.
- isEntry: true on the FIRST line of a character within a scene. narrator always false.
- isExit: true on the LAST line of a character within a scene. narrator always false.
- A character appearing only once in a scene has both isEntry and isExit as true.
- position: "center" if alone on screen; "left" or "right" for 2+ characters. narrator always "center".

Known Characters Information:
{characters_info}

## Existing Backgrounds (reuse if matching)
{existing_backgrounds}

## Existing BGMs (reuse if matching)
{existing_bgms}

Novel Text:
"""
{novel_text}
"""`;
