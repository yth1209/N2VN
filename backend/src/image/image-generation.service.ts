import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { S3HelperService } from '../common/s3-helper.service';

import { Emotion, STYLE_UUIDS } from '../common/constants';
import { RepositoryProvider } from '../common/repository.provider';
import { CharacterImg } from '../entities/character-img.entity';
import { getCharacterPrompt } from './prompt/prompt';

@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name);
  private apiKey: string;
  private fluxModelId: string;
  private lucidModelId: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3HelperService: S3HelperService,
    private readonly repo: RepositoryProvider,
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

  async generateCharacterImages(novelId: number) {
    const novel = await this.repo.novel.findOne({ where: { id: novelId } });
    if (!novel) throw new HttpException('Novel not found', HttpStatus.NOT_FOUND);

    // 1. 해당 소설에 속하면서 genId가 NULL인(아직 생성되지 않은) 캐릭터 이미지 항목 조회
    const pendingImages = await this.repo.characterImg.createQueryBuilder('ci')
      .innerJoinAndSelect('ci._characterFk', 'char')
      .where('char.novelId = :novelId', { novelId })
      .andWhere('ci.genId IS NULL')
      .orWhere('ci.emotion = :emotion', {emotion: Emotion.DEFAULT})
      .getMany();

    if (pendingImages.length === 0) {
      return { success: true, message: 'No pending images' };
    }

    // 2. 캐릭터별로 그룹화
    const charGroups = Map.groupBy(pendingImages, (pi) => pi.characterId)

    const globalArtStyle = novel.characterArtStyle || '';
    const actualStyleKey = novel.characterStyleKey || 'DYNAMIC';
    const selectedStyleUUID = STYLE_UUIDS[actualStyleKey.toUpperCase()] || STYLE_UUIDS['DYNAMIC'];

    this.logger.log(`Starting selective image generation for ${charGroups.size} characters. Total pending emotions: ${pendingImages.length}`);

    // 3. 캐릭터별 병렬 처리
    const characterPromises = Array.from(charGroups.values()).map((pis) =>
      this.processCharacterSelective(novel.id, pis, globalArtStyle, selectedStyleUUID)
        .catch(err => this.logger.error(`Failed to process character ${pis[0].characterId}: ${err.message}`))
    );

    await Promise.all(characterPromises);
    this.logger.log('All pending character image generations completed.');
    return { success: true, message: 'Generation complete' };
  }

  async generateBackgroundImages(novelId: number) {
    const novel = await this.repo.novel.findOne({ where: { id: novelId } });
    if (!novel) throw new HttpException('Novel not found', HttpStatus.NOT_FOUND);

    const backgrounds = await this.repo.background.find({ where: { novelId } });
    if (!backgrounds || backgrounds.length === 0) {
      throw new HttpException('No backgrounds found for this novel', HttpStatus.BAD_REQUEST);
    }

    const globalBackgroundArtStyle = novel.backgroundArtStyle || '';
    const actualStyleKey = novel.backgroundStyleKey || 'DYNAMIC';
    const selectedStyleUUID = STYLE_UUIDS[actualStyleKey.toUpperCase()] || STYLE_UUIDS['DYNAMIC'];

    this.logger.log(`Starting background image generation for ${backgrounds.length} backgrounds. Art style: ${globalBackgroundArtStyle}. Leonardo StyleUUID: ${actualStyleKey}`);

    const bgPromises = backgrounds.map(async (bgInfo) => {
      this.logger.log(`[${bgInfo.id}] Generating background image...`);
      const prompt = `(${globalBackgroundArtStyle}:1.2), ${actualStyleKey} art style rendering, ${bgInfo.description}, masterpiece, empty scenery, highly detailed landscape, no characters`;

      try {
        const { buffer, imageId } = await this.generateImageToBuffer(prompt, this.fluxModelId, undefined, selectedStyleUUID, 1280, 720);
        await this.s3HelperService.uploadImage(`${novel.id}/backgrounds/${bgInfo.id}.png`, buffer, 'image/png');

        // Save generate background image id
        bgInfo.genId = imageId;
        await this.repo.background.save(bgInfo);

        this.logger.log(`[${bgInfo.id}] Background image generated and uploaded to S3. genId: ${imageId}`);
      } catch (err: any) {
        this.logger.error(`[${bgInfo.id}] Failed to generate background: ${err.message}`);
      }
    });

    await Promise.all(bgPromises);
    this.logger.log('All background generations completed successfully.');
    return { success: true, message: 'Background generation complete' };
  }

  private async processCharacterSelective(
    novelId: number, pendingCharImgs: CharacterImg[], globalArtStyle: string, styleUUID: string
  ) {
    // 1. DEFAULT 이미지 확보 (다른 모든 감정의 레퍼런스로 필요)
    let defaultImg = pendingCharImgs.find(pci => pci.emotion===Emotion.DEFAULT)
    if(!defaultImg) throw new HttpException('DEFAULT image not found', HttpStatus.BAD_REQUEST)

    const charId = defaultImg.characterId
    const charInfo=defaultImg._characterFk

    if (!defaultImg.genId) {
      this.logger.log(`[${charId}] Generating DEFAULT emotion as reference...`);
      const defaultPrompt = getCharacterPrompt(globalArtStyle, charInfo.look, Emotion.DEFAULT)
      const { buffer: defaultImageBuffer, imageId: generatedId } = await this.generateImageToBuffer(defaultPrompt, this.fluxModelId, undefined, styleUUID);
      defaultImg.genId = generatedId;

      await this.s3HelperService.uploadImage(`${novelId}/characters/${charId}_DEFAULT.png`, defaultImageBuffer, 'image/png');
      defaultImg.nobgGenId = await this.extractAndSaveNOBGDBSync(novelId, defaultImg);
      await this.repo.characterImg.save(defaultImg)

      this.logger.log(`[${charId}] DEFAULT reference generated (ID: ${defaultImg.genId}).`);
    }

    // 2. 나머지 요청된 감정들 생성 (DEFAULT는 위에서 처리되었을 수 있으므로 제외)
    const remainingEmotions = pendingCharImgs.filter(pci => pci.emotion !== Emotion.DEFAULT);
    if (remainingEmotions.length === 0) return;

    this.logger.log(`[${charId}] Generating remaining ${remainingEmotions.length} emotions...`);
    const emotionPromises = remainingEmotions.map(pci =>
      this.generateAndSaveEmotion(novelId, pci, globalArtStyle, defaultImg.genId, styleUUID)
        .catch(err => this.logger.error(`[${charId}] Failed to generate ${pci.emotion}: ${err.message}`))
    );

    await Promise.all(emotionPromises);
    this.logger.log(`[${charId}] Selected emotions generated.`);
  }

  private async generateAndSaveEmotion(
    novelId: number, cimg: CharacterImg, globalArtStyle: string, initImageId: string, styleUUID: string
  ) {
    const charId = cimg.characterId;
    this.logger.log(`[${charId}] Generating ${cimg.emotion}...`);
    const prompt = getCharacterPrompt(globalArtStyle, cimg._characterFk.look, cimg.emotion)
    const { buffer: imageBuffer, imageId: newGenId } = await this.generateImageToBuffer(prompt, this.lucidModelId, initImageId, styleUUID);
    cimg.genId = newGenId
    
    await this.s3HelperService.uploadImage(`${novelId}/characters/${charId}_${cimg.emotion}.png`, imageBuffer, 'image/png');
    this.logger.log(`[${charId}] ${cimg.emotion} emotion uploaded to S3.`);
    await this.repo.characterImg.save(cimg)
    
    // Automatically create NOBG right after and save to DB
    cimg.nobgGenId = await this.extractAndSaveNOBGDBSync(novelId, cimg);
    await this.repo.characterImg.save(cimg)
  }

  /**
   * 지정된 조건이 만족될 때까지 반복 확인하는 유틸리티
   */
  private async poll<T>(
    taskName: string,
    fn: () => Promise<T | null | undefined>
  ): Promise<T> {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const result = await fn();
      if (result) return result;
    }
    throw new Error(`${taskName} timeout after 180s`);
  }

  /**
   * NOBG 생성 및 DB upsert 로직 (Proactive)
   */
  private async extractAndSaveNOBGDBSync(novelId: number, cimg: CharacterImg) : Promise<string> {
    const targetName = `${cimg.characterId}_${cimg.emotion}`;
    let nobgGenId: string;
    try {
      this.logger.log(`[${targetName}] Generating NOBG via Leonardo API...`);
      const nobgRes = await axios.post('https://cloud.leonardo.ai/api/rest/v1/variations/nobg', {
        id: cimg.genId
      }, { headers: this.getHeaders() });
      const sdNobgJobId = nobgRes.data?.sdNobgJob?.id;

      if (!sdNobgJobId) {
        this.logger.warn(`[${targetName}] Job ID not found for nobg.`);
      } else {
        const nobgUrl = await this.poll(
          `NOBG [${targetName}]`,
          async () => {
            const varRes = await axios.get(`https://cloud.leonardo.ai/api/rest/v1/variations/${sdNobgJobId}`, {
              headers: this.getHeaders(),
            });
            const variants = varRes.data?.generated_image_variation_generic;
            if (variants && variants.length > 0) {
              const nobgVar = variants.find((v: any) => v.transformType === 'NOBG');
              if (nobgVar && nobgVar.url) {
                nobgGenId = nobgVar.id;
                return nobgVar.url as string;
              }
            }
            return null;
          }
        );

        if (nobgUrl) {
          const dlRes = await axios.get(nobgUrl, { responseType: 'arraybuffer' });
          await this.s3HelperService.uploadImage(`${novelId}/characters/${targetName}_NOBG.png`, dlRes.data, 'image/png');
          this.logger.log(`[${targetName}] NOBG successfully saved to S3.`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[${targetName}] NOBG Extraction Failed: ${err.message}`);
    }

    // Save mapping to Database
    return nobgGenId
  }

  /**
   * Leonardo API 기본 생성 파이프라인 (요청 -> 폴링 -> 다운로드 -> 버퍼 반환)
   */
  private async generateImageToBuffer(prompt: string, modelId: string, initImageId?: string, styleUUID?: string, width = 576, height = 1024): Promise<{ buffer: Buffer, imageId: string }> {
    const payload: any = {
      model: "flux-pro-2.0",
      public: false,
      parameters: {
        width,
        height,
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
            strength: "HIGH"
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
      const completedData = await this.poll(
        `Generation [${generationId}]`,
        async () => {
          const statusRes = await axios.get(`https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`, {
            headers: this.getHeaders(),
          });
          const generation = statusRes.data?.generations_by_pk;
          if (generation.status === 'COMPLETE') {
            return generation;
          } else if (generation.status === 'FAILED') {
            throw new Error('Leonardo Generation failed.');
          }
          return null;
        }
      );

      if (!completedData || !completedData.generated_images || completedData.generated_images.length === 0) {
        throw new Error('Generation timeout or empty images from Leonardo.');
      }

      const imageUrl = completedData.generated_images[0].url;
      const imageId = completedData.generated_images[0].id; // Extract generated_image ID
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      return { buffer: Buffer.from(imgRes.data, 'binary'), imageId };

    } catch (error: any) {
      this.logger.error('Leonardo generation error:', error?.response?.data || error.message);
      throw error;
    }
  }
}
