import { Series } from '../../entities/series.entity';
import { Episode } from '../../entities/episode.entity';

export class EpisodeItemDto {
  id: string;
  episodeNumber: number;
  title: string;
  status: string;
  createdAt: Date;

  constructor(ep: Episode) {
    this.id            = ep.id;
    this.episodeNumber = ep.episodeNumber;
    this.title         = ep.title;
    this.status        = ep.status;
    this.createdAt     = ep.createdAt;
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

  constructor(series: Series, episodes: Episode[]) {
    this.id              = series.id;
    this.title           = series.title;
    this.description     = series.description ?? null;
    this.authorNickname  = series.author?.nickname ?? '';
    this.latestEpisodeAt = series.latestEpisodeAt ?? null;
    this.createdAt       = series.createdAt;
    this.episodes        = episodes.map((e) => new EpisodeItemDto(e));
  }
}
