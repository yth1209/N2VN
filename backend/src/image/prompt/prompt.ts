import { Emotion } from "../../common/constants";

// const QUALITY_BLOCK = "(masterpiece, best quality, cinematic lighting:1.2)";
const FRAMING_BLOCK = "full body shot, full length portrait, showing entire body from head to feet, standing, front view, facing forward, looking at viewer, straight on"; // 비주얼 노벨 UI를 위한 필수 구도 (정면 응시 완벽 고정)
const BACKGROUND_BLOCK = "isolated on a solid flat magenta background, pure #FF00FF single-color background,";
// const BACKGROUND_BLOCK_GEMINI   = "transparent background, RGBA transparent PNG, no background elements, alpha channel";

function getSubjectBlock(subjectCount: number): string {
  return subjectCount === 1
    ? 'Draw exactly ONE character and no more. Do NOT draw multiple characters.'
    : `Draw exactly ${subjectCount} characters. No more, no fewer.`;
}

function getEmotionBlock(emotion: Emotion) {
  switch(emotion) {
    case Emotion.DEFAULT:
      return "calm and composed expression, stoic, confident eyes"; 
    case Emotion.SERIOUS:
      return "serious, slightly furrowed brows, sharp focused gaze, tense jaw";
    case Emotion.SMILE:
      return "subtle smile, soft expression, gentle eyes"; 
    case Emotion.SMIRK:
      return "(smirk:1.05), arrogant smile, looking down slightly";
    case Emotion.ANGRY:
      return "glaring intensely, (heavy furrowed brows:1.05), tense facial muscles"; 
    case Emotion.RAGE:
      return "(intense piercing glare:1.05), (gritted teeth:1.05), fierce expression, hostile";
    case Emotion.SAD: 
      return "somber expression, looking down slightly, melancholic, shadow over eyes"; 
    case Emotion.PAIN:
      return "wincing slightly, (gritted teeth:1.05), enduring pain, stiff face";
    case Emotion.SURPRISED:
      return "(widened eyes:1.05), slightly raised eyebrows, speechless"; 
    case Emotion.FEAR:
      return "stiff expression, wide eyes, cold sweat, shrinking pupils, anxious";
    default:
      return "calm and composed expression";
  }
}


// 최종 API Payload로 전송될 Prompt
export const getCharacterPrompt = (
  style:        string,
  look:         string,
  emotion:      Emotion,
  subjectCount: number = 1,
) => {
  const subjectBlock = getSubjectBlock(subjectCount);
  return `${subjectBlock}
[STYLE]: ${style}
[CHARACTER]: ${look}
[EMOTION]: ${getEmotionBlock(emotion)}
[FRAMING]: ${FRAMING_BLOCK}
[BACKGROUND]: ${BACKGROUND_BLOCK}`;
};


export const getCharacterEmotionPrompt = (
  style:        string,
  look:         string,
  emotion:      Emotion,
  provider:     'leonardo' | 'gemini' = 'leonardo',
  subjectCount: number = 1,
) => {
  if (provider === 'leonardo') {
    return getCharacterPrompt(style, look, emotion, subjectCount);
  }

  return `Using the provided character image, generate a new image showing the character with following emotion : ${getEmotionBlock(emotion)}, 
          Character consistency is the top priority, allowing minimal posture change, but never harming the overall identity of the character, such as clothes or hairstyles,
          ${BACKGROUND_BLOCK}`;
};
