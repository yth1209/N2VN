# AS-IS
1. 현재 Character Image 생성 시 (N2VN\backend\src\image 내 코드), gemini 모드일 때 gemini response를 바로 _nobg.png, 즉 배경화면 없는 사진으로 저장함. 그러나 gemini에게 배경 투명화를 요청하면 실제 알파 값 조정이 아닌 체크 무늬 색상의 img를 넘겨줌. 그래서 실제 배경이 투명한 이미지로서 활용하지 못하는 상태.

# TO-BE
1. @imgly/background-removal을 사용해서 찐 투명화를 한 이미지만 _NOBG.png로 저장하도록 수정

아래는 예시 코드
import { GoogleGenAI } from "@google/genai";
import { removeBackground } from "@imgly/background-removal-node";
import * as fs from "node:fs";

async function generateTransparentCharacter() {
  const ai = new GoogleGenAI({});
  
  // 1. Gemini API를 통해 이미지 생성 요청 (기존 코드)
  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-image-preview",
    contents: "Create a picture of a nano banana dish...",
  });

  const base64Data = response.candidates[0].content.parts[0].inlineData?.data;
  if (!base64Data) throw new Error("이미지 생성 실패");

  // 2. Base64 데이터를 Node.js Buffer로 변환
  const inputBuffer = Buffer.from(base64Data, "base64");

  // 3. 서버 리소스를 사용하여 로컬 AI 모델로 배경(격자무늬) 제거
  // (서버에서는 최초 1회 실행 시에만 모델을 다운로드하여 캐싱하므로 이후엔 매우 빠릅니다)
  const cleanImageBlob = await removeBackground(inputBuffer);
  
  // 4. 최종 결과물을 Buffer로 변환하여 저장 또는 클라이언트에 응답
  const finalArrayBuffer = await cleanImageBlob.arrayBuffer();
  const finalBuffer = Buffer.from(finalArrayBuffer);

  fs.writeFileSync("gemini-final-transparent.png", finalBuffer);
  console.log("서버단에서 배경 제거까지 완벽히 처리하여 저장했습니다!");
}