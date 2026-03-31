import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { S3HelperService } from '../common/s3-helper.service';

import { Emotion, STYLE_UUIDS } from '../common/constants';
import { Character } from '../entities/character.entity';
import { RepositoryProvider } from '../common/repository.provider';

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
      .getMany();

    if (pendingImages.length === 0) {
      this.logger.log('No pending character images to generate.');
      return { success: true, message: 'No pending images' };
    }

    // 2. 캐릭터별로 그룹화
    const charGroups = new Map<string, { char: Character, emotions: Emotion[] }>();
    for (const pi of pendingImages) {
      if (!charGroups.has(pi.characterId)) {
        charGroups.set(pi.characterId, { char: pi._characterFk, emotions: [] });
      }
      charGroups.get(pi.characterId).emotions.push(pi.emotion);
    }

    const globalArtStyle = novel.characterArtStyle || '';
    const actualStyleKey = novel.characterStyleKey || 'DYNAMIC';
    const selectedStyleUUID = STYLE_UUIDS[actualStyleKey.toUpperCase()] || STYLE_UUIDS['DYNAMIC'];

    this.logger.log(`Starting selective image generation for ${charGroups.size} characters. Total pending emotions: ${pendingImages.length}`);

    // 3. 캐릭터별 병렬 처리
    const characterPromises = Array.from(charGroups.values()).map(({ char, emotions }) =>
      this.processCharacterSelective(novel.id, char, emotions, globalArtStyle, selectedStyleUUID)
        .catch(err => this.logger.error(`Failed to process character ${char.id}: ${err.message}`))
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
        const { buffer, imageId } = await this.generateImageToBuffer(prompt, this.fluxModelId, undefined, undefined, selectedStyleUUID, 1280, 720);
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
    novelId: number, charInfo: Character, targetEmotions: Emotion[], globalArtStyle: string, styleUUID: string
  ) {
    const charId = charInfo.id;

    // 1. DEFAULT 이미지 확보 (다른 모든 감정의 레퍼런스로 필요)
    let defaultImg = await this.repo.characterImg.findOne({ where: { characterId: charId, emotion: Emotion.DEFAULT } });
    let initImageId = defaultImg?.genId;

    if (!initImageId) {
      this.logger.log(`[${charId}] Generating DEFAULT emotion as reference...`);
      const defaultPrompt = `(${globalArtStyle}:1.2), ${charInfo.look}, full body shot, full length portrait, showing entire body from head to feet, standing, zoomed out, distant angle, isolated on a simple solid white background, no background, expression: default, neutral expression`;
      const { buffer: defaultImageBuffer, imageId: generatedId } = await this.generateImageToBuffer(defaultPrompt, this.fluxModelId, undefined, undefined, styleUUID);

      await this.s3HelperService.uploadImage(`${novelId}/characters/${charId}_DEFAULT.png`, defaultImageBuffer, 'image/png');
      await this.extractAndSaveNOBGDBSync(novelId, charId, Emotion.DEFAULT, generatedId);
      initImageId = generatedId;
      this.logger.log(`[${charId}] DEFAULT reference generated (ID: ${initImageId}).`);
    }

    // 2. 나머지 요청된 감정들 생성 (DEFAULT는 위에서 처리되었을 수 있으므로 제외)
    const remainingEmotions = targetEmotions.filter(e => e !== Emotion.DEFAULT);
    if (remainingEmotions.length === 0) return;

    this.logger.log(`[${charId}] Generating remaining ${remainingEmotions.length} emotions...`);
    const emotionPromises = remainingEmotions.map(emotion =>
      this.generateAndSaveEmotion(novelId, charInfo, globalArtStyle, emotion as Emotion, initImageId, styleUUID)
        .catch(err => this.logger.error(`[${charId}] Failed to generate ${emotion}: ${err.message}`))
    );

    await Promise.all(emotionPromises);
    this.logger.log(`[${charId}] Selected emotions generated.`);
  }

  private async generateAndSaveEmotion(
    novelId: number, charInfo: Character, globalArtStyle: string, emotion: Emotion, initImageId: string, styleUUID: string
  ) {
    const charId = charInfo.id;
    this.logger.log(`[${charId}] Generating ${emotion}...`);
    const prompt = `(${globalArtStyle}:1.2), ${charInfo.look}, full body shot, full length portrait, showing entire body from head to feet, standing, zoomed out, distant angle, isolated on a simple solid white background, no background, expression: ${emotion.toLowerCase()}`;

    // initStrength: 0.5 (원본 이미지 의존도)
    const { buffer: imageBuffer, imageId: newGenId } = await this.generateImageToBuffer(prompt, this.lucidModelId, initImageId, 0.45, styleUUID);

    await this.s3HelperService.uploadImage(`${novelId}/characters/${charId}_${emotion}.png`, imageBuffer, 'image/png');
    this.logger.log(`[${charId}] ${emotion} emotion uploaded to S3.`);

    // Automatically create NOBG right after and save to DB
    await this.extractAndSaveNOBGDBSync(novelId, charId, emotion, newGenId);
  }

  /**
   * NOBG 생성 및 DB upsert 로직 (Proactive)
   */
  private async extractAndSaveNOBGDBSync(novelId: number, characterId: string, emotion: Emotion, genId: string) {
    const targetName = `${characterId}_${emotion}`;
    let nobgGenId = null;

    try {
      this.logger.log(`[${targetName}] Generating NOBG via Leonardo API...`);
      const nobgRes = await axios.post('https://cloud.leonardo.ai/api/rest/v1/variations/nobg', {
        id: genId,
        isVariation: false
      }, { headers: this.getHeaders() });
      const sdNobgJobId = nobgRes.data?.sdNobgJob?.id;

      if (!sdNobgJobId) {
        this.logger.warn(`[${targetName}] Job ID not found for nobg.`);
      } else {
        let nobgUrl = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 4000));
          const varRes = await axios.get(`https://cloud.leonardo.ai/api/rest/v1/variations/${genId}`, { headers: this.getHeaders() });
          const variants = varRes.data?.generated_image_variation_generic;
          if (variants && variants.length > 0) {
            const nobgVar = variants.find((v: any) => v.transformType === 'BACKGROUND_REMOVAL');
            if (nobgVar && nobgVar.url) {
              nobgUrl = nobgVar.url;
              nobgGenId = nobgVar.id;
              break;
            }
          }
        }
