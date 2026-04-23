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

export const background_prompt = `
You are an expert novel environment designer.
Read the following novel text carefully and extract detailed information about ALL **NEW** distinct physical locations and background settings appearing in the text.

{format_instructions}

[EXISTING BACKGROUNDS — DO NOT RE-EXTRACT THESE]
The following backgrounds already exist in the system. Do NOT include them in your output.
Only extract backgrounds that are completely new and not represented below.
{existing_backgrounds}

[CRITICAL INSTRUCTIONS]
- Do NOT translate the location's name into English. Keep the original name exactly as it appears in the text.
- Translate all descriptive traits (description) into short English phrases.
- Do not invent locations that are not supported by the text.
- If there are NO new backgrounds in this episode, return an empty object for the "backgrounds" field.

Novel Text:
"""
{novel_text}
"""`;

export const scene_prompt = `
You are an expert novel scriptwriter and director.
Your task is to analyze the provided novel text and break it down into multiple Scenes based on changes in Location or Time.

For each Scene, extract the following:
- backgroundId: The exact ID of the background from the provided 'backgrounds_info' that matches the current location. If completely unknown or unlisted, use "bg_unknown".
- timeOfDay: The time of day or temporal setting (e.g., Morning, Night, Dusk).
- bgm_prompt: A 1-2 sentence description in English for a Background Music generation AI that perfectly fits the mood and atmosphere of this scene.
- dialogues: A sequential array of dialogues and narrations.

For EACH line of text or dialogue in the scene, create a dialogue prompt with:
- characterId: Use the provided characters_info to exactly match the speaker to their ID. If it is a descriptive sentence or narration, use "narrator". If it's an unknown character, use "unknown".
- dialog: The exact original text of the narration or dialogue (Do NOT translate).
- action: A short English phrase describing the speaker's actions/movements.
- emotion: A short English word describing the emotion.
- look: A short English phrase describing the speaker's appearance (if mentioned or implied in this scene).

{format_instructions}

[CRITICAL INSTRUCTIONS]
- For character dialogues: Ensure NO dialogue is skipped. Retain the exact original language for the "dialog" field.
- For narrations/descriptions (characterId: "narrator"): EXCLUDE purely visual descriptions, emotional expositions, or redundant explanations of previous dialogues. ONLY keep essential plot advancements.
- When keeping essential narrator blocks, summarize and compress them concisely in the original language. Avoid consecutive "narrator" blocks.
- Do NOT translate names. Use the original character names from the text.
- Provide "action", "emotion", "look", and "bgm_prompt" ONLY in English.
- isEntry / isExit rules:
  * Set isEntry: true on the FIRST dialogue line of a character within a scene.
  * Set isExit: true on the LAST dialogue line of a character within a scene.
  * A single-line character (appears once in a scene) has both isEntry AND isExit both true.
  * narrator always has isEntry: false and isExit: false.
- position rules:
  * If only one character is currently on screen: position = "center".
  * If two or more characters are simultaneously on screen, assign "left" or "right" based on natural conversation flow.
  * narrator always has position = "center".

Known Characters Information:
{characters_info}

Known Backgrounds Information:
{backgrounds_info}

Novel Text:
"""
{novel_text}
"""`;
