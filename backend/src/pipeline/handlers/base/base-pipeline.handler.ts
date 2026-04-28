import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Not } from 'typeorm';
import { RepositoryProvider } from '../../../common/repository.provider';
import { EpisodeStatus } from '../../../entities/episode.entity';
import { StepKey, StepStatus } from '../../../entities/episode-pipeline-step.entity';
import { PipelineEvent, PipelineStepPayload } from '../../pipeline.events';

export abstract class BasePipelineHandler {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly eventEmitter: EventEmitter2,
    protected readonly repo: RepositoryProvider,
  ) { }

  protected abstract readonly doneEvent: PipelineEvent;
  protected abstract readonly stepKey: StepKey;

  protected abstract execute(episodeId: string): Promise<void>;

  protected async run(payload: PipelineStepPayload): Promise<void> {
    const { episodeId } = payload;

    const episode = await this.repo.episode.findOne({ where: { id: episodeId } });
    if (!episode) throw new HttpException('Episode not found', HttpStatus.NOT_FOUND);

    await this.repo.episode.update(episodeId, { status: EpisodeStatus.PROCESSING, errorMessage: null });
    await this.repo.pipelineStep.updateStep(episodeId, this.stepKey, StepStatus.PROCESSING, { startedAt: new Date() });

    try {
      await this.execute(episodeId);

      await this.repo.pipelineStep.updateStep(episodeId, this.stepKey, StepStatus.DONE, { finishedAt: new Date() });
      this.eventEmitter.emit(this.doneEvent, payload);

      await this.checkEpisodeDone(episodeId, episode.seriesId);
    } catch (err: any) {
      this.logger.error(`[${episodeId}] ${this.stepKey} 실패: ${err.message}`);
      await this.repo.pipelineStep.updateStep(episodeId, this.stepKey, StepStatus.FAILED, { finishedAt: new Date(), errorMessage: err.message });
      await this.repo.episode.update(episodeId, { status: EpisodeStatus.FAILED, errorMessage: `[${this.stepKey}] ${err.message}` });
    }
  }

  private async checkEpisodeDone(episodeId: string, seriesId: string): Promise<void> {
    const episode = await this.repo.episode.findOneBy({ id: episodeId });
    if (episode?.status === EpisodeStatus.FAILED) return;

    const hasUnfinished = await this.repo.pipelineStep.findOneBy({ episodeId, status: Not(StepStatus.DONE) });
    const allDone = !hasUnfinished;

    if (allDone) {
      await this.repo.episode.update(episodeId, { status: EpisodeStatus.DONE });
      await this.repo.series.update(seriesId, { latestEpisodeAt: new Date() });
      this.logger.log(`[${episodeId}] 파이프라인 완료`);
    }
  }
}
