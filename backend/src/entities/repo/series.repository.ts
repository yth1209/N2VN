import { DataSource, Repository } from 'typeorm';
import { Injectable } from '@nestjs/common';
import { Series } from '../series.entity';

@Injectable()
export class SeriesRepository extends Repository<Series> {
  constructor(dataSource: DataSource) {
    super(Series, dataSource.createEntityManager());
  }

  async findByEpisodeId(episodeId: string): Promise<Series> {
    return await this.createQueryBuilder("series")
      .innerJoin("episode", "episode", "episode.seriesId = series.id")
      .where("episode.id = :episodeId", { episodeId })
      .getOne();
  }
}
