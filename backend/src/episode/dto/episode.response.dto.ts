import { Episode } from '../../entities/episode.entity';
import { EpisodePipelineStep } from '../../entities/episode-pipeline-step.entity';

export class PipelineStepDto {
  stepKey:      string;
  status:       string;
  errorMessage: string | null;
  startedAt:    Date | null;
  finishedAt:   Date | null;

  constructor(step: EpisodePipelineStep) {
    this.stepKey      = step.stepKey;
    this.status       = step.status;
    this.errorMessage = step.errorMessage ?? null;
    this.startedAt    = step.startedAt ?? null;
    this.finishedAt   = step.finishedAt ?? null;
  }
}

export class EpisodeResponseDto {
  id:            string;
  seriesId:      string;
  episodeNumber: number;
  title:         string;
  status:        string;
  errorMessage:  string | null;
  createdAt:     Date;
  pipelineSteps: PipelineStepDto[];

  constructor(episode: Episode, pipelineSteps: EpisodePipelineStep[] = []) {
    this.id            = episode.id;
    this.seriesId      = episode.seriesId;
    this.episodeNumber = episode.episodeNumber;
    this.title         = episode.title;
    this.status        = episode.status;
    this.errorMessage  = episode.errorMessage ?? null;
    this.createdAt     = episode.createdAt;
    this.pipelineSteps = pipelineSteps.map((s) => new PipelineStepDto(s));
  }
}
