import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { S3HelperService } from '../common/s3-helper.service';

import { ALL_EMOTIONS, REST_EMOTIONS, STYLE_UUIDS } from '../common/constants';

@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name);
  private apiKey: string;
  private fluxModelId: string;
  private lucidModelId: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3HelperService: S3HelperService,
  ) {
    this.apiKey = this.configService.get<string>('LEONARDO_AI_API_KEY') || this.configService.get<string>('LEONARDO_API_KEY') || '';
    this.fluxModelId = this.configService.get<string>('LEONARDO_FLUX_MODEL_ID') || '';
    this.lucidModelId = this.configService.get<string>('LEONARDO_LUCID_MODEL_ID') || '';
  }

  private getHeaders() {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  async generateCharacterImages(novelTitle: string) {
    let charactersData: any;
    try {
      charactersData = await this.s3HelperService.readJson(`${novelTitle}/characters.json`);
    } catch (e) {
      throw new HttpException(`Failed to read characters.json from S3 for ${novelTitle}`, HttpStatus.BAD_REQUEST);
    }

    const { globalArtStyle, styleKey, characters } = charactersData;
    if (!characters) {
      throw new HttpException('Invalid characters.json format', HttpStatus.BAD_REQUEST);
    }

    const actualStyleKey = styleKey || 'DYNAMIC';
    this.logger.log(`Starting image generation for ${Object.keys(characters).length} characters. Art style: ${globalArtStyle}. Leonardo StyleUUID: ${actualStyleKey}`);

    const selectedStyleUUID = STYLE_UUIDS[actualStyleKey.toUpperCase()] || STYLE_UUIDS['DYNAMIC'];

    // 캐릭터 별로 병렬 처리 수행
    const characterPromises = Object.entries(characters).map(([charId, charInfo]) =>
      this.processCharacter(novelTitle, charId, charInfo as any, globalArtStyle, selectedStyleUUID)
        .catch(err => this.logger.error(`Failed to process character ${charId}: ${err.message}`))
    );

    // 전체 완료 대기
    await Promise.all(characterPromises);
    this.logger.log('All image generations completed successfully.');
    return { success: true, message: 'Generation complete' };
  }

  private async processCharacter(novelTitle: string, charId: string, charInfo: any, globalArtStyle: string, styleUUID: string) {
    // 1. DEFAULT 먼저 순차 생성
    this.logger.log(`[${charId}] Generating DEFAULT emotion...`);
    const defaultPrompt = `(${globalArtStyle}:1.2), ${charInfo.look}, full body shot, full length portrait, showing entire body from head to feet, standing, zoomed out, distant angle, isolated on a simple solid white background, no background, expression: default, neutral expression`;
    const { buffer: defaultImageBuffer, imageId: initImageId } = await this.generateImageToBuffer(defaultPrompt, this.fluxModelId, undefined, undefined, styleUUID);

    await this.s3HelperService.uploadImage(`${novelTitle}/characters/${charId}_DEFAULT.png`, defaultImageBuffer, 'image/png');
    this.logger.log(`[${charId}] DEFAULT emotion generated and uploaded to S3 (Generated ID: ${initImageId}).`);

    // 2. 나머지 9개 감정 병렬 생성 (생성된 initImageId 바로 사용)
    const emotionPromises = REST_EMOTIONS.map(emotion =>
      this.generateAndSaveEmotion(novelTitle, charId, charInfo, globalArtStyle, emotion, initImageId, styleUUID)
        .catch(err => this.logger.error(`[${charId}] Failed to generate ${emotion}: ${err.message}`))
    );

    await Promise.all(emotionPromises);
    this.logger.log(`[${charId}] All emotions generated.`);
  }

  private async generateAndSaveEmotion(
    novelTitle: string, charId: string, charInfo: any, globalArtStyle: string, emotion: string, initImageId: string, styleUUID: string
  ) {
    this.logger.log(`[${charId}] Generating ${emotion}...`);
    const prompt = `(${globalArtStyle}:1.2), ${charInfo.look}, full body shot, full length portrait, showing entire body from head to feet, standing, zoomed out, distant angle, isolated on a simple solid white background, no background, expression: ${emotion.toLowerCase()}`;
    // initStrength: 0.5 (원본 이미지 의존도) - 값이 클수록 원본을 덜 바꿈. 0.3 ~ 0.5 수준 유지.
    const { buffer: imageBuffer } = await this.generateImageToBuffer(prompt, this.lucidModelId, initImageId, 0.45, styleUUID);

    await this.s3HelperService.uploadImage(`${novelTitle}/characters/${charId}_${emotion}.png`, imageBuffer, 'image/png');
    this.logger.log(`[${charId}] ${emotion} emotion uploaded to S3.`);
  }

  /**
   * Leonardo API 기본 생성 파이프라인 (요청 -> 폴링 -> 다운로드 -> 버퍼 반환)
   */
  private async generateImageToBuffer(prompt: string, modelId: string, initImageId?: string, initStrength?: number, styleUUID?: string): Promise<{ buffer: Buffer, imageId: string }> {
    const payload: any = {
      model: "flux-pro-2.0",
      public: false,
      parameters: {
        width: 576,
        height: 1024,
        quantity: 1,
        prompt,
      }
    };

    if (initImageId) {
      payload.parameters.guidances = {
        image_reference: [
          {
            image: {
                id: initImageId,
                type: "GENERATED"
            },
            strength: initStrength && initStrength > 0.4 ? "HIGH" : "MID"
          }
        ]
      };
    }

    try {
      const response = await axios.post('https://cloud.leonardo.ai/api/rest/v2/generations', payload, { headers: this.getHeaders() });
      const generationId = response.data?.generate?.generationId;

      if (!generationId) {
        throw new Error('Failed to start generation logic from Leonardo API.');
      }

      // 폴링 로직
      let completedData: any = null;
      for (let i = 0; i < 30; i++) { // 최대 30회 (약 90초) 대기
        await new Promise(r => setTimeout(r, 3000));
        const statusRes = await axios.get(`https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`, { headers: this.getHeaders() });
        const generation = statusRes.data?.generations_by_pk;
        if (generation.status === 'COMPLETE') {
          completedData = generation;
          break;
        } else if (generation.status === 'FAILED') {
          throw new Error('Leonardo Generation failed.');
        }
      }

      if (!completedData || !completedData.generated_images || completedData.generated_images.length === 0) {
        throw new Error('Generation timeout or empty images from Leonardo.');
      }

      const imageUrl = completedData.generated_images[0].url;
      const imageId = completedData.generated_images[0].id;
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      return { buffer: Buffer.from(imgRes.data, 'binary'), imageId };

    } catch (error: any) {
      this.logger.error('Leonardo generation error:', error?.response?.data || error.message);
      throw error;
    }
  }
}
