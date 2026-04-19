export const character_prompt = `
You are an expert Art Director for a Visual Novel. 
Read the following novel text carefully and extract detailed character design information to create a definitive "Character Bible" for ALL characters appearing in the text.

{format_instructions}

[CRITICAL INSTRUCTIONS]
- Do NOT translate the character's name into English. Keep the original name exactly as it appears in the text.
- [STRICTLY FORBIDDEN] Do NOT include any facial expressions, emotions, or mood descriptions (e.g. "smiling", "angry", "happy", "serious look") in the 'look' field. These will be handled dynamically in real-time.
- The 'look' field MUST be a dense, comma-separated English prompt designed for Stable Diffusion / Leonardo API. 
- [VITAL: CREATIVE INFERENCE] Novels often omit minor visual details (e.g., exact hairstyle, eye color, clothing layers). If specific physical traits or clothing details are not explicitly mentioned, you MUST INFER and CREATE highly specific details based on the character's job, personality, and the genre's typical tropes. Do not use generic words or "unknown".
- Format the 'look' field by strictly combining these 5 elements: 1. Age/Gender (e.g., 1boy, 20s), 2. Detailed Hair (color, length, specific style), 3. Face/Body features (eye color, specific body type, tattoos/scars if any), 4. Detailed Clothing (colors, layers, specific items), 5. Props/Weapons.

Novel Text:
"""
{novel_text}
"""`;

export const background_prompt = `
You are an expert novel environment designer.
Read the following novel text carefully and extract detailed information about ALL distinct physical locations and background settings (e.g. "Dungeon", "Mountain Peak", "Inn") appearing in the text, as well as the overall architectural and atmospheric art style of the world.

{format_instructions}

[CRITICAL INSTRUCTIONS]
- Do NOT translate the location's name into English. Keep the original name exactly as it appears in the text.
- Translate all descriptive traits (description) into short English phrases (e.g. "dark cave with torches", "sunny bustling city street").
- Do not invent locations that are not supported by the text.

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
- action: A short English phrase describing the speaker's (or narrator's subject's) actions/movements.
- emotion: A short English word describing the emotion.
- look: A short English phrase describing the speaker's appearance (if mentioned or implied in this scene).

{format_instructions}

[CRITICAL INSTRUCTIONS]
- For character dialogues: Ensure NO dialogue is skipped. Retain the exact original language for the "dialog" field.
- For narrations/descriptions (characterId: "narrator"): EXCLUDE purely visual descriptions (appearance, clothing), emotional expositions, or redundant explanations of previous dialogues. These will be handled by illustrations and the 'action'/'emotion'/'look' fields. ONLY keep essential plot advancements. If a narration block is entirely descriptive, DO NOT create a dialogue prompt for it.
- When keeping essential narrator blocks, summarize and compress them concisely in the original language. Avoid consecutive "narrator" blocks.
- Do NOT translate names. Use the original character names from the text.
- Provide "action", "emotion", "look", and "bgm_prompt" ONLY in English.

Known Characters Information:
{characters_info}

Known Backgrounds Information:
{backgrounds_info}

Novel Text:
"""
{novel_text}
"""`;