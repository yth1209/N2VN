import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { S3HelperService } from '../common/s3-helper.service';
import { Emotion, STYLE_UUIDS } from '../common/constants';
import { RepositoryProvider } from '../common/repository.provider';
import { CharacterImg } from '../entities/character-img.entity';
import { getCharacterPrompt } from './prompt/prompt';

@Injectable()
export class ImageService {
  private readonly logger = new Logger(ImageService.name);
  private readonly apiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3HelperService: S3HelperService,
    private readonly repo: RepositoryProvider,
  ) {
    this.apiKey =
      this.configService.get<string>('LEONARDO_AI_API_KEY') ||
      this.configService.get<string>('LEONARDO_API_KEY') ||
      '';
  }

  private getHeaders() {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  async generateCharacterImages(seriesId: string): Promise<void> {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    // bug #2 수정: seriesId 기준으로 필터링 후 genId IS NULL인 항목만 조회
    const pendingImages = await this.repo.characterImg
      .createQueryBuilder('ci')
      .innerJoinAndSelect('ci._characterFk', 'c')
      .where('c.seriesId = :seriesId', { seriesId })
      .andWhere('ci.genId IS NULL')
      .getMany();

    if (pendingImages.length === 0) {
      this.logger.log(`[${seriesId}] 생성 대기 중인 캐릭터 이미지 없음`);
      return;
    }

    const charGroups = Map.groupBy(pendingImages, (pi) => pi.characterId);

    const globalArtStyle   = series.characterArtStyle || '';
    const actualStyleKey   = series.characterStyleKey || 'DYNAMIC';
    const selectedStyleUUID = STYLE_UUIDS[actualStyleKey.toUpperCase()] || STYLE_UUIDS['DYNAMIC'];

    this.logger.log(
      `[${seriesId}] 캐릭터 이미지 생성 시작: ${charGroups.size}명, 총 ${pendingImages.length}개 감정`,
    );

    const characterPromises = Array.from(charGroups.values()).map((pis) =>
      this.processCharacter(seriesId, pis, globalArtStyle, selectedStyleUUID).catch((err) =>
        this.logger.error(`[${pis[0].characterId}] 처리 실패: ${err.message}`),
      ),
    );

    await Promise.all(characterPromises);
    this.logger.log(`[${seriesId}] 모든 캐릭터 이미지 생성 완료`);
  }

  async generateBackgroundImages(seriesId: string): Promise<void> {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const backgrounds = await this.repo.background.find({ where: { seriesId } });
    if (!backgrounds || backgrounds.length === 0) {
      this.logger.log(`[${seriesId}] 배경 없음`);
      return;
    }

    const globalBgArtStyle  = series.backgroundArtStyle || '';
    const actualStyleKey    = series.backgroundStyleKey || 'DYNAMIC';
    const selectedStyleUUID = STYLE_UUIDS[actualStyleKey.toUpperCase()] || STYLE_UUIDS['DYNAMIC'];

    this.logger.log(`[${seriesId}] 배경 이미지 생성 시작: ${backgrounds.length}개`);

    const bgPromises = backgrounds.map(async (bg) => {
      if (bg.genId) return; // 이미 생성된 배경 건너뜀
      try {
        const prompt = `(${globalBgArtStyle}:1.2), ${actualStyleKey} art style rendering, ${bg.description}, masterpiece, empty scenery, highly detailed landscape, no characters`;
        const { buffer, imageId } = await this.generateImageToBuffer(
          prompt, undefined, selectedStyleUUID, 1280, 720,
        );
        await this.s3HelperService.uploadImage(
          `series/${seriesId}/backgrounds/${bg.id}.png`, buffer, 'image/png',
        );
        bg.genId = imageId;
        await this.repo.background.save(bg);
        this.logger.log(`[${bg.id}] 배경 이미지 생성 완료`);
      } catch (err: any) {
        this.logger.error(`[${bg.id}] 배경 생성 실패: ${err.message}`);
      }
    });

    await Promise.all(bgPromises);
    this.logger.log(`[${seriesId}] 모든 배경 이미지 생성 완료`);
  }

  private async processCharacter(
    seriesId: string,
    pendingCharImgs: CharacterImg[],
    globalArtStyle: string,
    styleUUID: string,
  ): Promise<void> {
    let defaultImg = pendingCharImgs.find((pci) => pci.emotion === Emotion.DEFAULT);
    if (!defaultImg) throw new HttpException('DEFAULT image entry not found', HttpStatus.BAD_REQUEST);

    const charId   = defaultImg.characterId;
    const charInfo = defaultImg._characterFk;

    if (!defaultImg.genId) {
      this.logger.log(`[${charId}] DEFAULT 이미지 생성 중...`);
      const defaultPrompt = getCharacterPrompt(globalArtStyle, charInfo.look, Emotion.DEFAULT);
      const { buffer, imageId } = await this.generateImageToBuffer(defaultPrompt, undefined, styleUUID);
      defaultImg.genId = imageId;

      await this.s3HelperService.uploadImage(
        `series/${seriesId}/characters/${charId}/DEFAULT.png`, buffer, 'image/png',
      );
      defaultImg.nobgGenId = await this.extractAndSaveNobg(seriesId, defaultImg);
      await this.repo.characterImg.save(defaultImg);
      this.logger.log(`[${charId}] DEFAULT 생성 완료 (genId: ${imageId})`);
    }

    const remaining = pendingCharImgs.filter((pci) => pci.emotion !== Emotion.DEFAULT);
    if (remaining.length === 0) return;

    const emotionPromises = remaining.map((pci) =>
      this.generateEmotion(seriesId, pci, globalArtStyle, defaultImg.genId, styleUUID).catch((err) =>
        this.logger.error(`[${charId}] ${pci.emotion} 감정 생성 실패: ${err.message}`),
      ),
    );

    await Promise.all(emotionPromises);
  }

  private async generateEmotion(
    seriesId: string,
    cimg: CharacterImg,
    globalArtStyle: string,
    initImageId: string,
    styleUUID: string,
  ): Promise<void> {
    const charId = cimg.characterId;
    const prompt = getCharacterPrompt(globalArtStyle, cimg._characterFk.look, cimg.emotion);
    const { buffer, imageId } = await this.generateImageToBuffer(prompt, initImageId, styleUUID);
    cimg.genId = imageId;

    await this.s3HelperService.uploadImage(
      `series/${seriesId}/characters/${charId}/${cimg.emotion}.png`, buffer, 'image/png',
    );
    cimg.nobgGenId = await this.extractAndSaveNobg(seriesId, cimg);
    await this.repo.characterImg.save(cimg);
  }

  private async extractAndSaveNobg(seriesId: string, cimg: CharacterImg): Promise<string> {
    const targetName = `${cimg.characterId}_${cimg.emotion}`;
    let nobgGenId: string;
    try {
      const nobgRes = await axios.post(
        'https://cloud.leonardo.ai/api/rest/v1/variations/nobg',
        { id: cimg.genId },
        { headers: this.getHeaders() },
      );
      const sdNobgJobId = nobgRes.data?.sdNobgJob?.id;
      if (!sdNobgJobId) { this.logger.warn(`[${targetName}] NOBG Job ID 없음`); return nobgGenId; }

      const nobgUrl = await this.poll(`NOBG [${targetName}]`, async () => {
        const varRes = await axios.get(
          `https://cloud.leonardo.ai/api/rest/v1/variations/${sdNobgJobId}`,
          { headers: this.getHeaders() },
        );
        const variants = varRes.data?.generated_image_variation_generic;
        if (variants?.length > 0) {
          const nobgVar = variants.find((v: any) => v.transformType === 'NOBG');
          if (nobgVar?.url) { nobgGenId = nobgVar.id; return nobgVar.url as string; }
        }
        return null;
      });

      if (nobgUrl) {
        const dlRes = await axios.get(nobgUrl, { responseType: 'arraybuffer' });
        await this.s3HelperService.uploadImage(
          `series/${seriesId}/characters/${cimg.characterId}/${cimg.emotion}_NOBG.png`, dlRes.data, 'image/png',
        );
        this.logger.log(`[${targetName}] NOBG S3 저장 완료`);
      }
    } catch (err: any) {
      this.logger.error(`[${targetName}] NOBG 실패: ${err.message}`);
    }
    return nobgGenId;
  }

  private async poll<T>(taskName: string, fn: () => Promise<T | null | undefined>): Promise<T> {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const result = await fn();
      if (result) return result;
    }
    throw new Error(`${taskName} timeout after 180s`);
  }

  private async generateImageToBuffer(
    prompt: string,
    initImageId?: string,
    styleUUID?: string,
    width = 576,
    height = 1024,
  ): Promise<{ buffer: Buffer; imageId: string }> {
    const payload: any = {
      model: 'flux-pro-2.0',
      public: false,
      parameters: { width, height, quantity: 1, prompt },
    };

    if (initImageId) {
      payload.parameters.guidances = {
        image_reference: [{ image: { id: initImageId, type: 'GENERATED' }, strength: 'HIGH' }],
      };
    }

    const response = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v2/generations',
      payload,
      { headers: this.getHeaders() },
    );
    const generationId = response.data?.generate?.generationId;
    if (!generationId) throw new Error('Leonardo API에서 generationId 획득 실패');

    const completedData = await this.poll(`Generation [${generationId}]`, async () => {
      const statusRes = await axios.get(
        `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
        { headers: this.getHeaders() },
      );
      const gen = statusRes.data?.generations_by_pk;
      if (gen?.status === 'COMPLETE') return gen;
      if (gen?.status === 'FAILED') throw new Error('Leonardo Generation failed');
      return null;
    });

    const imageUrl = completedData.generated_images[0].url;
    const imageId  = completedData.generated_images[0].id;
    const imgRes   = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    return { buffer: Buffer.from(imgRes.data, 'binary'), imageId };
  }
}
