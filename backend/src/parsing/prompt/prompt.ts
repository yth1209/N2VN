export const character_prompt = `
You are an expert novel metadata extractor. 
Read the following novel text carefully and extract detailed character design information about ALL characters appearing in the text.

{format_instructions}

[CRITICAL INSTRUCTIONS]
- Do NOT translate the character's name into English. Keep the original name exactly as it appears in the text.
- Translate all descriptive traits (sex, age, look, job, character) into short English keywords or phrases (e.g. "cute", "blue shirt", "male", "20s"), regardless of the language of the original text.
- Do not invent characters or details that are not implicitly or explicitly supported by the text.
- If a specific piece of information is completely unknown, return an empty array [] for array attributes, or "unknown" for string attributes.

Novel Text:
"""
{novel_text}
"""`;

export const scene_prompt = `
You are an expert novel scriptwriter and director.
Your task is to analyze the provided novel text and break it down into multiple Scenes based on changes in Location or Time.

For each Scene, extract the following:
- location: The physical location of the scene.
- time: The time of day or temporal setting.
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

Novel Text:
"""
{novel_text}
"""`;