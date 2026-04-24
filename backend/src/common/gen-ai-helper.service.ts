import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ZodSchema } from 'zod';
import axios from 'axios';

@Injectable()
export class GenAIHelperService {
  private readonly logger      = new Logger(GenAIHelperService.name);
  private readonly geminiModel: ChatGoogleGenerativeAI;
  private readonly lyriaAI:    GoogleGenerativeAI;
  private readonly lyriaModel: string;
  private readonly leonardoKey: string;

  constructor(private readonly configService: ConfigService) {
    const geminiApiKey = this.configService.get<string>('GEMINI_API_KEY') ?? '';

    this.geminiModel = new ChatGoogleGenerativeAI({
      model:       this.configService.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash',
      temperature: 0.1,
      apiKey:      geminiApiKey,
    });

    this.lyriaAI    = new GoogleGenerativeAI(geminiApiKey);
    this.lyriaModel = this.configService.get<string>('LYRIA_MODEL') ?? 'lyria-3-clip-preview';

    this.leonardoKey =
      this.configService.get<string>('LEONARDO_AI_API_KEY') ||
      this.configService.get<string>('LEONARDO_API_KEY') ||
      '';
  }

  // ── Gemini (LangChain) ──────────────────────────────────────────────────────

  /**
   * LangChain 체인 실행 후 Zod 스키마로 파싱된 결과 반환.
   * ParsingService의 모든 LLM 호출에 사용.
   */
  async geminiParse<T>(
    template:       string,
    inputVariables: string[],
    schema:         ZodSchema<T>,
    variables:      Record<string, string>,
  ): Promise<T> {
    const parser         = StructuredOutputParser.fromZodSchema(schema);
    const promptTemplate = new PromptTemplate({
      template,
      inputVariables,
      partialVariables: { format_instructions: parser.getFormatInstructions() },
    });
    const chain = promptTemplate.pipe(this.geminiModel).pipe(parser);
    return chain.invoke(variables) as Promise<T>;
  }

  // ── Lyria 3 Clip ────────────────────────────────────────────────────────────

  /**
   * Lyria 3 Clip으로 MP3 클립 생성 후 Buffer 반환.
   * BgmService에서 S3 업로드 전 단계로 호출.
   */
  async lyriaGenerateClip(prompt: string): Promise<Buffer> {
    const model = this.lyriaAI.getGenerativeModel(
      { model: this.lyriaModel },
      { apiVersion: 'v1beta' },
    );

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { audioEncoding: 'MP3' } as any,
      } as any,
    });

    const inlineData = result.response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) throw new Error('Lyria: audio data 없음');

    return Buffer.from(inlineData.data, 'base64');
  }

  // ── Leonardo AI ─────────────────────────────────────────────────────────────

  private getLeonardoHeaders() {
    return {
      accept:          'application/json',
      'content-type':  'application/json',
      authorization:   `Bearer ${this.leonardoKey}`,
    };
  }

  /**
   * Leonardo AI로 이미지 생성 후 완료까지 폴링, Buffer + imageId 반환.
   * ImageService의 캐릭터·배경 이미지 생성에 사용.
   */
  async leonardoGenerateImage(
    prompt:       string,
    initImageId?: string,
    styleUUID?:   string,
    width  = 576,
    height = 1024,
  ): Promise<{ buffer: Buffer; imageId: string }> {
    const payload: any = {
      model:      'flux-pro-2.0',
      public:     false,
      parameters: { width, height, quantity: 1, prompt },
    };

    if (styleUUID) payload.parameters.styleUUID = styleUUID;
    if (initImageId) {
      payload.parameters.guidances = {
        image_reference: [{ image: { id: initImageId, type: 'GENERATED' }, strength: 'HIGH' }],
      };
    }

    const response = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v2/generations',
      payload,
      { headers: this.getLeonardoHeaders() },
    );
    const generationId = response.data?.generate?.generationId;
    if (!generationId) throw new Error('Leonardo: generationId 획득 실패');

    const completedData = await this.poll(`Generation [${generationId}]`, async () => {
      const statusRes = await axios.get(
        `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
        { headers: this.getLeonardoHeaders() },
      );
      const gen = statusRes.data?.generations_by_pk;
      if (gen?.status === 'COMPLETE') return gen;
      if (gen?.status === 'FAILED')   throw new Error('Leonardo generation failed');
      return null;
    });

    const imageUrl = completedData.generated_images[0].url;
    const imageId  = completedData.generated_images[0].id;
    const imgRes   = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    return { buffer: Buffer.from(imgRes.data, 'binary'), imageId };
  }

  /**
   * Leonardo NOBG 변환 요청 후 폴링, 완성된 NOBG URL + nobgGenId 반환.
   * 실패 시 null 반환 (ImageService에서 경고 처리).
   */
  async leonardoNobg(genId: string): Promise<{ url: string; nobgGenId: string } | null> {
    const nobgRes = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v1/variations/nobg',
      { id: genId },
      { headers: this.getLeonardoHeaders() },
    );
    const sdNobgJobId = nobgRes.data?.sdNobgJob?.id;
    if (!sdNobgJobId) {
      this.logger.warn(`[NOBG] Job ID 없음 (genId: ${genId})`);
      return null;
    }

    return this.poll(`NOBG [${sdNobgJobId}]`, async () => {
      const varRes   = await axios.get(
        `https://cloud.leonardo.ai/api/rest/v1/variations/${sdNobgJobId}`,
        { headers: this.getLeonardoHeaders() },
      );
      const variants = varRes.data?.generated_image_variation_generic;
      if (variants?.length > 0) {
        const nobgVar = variants.find((v: any) => v.transformType === 'NOBG');
        if (nobgVar?.url) return { url: nobgVar.url as string, nobgGenId: nobgVar.id as string };
      }
      return null;
    });
  }

  // ── 공통 유틸 ────────────────────────────────────────────────────────────────

  private async poll<T>(taskName: string, fn: () => Promise<T | null>): Promise<T> {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const result = await fn();
      if (result) return result;
    }
    throw new Error(`${taskName} timeout after 180s`);
  }
}
