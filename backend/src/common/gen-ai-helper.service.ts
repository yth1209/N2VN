import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { GoogleGenAI, JobState } from '@google/genai';
import { ZodSchema } from 'zod';
import axios from 'axios';
import FormData from 'form-data';

@Injectable()
export class GenAIHelperService {
  private readonly logger      = new Logger(GenAIHelperService.name);
  private readonly geminiModel:      ChatGoogleGenerativeAI;
  private readonly lyriaAI:          GoogleGenAI;
  private readonly lyriaModel:       string;
  private readonly geminiImageAI:    GoogleGenAI;
  private readonly geminiImageModel: string;
  private readonly leonardoKey:      string;
  private readonly photoroomKey:     string;

  constructor(private readonly configService: ConfigService) {
    const geminiApiKey = this.configService.get<string>('GEMINI_API_KEY') ?? '';

    this.geminiModel = new ChatGoogleGenerativeAI({
      model:       this.configService.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash',
      temperature: 0.1,
      apiKey:      geminiApiKey,
    });

    this.lyriaAI    = new GoogleGenAI({ apiKey: geminiApiKey });
    this.lyriaModel = this.configService.get<string>('LYRIA_MODEL') ?? 'lyria-3-clip-preview';

    this.geminiImageAI    = new GoogleGenAI({ apiKey: geminiApiKey });
    this.geminiImageModel = this.configService.get<string>('GEMINI_IMAGE_MODEL') ?? 'gemini-3-pro-image-preview';

    this.leonardoKey =
      this.configService.get<string>('LEONARDO_AI_API_KEY') ||
      this.configService.get<string>('LEONARDO_API_KEY') ||
      '';

    this.photoroomKey = this.configService.get<string>('PHOTOROOM_API_KEY') ?? '';
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
    const result = await this.lyriaAI.models.generateContent({
      model:    this.lyriaModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config:   { responseModalities: ['AUDIO'] } as any,
    });

    const parts = result.candidates?.[0]?.content?.parts ?? [];
    const inlineData = parts.find((p: any) => p.inlineData)?.inlineData;
    if (!inlineData?.data) throw new Error('Lyria: audio data 없음');

    return Buffer.from(inlineData.data, 'base64');
  }

  // ── Gemini Image ────────────────────────────────────────────────────────────

  /**
   * Gemini 이미지 생성.
   * initImageBuffer가 있으면 image-to-image (감정 이미지), 없으면 text-to-image.
   * aspectRatio / imageSize로 출력 크기 제어.
   */
  async geminiGenerateImage(
    prompt:           string,
    initImageBuffer?: Buffer,
    aspectRatio:      string = '1:1',
    imageSize:        string = '1K',
  ): Promise<{ buffer: Buffer }> {
    const parts: any[] = [{ text: prompt }];

    if (initImageBuffer) {
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data:     initImageBuffer.toString('base64'),
        },
      });
    }

    const response = await this.geminiImageAI.models.generateContent({
      model:    this.geminiImageModel,
      contents: parts,
      config:   {
        responseModalities: ['IMAGE', 'TEXT'],
        responseFormat: {
          image: { aspectRatio, imageSize },
        },
      } as any,
    });

    const inlineData = response.candidates?.[0]?.content?.parts
      ?.find((p: any) => p.inlineData)?.inlineData;

    if (!inlineData?.data) throw new Error('Gemini: image data 없음');

    return { buffer: Buffer.from(inlineData.data, 'base64') };
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

  // ── Background Removal ───────────────────────────────────────────────────────

  async removeImageBackground(inputBuffer: Buffer): Promise<Buffer> {
    const form = new FormData();
    form.append('image_file', inputBuffer, { filename: 'image.png', contentType: 'image/png' });

    const response = await axios.post(
      'https://sdk.photoroom.com/v1/segment',
      form,
      {
        headers: { ...form.getHeaders(), 'x-api-key': this.photoroomKey },
        responseType: 'arraybuffer',
      },
    );

    return Buffer.from(response.data);
  }

  // ── Gemini Batch Image ──────────────────────────────────────────────────────

  /**
   * 여러 이미지 생성 요청을 Gemini Batch API로 일괄 제출.
   * batches.create()는 잡 핸들만 즉시 반환하므로, pollBatchJob()으로 완료를 기다린다.
   * 응답 순서는 요청 순서와 동일(index 매핑 보장).
   */
  async geminiBatchGenerateImages(
    requests: Array<{
      prompt:           string;
      initImageBuffer?: Buffer;
      aspectRatio?:     string;
      imageSize?:       string;
      metadata?:        Record<string, string>;
    }>,
  ): Promise<Array<{ buffer?: Buffer; error?: { message: string }; metadata?: Record<string, string> }>> {
    const inlinedRequests = requests.map((req) => {
      const parts: any[] = [{ text: req.prompt }];
      if (req.initImageBuffer) {
        parts.push({
          inlineData: { mimeType: 'image/png', data: req.initImageBuffer.toString('base64') },
        });
      }
      return {
        contents: parts,
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
          responseFormat: { image: { aspectRatio: req.aspectRatio ?? '1:1', imageSize: req.imageSize ?? '1K' } },
        } as any,
        ...(req.metadata ? { metadata: req.metadata } : {}),
      };
    });

    const job = await this.geminiImageAI.batches.create({
      model: this.geminiImageModel,
      src:   inlinedRequests,
    });
    this.logger.log(`[Batch] 잡 제출: ${job.name} (${requests.length}개 요청)`);

    const completedJob = await this.pollBatchJob(job.name);
    const responses = completedJob.dest?.inlinedResponses ?? [];

    return responses.map((resp: any, i: number) => {
      const metadata = requests[i]?.metadata;
      if (resp.error) {
        return { error: { message: resp.error.message ?? 'Unknown error' }, metadata };
      }
      const inlineData = resp.response?.candidates?.[0]?.content?.parts
        ?.find((p: any) => p.inlineData)?.inlineData;
      if (!inlineData?.data) {
        return { error: { message: 'Gemini batch: image data 없음' }, metadata };
      }
      return { buffer: Buffer.from(inlineData.data, 'base64'), metadata };
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

  // Batch API 전용 폴링 — 10s 간격, 최대 2시간 대기
  private async pollBatchJob(name: string): Promise<any> {
    const INTERVAL_MS  = 10_000;
    const MAX_ATTEMPTS = 720;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      const job = await this.geminiImageAI.batches.get({ name });
      this.logger.log(`[Batch] ${name} 상태: ${job.state} (${i + 1}/${MAX_ATTEMPTS})`);
      if (job.state === JobState.JOB_STATE_SUCCEEDED) return job;
      if ([JobState.JOB_STATE_FAILED, JobState.JOB_STATE_CANCELLED, JobState.JOB_STATE_EXPIRED].includes(job.state)) {
        throw new Error(`Batch job ${name} 실패: ${job.state}`);
      }
    }
    throw new Error(`Batch job ${name} 타임아웃 (${(MAX_ATTEMPTS * INTERVAL_MS) / 1000}s)`);
  }
}
