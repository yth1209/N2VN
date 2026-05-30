import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RepositoryProvider } from '../../common/repository.provider';
import { ImageService } from '../../image/image.service';
import { StepKey } from '../../entities/episode-pipeline-step.entity';
import { PipelineEvent, PipelineStepPayload } from '../pipeline.events';
import { BasePipelineHandler } from './base/base-pipeline.handler';

@Injectable()
export class CharacterImageHandler extends BasePipelineHandler {
  protected readonly doneEvent = PipelineEvent.CHAR_IMG_DONE;
  protected readonly stepKey = StepKey.GENERATE_CHARACTER_IMAGES;

  constructor(
    private readonly imageService: ImageService,
    eventEmitter: EventEmitter2,
    repo: RepositoryProvider,
  ) {
    super(eventEmitter, repo);
  }

  @OnEvent(PipelineEvent.CHAR_IMG_START)
  @OnEvent(PipelineEvent.SCENES_DONE)
  handle(payload: PipelineStepPayload) { return this.run(payload); }

  protected execute(episodeId: string) {
    return this.imageService.generateCharacterImages(episodeId);
  }
}
