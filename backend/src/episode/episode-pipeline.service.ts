import { Injectable, Logger } from '@nestjs/common';
import { RepositoryProvider } from '../common/repository.provider';
import { ParsingService } from '../parsing/parsing.service';
import { ImageService } from '../image/image.service';
import { BgmService } from '../bgm/bgm.service';
import { EpisodeStatus } from '../entities/episode.entity';
import { StepKey } from '../entities/episode-pipeline-step.entity';

@Injectable()
export class EpisodePipelineService {
  private readonly logger = new Logger(EpisodePipelineService.name);

  constructor(
    private readonly repo: RepositoryProvider,
    private readonly parsingService: ParsingService,
    private readonly imageService: ImageService,
    private readonly bgmService: BgmService,
  ) {}

  async run(seriesId: string, episodeNumber: number): Promise<void> {
    const episode = await this.repo.episode.findOneBy({ seriesId, episodeNumber });
    if (!episode) {
      this.logger.error(`Episode not found: ${seriesId}/${episodeNumber}`);
      return;
    }

    const fns: Array<{ key: StepKey; fn: () => Promise<void> }> = [
      { key: StepKey.PARSE_CHARACTERS,           fn: () => this.parsingService.parseCharactersForEpisode(seriesId, episodeNumber) },
      { key: StepKey.PARSE_SCENES,               fn: () => this.parsingService.parseScenesForEpisode(seriesId, episodeNumber) },
      { key: StepKey.GENERATE_CHARACTER_IMAGES,  fn: () => this.imageService.generateCharacterImages(seriesId, episodeNumber) },
      { key: StepKey.GENERATE_BACKGROUND_IMAGES, fn: () => this.imageService.generateBackgroundImagesForSeries(seriesId, episodeNumber) },
      { key: StepKey.GENERATE_BGM,               fn: () => this.bgmService.generateBgmForSeries(seriesId, episodeNumber) },
    ];

    for (const { key, fn } of fns) {
      try {
        await fn();
      } catch (err: any) {
        this.logger.error(`[Episode ${episode.id}] Step ${key} 실패: ${err.message}`);
        await this.repo.episode.update(episode.id, {
          status:       EpisodeStatus.FAILED,
          errorMessage: `[${key}] ${err.message}`,
        });
        return;
      }
    }

    await this.repo.episode.update(episode.id, { status: EpisodeStatus.DONE });
    await this.repo.series.update(seriesId, { latestEpisodeAt: new Date() });
    this.logger.log(`[Episode ${episode.id}] 파이프라인 완료`);
  }
}
