import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3HelperService } from '../common/s3-helper.service';
import { GenAIHelperService } from '../common/gen-ai-helper.service';
import { Emotion, STYLE_UUIDS } from '../common/constants';
import { RepositoryProvider } from '../common/repository.provider';
import { CharacterImg } from '../entities/character-img.entity';
import { getCharacterPrompt, getCharacterEmotionPrompt } from './prompt/prompt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PipelineEvent, PipelineStepPayload } from 'src/pipeline/pipeline.events';
import { GenStatus } from 'src/entities/common/common.enum';

@Injectable()
export class ImageService {
  private readonly logger = new Logger(ImageService.name);
  private readonly imageProvider: 'leonardo' | 'gemini';

  constructor(
    private readonly s3HelperService: S3HelperService,
    private readonly genAI: GenAIHelperService,
    private readonly repo: RepositoryProvider,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.imageProvider =
      this.configService.get<string>('IMAGE_PROVIDER') === 'gemini' ? 'gemini' : 'leonardo';
  }

  async eventGenCharacterImages(episodeId: string): Promise<void> {
    const episode = await this.repo.episode.findOne({ where: { id: episodeId } });
    if (!episode) throw new HttpException('Episode not found', HttpStatus.NOT_FOUND);
    this.eventEmitter.emit(PipelineEvent.CHAR_IMG_START, { episodeId } satisfies PipelineStepPayload);
  }

  async generateCharacterImages(episodeId: string): Promise<void> {
    const series = await this.repo.series.findByEpisodeId(episodeId);
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const pendingImages = await this.repo.characterImg
      .createQueryBuilder('ci')
      .innerJoinAndSelect('ci._characterFk', 'c')
      .where('c.seriesId = :seriesId', { seriesId: series.id })
      .andWhere('ci.status IN (:...statuses)', { statuses: [GenStatus.PENDING, GenStatus.FAILED] })
      .getMany();

    if (pendingImages.length === 0) {
      this.logger.log(`[${series.id}] 생성 대기 중인 캐릭터 이미지 없음`);
      return;
    }

    const charGroups = Map.groupBy(pendingImages, (pi) => pi.characterId);
    const globalArtStyle = series.characterArtStyle || '';
    const actualStyleKey = series.characterStyleKey || 'DYNAMIC';
    const selectedStyleUUID = STYLE_UUIDS[actualStyleKey.toUpperCase()] || STYLE_UUIDS['DYNAMIC'];

    this.logger.log(
      `[${series.id}] 캐릭터 이미지 생성 시작: ${charGroups.size}명, 총 ${pendingImages.length}개 감정`,
    );

    const characterPromises = Array.from(charGroups.values()).map((pis) =>
      this.processCharacter(series.id, pis, globalArtStyle, selectedStyleUUID).catch((err) =>
        {
          this.logger.error(`[${pis[0].characterId}] 처리 실패: ${err.message}`)
          throw err
        }
      ),
    );

    await Promise.all(characterPromises);
    this.logger.log(`[${series.id}] 모든 캐릭터 이미지 생성 완료`);
  }

  async eventGenBackgroundImages(episodeId: string): Promise<void> {
    const episode = await this.repo.episode.findOne({ where: { id: episodeId } });
    if (!episode) throw new HttpException('Episode not found', HttpStatus.NOT_FOUND);
    this.eventEmitter.emit(PipelineEvent.BG_IMG_START, { episodeId } satisfies PipelineStepPayload);
  }

  async generateBackgroundImages(episodeId: string): Promise<void> {
    const series = await this.repo.series.findByEpisodeId(episodeId);
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);
    const seriesId = series.id;

    const backgrounds = await this.repo.background
      .createQueryBuilder('b')
      .where('b.seriesId = :seriesId', { seriesId: series.id })
      .andWhere('b.status IN (:...statuses)', { statuses: [GenStatus.PENDING, GenStatus.FAILED] })
      .getMany();

    if (!backgrounds.length) {
      this.logger.log(`[${seriesId}] 생성할 배경 이미지 없음`);
      return;
    }

    const globalBgArtStyle = series.backgroundArtStyle ?? '';
    const actualStyleKey = series.backgroundStyleKey ?? 'DYNAMIC';
    const selectedStyleUUID = STYLE_UUIDS[actualStyleKey.toUpperCase()] ?? STYLE_UUIDS['DYNAMIC'];

    this.logger.log(`[${seriesId}] 신규 배경 이미지 생성: ${backgrounds.length}개`);

    await Promise.all(
      backgrounds.map(async (bg) => {
        bg.status = GenStatus.PROCESSING;
        await this.repo.background.save(bg);

        try {
          const prompt = `(${globalBgArtStyle}:1.2), ${actualStyleKey} art style rendering, ${bg.description}, masterpiece, empty scenery, highly detailed landscape, no characters`;
          let buffer: Buffer;

          if (this.imageProvider === 'gemini') {
            ({ buffer } = await this.genAI.geminiGenerateImage(prompt, undefined, '16:9', '2K'));
          } else {
            const result = await this.genAI.leonardoGenerateImage(
              prompt, undefined, selectedStyleUUID, 1280, 720,
            );
            buffer = result.buffer;
            bg.genId = result.imageId;
          }

          await this.s3HelperService.uploadImage(
            `series/${seriesId}/backgrounds/${bg.id}.png`, buffer, 'image/png',
          );
          bg.status = GenStatus.DONE;
          await this.repo.background.save(bg);
          this.logger.log(`[${bg.id}] 배경 이미지 완료`);
        } catch (err: any) {
          bg.status = GenStatus.FAILED;
          await this.repo.background.save(bg);
          this.logger.error(`[${bg.id}] 배경 이미지 실패: ${err.message}`);
        }
      }),
    );