''
        if (nobgUrl) {
          const dlRes = await axios.get(nobgUrl, { responseType: 'arraybuffer' });
          await this.s3HelperService.uploadImage(`${novelId}/characters/${targetName}_NOBG.png`, dlRes.data, 'image/png');
          this.logger.log(`[${targetName}] NOBG successfully saved to S3.`);
        } else {
          this.logger.warn(`[${targetName}] NOBG Generation Timeout.`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[${targetName}] NOBG Extraction Failed: ${err.message}`);
    }

    // Save mapping to Database
    try {
      const charImg = this.repo.characterImg.create({
        characterId,
        emotion,
        genId,
        nobgGenId: nobgGenId
      });
      await this.repo.characterImg.save(charImg);
    } catch (e: any) {
      // Primary key collision? (If we run generation twice for the same char/emotion)
      this.logger.warn(`Failed to insert into CharacterImg (Upsert logic might be needed): ${e.message}`);
      const existing = await this.repo.characterImg.findOne({ where: { characterId, emotion } });
      if (existing) {
        existing.genId = genId;
        existing.nobgGenId = nobgGenId;
        await this.repo.characterImg.save(existing);
      }
    }
  }

  /**
   * Leonardo API 기본 생성 파이프라인 (요청 -> 폴링 -> 다운로드 -> 버퍼 반환)
   */
  private async generateImageToBuffer(prompt: string, modelId: string, initImageId?: string, initStrength?: number, styleUUID?: string, width = 576, height = 1024): Promise<{ buffer: Buffer, imageId: string }> {
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
      const imageId = completedData.generated_images[0].id; // Extract generated_image ID
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      return { buffer: Buffer.from(imgRes.data, 'binary'), imageId };

    } catch (error: any) {
      this.logger.error('Leonardo generation error:', error?.response?.data || error.message);
      throw error;
    }
  }
}
