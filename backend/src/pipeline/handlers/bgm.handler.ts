import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RepositoryProvider } from '../../common/repository.provider';
import { SoundService } from '../../sound/sound.service';
import { StepKey } from '../../entities/episode-pipeline-step.entity';
import { PipelineEvent, PipelineStepPayload } from '../pipeline.events';
import { BasePipelineHandler } from './base/base-pipeline.handler';

@Injectable()
export class BgmHandler extends BasePipelineHandler {
  protected readonly doneEvent = PipelineEvent.BGM_DONE;
  protected readonly stepKey = StepKey.GENERATE_BGM;

  constructor(
    private readonly bgmService: SoundService,
    eventEmitter: EventEmitter2,
    repo: RepositoryProvider,
  ) {
    super(eventEmitter, repo);
  }

  @OnEvent(PipelineEvent.BGM_START)
  @OnEvent(PipelineEvent.SCENES_DONE)
  handle(payload: PipelineStepPayload) { return this.run(payload); }

  protected execute(episodeId: string) {
    return this.bgmService.generateBgm(episodeId);
  }
}