    this.logger.log(`[${seriesId}] 배경 이미지 생성 완료`);
  }

  private async processCharacter(
    seriesId: string,
    pendingCharImgs: CharacterImg[],
    globalArtStyle: string,
    styleUUID: string,
  ): Promise<void> {
    const defaultImg = pendingCharImgs.find((pci) => pci.emotion === Emotion.DEFAULT);
    if (!defaultImg) throw new HttpException('DEFAULT image entry not found', HttpStatus.BAD_REQUEST);

    const charId = defaultImg.characterId;
    const charInfo = defaultImg._characterFk;
    let defaultBuffer: Buffer | undefined;

    if ([GenStatus.PENDING, GenStatus.FAILED].includes(defaultImg.status)) {
      this.logger.log(`[${charId}] DEFAULT 이미지 생성 중...`);
      const defaultPrompt = getCharacterPrompt(globalArtStyle, charInfo.look, Emotion.DEFAULT, this.imageProvider);

      defaultImg.status = GenStatus.PROCESSING;
      await this.repo.characterImg.save(defaultImg);

      try {
        if (this.imageProvider === 'gemini') {
          ({ buffer: defaultBuffer } = await this.genAI.geminiGenerateImage(defaultPrompt, undefined, '9:16', '1K'));
          await this.s3HelperService.uploadImage(
          `series/${seriesId}/characters/${charId}/DEFAULT_NOBG.png`, defaultBuffer, 'image/png',
          );
        } else {
          const { buffer, imageId } = await this.genAI.leonardoGenerateImage(defaultPrompt, undefined, styleUUID);
          defaultBuffer = buffer;
          defaultImg.genId = imageId;
          defaultImg.nobgGenId = await this.extractAndSaveNobg(seriesId, defaultImg);
        }

        await this.s3HelperService.uploadImage(
          `series/${seriesId}/characters/${charId}/DEFAULT.png`, defaultBuffer, 'image/png',
        );

        defaultImg.status = GenStatus.DONE;
        await this.repo.characterImg.save(defaultImg);
        this.logger.log(`[${charId}] DEFAULT 생성 완료`);
      } catch (err: any) {
        defaultImg.status = GenStatus.FAILED;
        await this.repo.characterImg.save(defaultImg);
        throw err;
      }
    }

    const remaining = pendingCharImgs.filter((pci) => pci.emotion !== Emotion.DEFAULT);
    if (remaining.length === 0) return;

    // Gemini image-to-image: DEFAULT buffer가 메모리에 없으면 S3에서 다운로드
    if (this.imageProvider === 'gemini' && !defaultBuffer) {
      defaultBuffer = await this.s3HelperService.downloadImage(
        `series/${seriesId}/characters/${charId}/DEFAULT.png`,
      );
    }

    const emotionPromises = remaining.map((pci) =>
      this.generateEmotion(seriesId, pci, globalArtStyle, styleUUID, defaultImg.genId, defaultBuffer).catch((err) =>
        this.logger.error(`[${charId}] ${pci.emotion} 감정 생성 실패: ${err.message}`),
      ),
    );

    await Promise.all(emotionPromises);
  }

  private async generateEmotion(
    seriesId: string,
    cimg: CharacterImg,
    globalArtStyle: string,
    styleUUID: string,
    defaultGenId?: string,   // Leonardo: DEFAULT 이미지 참조 ID
    defaultBuffer?: Buffer,  // Gemini: DEFAULT 이미지 bytes
  ): Promise<void> {
    const charId = cimg.characterId;
    const prompt = getCharacterEmotionPrompt(globalArtStyle, cimg._characterFk.look, cimg.emotion, this.imageProvider);

    cimg.status = GenStatus.PROCESSING;
    await this.repo.characterImg.save(cimg);

    try {
      let buffer: Buffer;

      if (this.imageProvider === 'gemini') {
        ({ buffer } = await this.genAI.geminiGenerateImage(prompt, defaultBuffer, '9:16', '1K'));
        await this.s3HelperService.uploadImage(
        `series/${seriesId}/characters/${charId}/${cimg.emotion}_NOBG.png`, buffer, 'image/png',
        );
      } else {
        const result = await this.genAI.leonardoGenerateImage(prompt, defaultGenId, styleUUID);
        buffer = result.buffer;
        cimg.genId = result.imageId;
        cimg.nobgGenId = await this.extractAndSaveNobg(seriesId, cimg);
      }

      await this.s3HelperService.uploadImage(
        `series/${seriesId}/characters/${charId}/${cimg.emotion}.png`, buffer, 'image/png',
      );
      cimg.status = GenStatus.DONE;
      await this.repo.characterImg.save(cimg);
    } catch (err: any) {
      cimg.status = GenStatus.FAILED;
      await this.repo.characterImg.save(cimg);
      throw err;
    }
  }

  private async extractAndSaveNobg(seriesId: string, cimg: CharacterImg): Promise<string> {
    const targetName = `${cimg.characterId}_${cimg.emotion}`;
    try {
      const nobg = await this.genAI.leonardoNobg(cimg.genId);
      if (!nobg) {
        this.logger.warn(`[${targetName}] NOBG 결과 없음`);
        return undefined;
      }

      const dlRes = await (await import('axios')).default.get(nobg.url, { responseType: 'arraybuffer' });
      await this.s3HelperService.uploadImage(
        `series/${seriesId}/characters/${cimg.characterId}/${cimg.emotion}_NOBG.png`,
        dlRes.data,
        'image/png',
      );
      this.logger.log(`[${targetName}] NOBG S3 저장 완료`);
      return nobg.nobgGenId;
    } catch (err: any) {
      this.logger.error(`[${targetName}] NOBG 실패: ${err.message}`);
      return undefined;
    }
  }
}
