import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RepositoryProvider } from '../common/repository.provider';
import { EpisodeStatus } from '../entities/episode.entity';
import { PipelineEvent, PipelineStepPayload } from '../pipeline/pipeline.events';

@Injectable()
export class EpisodePipelineService {
  private readonly logger = new Logger(EpisodePipelineService.name);

  constructor(
    private readonly repo: RepositoryProvider,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async run(episodeId: string): Promise<void> {
    await this.repo.episode.update(episodeId, { status: EpisodeStatus.PROCESSING });

    this.eventEmitter.emit(PipelineEvent.START, {
      episodeId
    } satisfies PipelineStepPayload);
  }
}
