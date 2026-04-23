import { Series } from '../../entities/series.entity';

export class SeriesListItemDto {
  id: string;
  title: string;
  description: string | null;
  authorNickname: string;
  latestEpisodeAt: Date | null;
  episodeCount: number;
  thumbnailUrl: string | null;

  constructor(series: Series, episodeCount: number, thumbnailUrl: string | null) {
    this.id              = series.id;
    this.title           = series.title;
    this.description     = series.description ?? null;
    this.authorNickname  = series.author?.nickname ?? '';
    this.latestEpisodeAt = series.latestEpisodeAt ?? null;
    this.episodeCount    = episodeCount;
    this.thumbnailUrl    = thumbnailUrl;
  }
}
