import { Injectable, Logger } from '@nestjs/common';
import { RepositoryProvider } from '../common/repository.provider';
import { ParsingService } from '../parsing/parsing.service';
import { ImageService } from '../image/image.service';
import { EpisodeStatus } from '../entities/episode.entity';
import { StepKey, StepStatus, STEP_ORDER } from '../entities/episode-pipeline-step.entity';

@Injectable()
export class EpisodePipelineService {
  private readonly logger = new Logger(EpisodePipelineService.name);

  constructor(
    private readonly repo: RepositoryProvider,
    private readonly parsingService: ParsingService,
    private readonly imageService: ImageService,
  ) {}

  async run(seriesId: string, episodeNumber: number): Promise<void> {
    const episode = await this.repo.episode.findOneBy({ seriesId, episodeNumber });
    if (!episode) {
      this.logger.error(`Episode not found: ${seriesId}/${episodeNumber}`);
      return;
    }

    const steps: Array<{ key: StepKey; fn: () => Promise<void> }> = [
      { key: StepKey.PARSE_CHARACTERS,           fn: () => this.parsingService.parseCharactersForEpisode(seriesId, episodeNumber) },
      { key: StepKey.PARSE_BACKGROUNDS,          fn: () => this.parsingService.parseBackgroundsForEpisode(seriesId, episodeNumber) },
      { key: StepKey.PARSE_SCENES,               fn: () => this.parsingService.parseScenesForEpisode(seriesId, episodeNumber) },
      { key: StepKey.GENERATE_CHARACTER_IMAGES,  fn: () => this.imageService.generateCharacterImages(seriesId) },
      { key: StepKey.GENERATE_BACKGROUND_IMAGES, fn: () => this.imageService.generateBackgroundImages(seriesId) },
    ];

    for (const step of steps) {
      await this.updateStep(episode.id, step.key, StepStatus.PROCESSING, { startedAt: new Date() });
      try {
        await step.fn();
        await this.updateStep(episode.id, step.key, StepStatus.DONE, { finishedAt: new Date() });
      } catch (err: any) {
        this.logger.error(`[Episode ${episode.id}] Step ${step.key} 실패: ${err.message}`);
        await this.updateStep(episode.id, step.key, StepStatus.FAILED, {
          finishedAt:   new Date(),
          errorMessage: err.message,
        });
        await this.repo.episode.update(episode.id, {
          status:       EpisodeStatus.FAILED,
          errorMessage: `[${step.key}] ${err.message}`,
        });
        return;
      }
    }

    await this.repo.episode.update(episode.id, { status: EpisodeStatus.DONE });
    await this.repo.series.update(seriesId, { latestEpisodeAt: new Date() });
    this.logger.log(`[Episode ${episode.id}] 파이프라인 완료`);
  }

  private async updateStep(
    episodeId: string,
    stepKey: StepKey,
    status: StepStatus,
    extra: { startedAt?: Date; finishedAt?: Date; errorMessage?: string } = {},
  ): Promise<void> {
    await this.repo.pipelineStep.update({ episodeId, stepKey }, { status, ...extra });
  }
}
