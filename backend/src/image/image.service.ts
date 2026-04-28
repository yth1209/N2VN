import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { S3HelperService } from '../common/s3-helper.service';
import { GenAIHelperService } from '../common/gen-ai-helper.service';
import { Emotion, STYLE_UUIDS } from '../common/constants';
import { RepositoryProvider } from '../common/repository.provider';
import { CharacterImg } from '../entities/character-img.entity';
import { getCharacterPrompt } from './prompt/prompt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PipelineEvent, PipelineStepPayload } from 'src/pipeline/pipeline.events';

@Injectable()
export class ImageService {
  private readonly logger = new Logger(ImageService.name);

  constructor(
    private readonly s3HelperService: S3HelperService,
    private readonly genAI: GenAIHelperService,
    private readonly repo: RepositoryProvider,
    private readonly eventEmitter: EventEmitter2,
  ) { }


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
      .andWhere('ci.genId IS NULL')
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
        this.logger.error(`[${pis[0].characterId}] 처리 실패: ${err.message}`),
      ),
    );

    await Promise.all(characterPromises);
    this.logger.log(`[${series.id}] 모든 캐릭터 이미지 생성 완료`);
  }

  /**
   * seriesId의 미생성 배경(genId = null)만 처리. EpisodePipelineService 및 retry에서 호출.
   */
  async eventGenBackgroundImages(episodeId: string): Promise<void> {
    const episode = await this.repo.episode.findOne({ where: { id: episodeId } });
    if (!episode) throw new HttpException('Episode not found', HttpStatus.NOT_FOUND);
    this.eventEmitter.emit(PipelineEvent.BG_IMG_START, {episodeId} satisfies PipelineStepPayload);
  }

  async generateBackgroundImages(episodeId: string): Promise<void> {
    const series = await this.repo.series.findByEpisodeId(episodeId);
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);
    const seriesId = series.id;

    const backgrounds = await this.repo.background.find({ where: { seriesId, genId: IsNull() } });
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
        try {
          const prompt = `(${globalBgArtStyle}:1.2), ${actualStyleKey} art style rendering, ${bg.description}, masterpiece, empty scenery, highly detailed landscape, no characters`;
          const { buffer, imageId } = await this.genAI.leonardoGenerateImage(
            prompt, undefined, selectedStyleUUID, 1280, 720,
          );
          await this.s3HelperService.uploadImage(
            `series/${seriesId}/backgrounds/${bg.id}.png`, buffer, 'image/png',
          );
          bg.genId = imageId;
          await this.repo.background.save(bg);
          this.logger.log(`[${bg.id}] 배경 이미지 완료`);
        } catch (err: any) {
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
    let defaultImg = pendingCharImgs.find((pci) => pci.emotion === Emotion.DEFAULT);
    if (!defaultImg) throw new HttpException('DEFAULT image entry not found', HttpStatus.BAD_REQUEST);

    const charId = defaultImg.characterId;
    const charInfo = defaultImg._characterFk;

    if (!defaultImg.genId) {
      this.logger.log(`[${charId}] DEFAULT 이미지 생성 중...`);
      const defaultPrompt = getCharacterPrompt(globalArtStyle, charInfo.look, Emotion.DEFAULT);
      const { buffer, imageId } = await this.genAI.leonardoGenerateImage(defaultPrompt, undefined, styleUUID);
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
    const { buffer, imageId } = await this.genAI.leonardoGenerateImage(prompt, initImageId, styleUUID);
    cimg.genId = imageId;

    await this.s3HelperService.uploadImage(
      `series/${seriesId}/characters/${charId}/${cimg.emotion}.png`, buffer, 'image/png',
    );
    cimg.nobgGenId = await this.extractAndSaveNobg(seriesId, cimg);
    await this.repo.characterImg.save(cimg);
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
