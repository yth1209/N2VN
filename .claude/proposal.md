지금 character img, background img를 leonardo api를 사용하고 있는데 이걸 gemini api를 사용하도록 수정할거야. 
사용 모델은 nano banana pro.

# 해야할 일
1. leonardo api 호출 로직은 남겨두고 option으로 leonardo, gemini 선택하여 이미지 생성 할 수 있도록 수정. 단 rest api request body가 아닌 .env로 설정. 이 기능은 /backend/src/image 내의 파일들 참고
2. 현재 git log를 보면 알겠지면 기존에는 생성 완료 여부를 genId is null로 판단했음. 근데 gemini의 경우 genId 자체가 존재하지 않아 별도의 status로 관리하도록 수정하고 있는중이었고, 이를 마무리 지으면됨. (entities/backgourd.entity.ts, bgm.entity.ts, character-img.entity.ts 참고)

# 참고 사항
gemini api 호출 방법

import { GoogleGenAI } from "@google/genai";
import * as fs from "node:fs";

async function main() {

  const ai = new GoogleGenAI({});

  const prompt =
    "Create a picture of a nano banana dish in a fancy restaurant with a Gemini theme";

  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-image-preview",
    contents: prompt,
  });
  for (const part of response.candidates[0].content.parts) {
    if (part.text) {
      console.log(part.text);
    } else if (part.inlineData) {
      const imageData = part.inlineData.data;
      const buffer = Buffer.from(imageData, "base64");
      fs.writeFileSync("gemini-native-image.png", buffer);
      console.log("Image saved as gemini-native-image.png");
    }
  }
}

main();