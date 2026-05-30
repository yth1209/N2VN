import { Series } from '../../entities/series.entity';
import { Episode } from '../../entities/episode.entity';
import { EpisodePipelineStep } from '../../entities/episode-pipeline-step.entity';

export class EpisodeItemDto {
  id: string;
  episodeNumber: number;
  title: string;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  pipelineSteps: { stepKey: string; status: string; errorMessage: string | null }[];

  constructor(ep: Episode, pipelineSteps: EpisodePipelineStep[] = []) {
    this.id            = ep.id;
    this.episodeNumber = ep.episodeNumber;
    this.title         = ep.title;
    this.status        = ep.status;
    this.errorMessage  = ep.errorMessage ?? null;
    this.createdAt     = ep.createdAt;
    this.pipelineSteps = pipelineSteps.map((s) => ({
      stepKey:      s.stepKey,
      status:       s.status,
      errorMessage: s.errorMessage ?? null,
    }));
  }
}

export class SeriesDetailResponseDto {
  id: string;
  title: string;
  description: string | null;
  authorNickname: string;
  latestEpisodeAt: Date | null;
  createdAt: Date;
  episodes: EpisodeItemDto[];

  constructor(series: Series, episodes: Episode[], stepsMap: Map<string, EpisodePipelineStep[]> = new Map()) {
    this.id              = series.id;
    this.title           = series.title;
    this.description     = series.description ?? null;
    this.authorNickname  = series.author?.nickname ?? '';
    this.latestEpisodeAt = series.latestEpisodeAt ?? null;
    this.createdAt       = series.createdAt;
    this.episodes        = episodes.map((e) => new EpisodeItemDto(e, stepsMap.get(e.id) ?? []));
  }
}
