import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RepositoryProvider } from '../../common/repository.provider';
import { ParsingService } from '../../parsing/parsing.service';
import { StepKey } from '../../entities/episode-pipeline-step.entity';
import { PipelineEvent, PipelineStepPayload } from '../pipeline.events';
import { BasePipelineHandler } from './base/base-pipeline.handler';

@Injectable()
export class CharacterParsingHandler extends BasePipelineHandler {
  protected readonly doneEvent = PipelineEvent.CHARACTERS_DONE;
  protected readonly stepKey = StepKey.PARSE_CHARACTERS;

  constructor(
    private readonly parsingService: ParsingService,
    eventEmitter: EventEmitter2,
    repo: RepositoryProvider,
  ) {
    super(eventEmitter, repo);
  }

  @OnEvent(PipelineEvent.CHARACTERS_START)
  @OnEvent(PipelineEvent.START)
  handle(payload: PipelineStepPayload) { return this.run(payload); }

  protected execute(episodeId: string) {
    return this.parsingService.parseCharacters(episodeId);
  }
}
