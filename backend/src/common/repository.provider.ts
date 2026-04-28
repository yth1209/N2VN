import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { Episode } from '../entities/episode.entity';
import { EpisodePipelineStepRepository } from '../entities/repo/episode-pipeline-step.repository';
import { Character } from '../entities/character.entity';
import { CharacterImg } from '../entities/character-img.entity';
import { Background } from '../entities/background.entity';
import { Bgm } from '../entities/bgm.entity';
import { SeriesRepository } from '../entities/repo/series.repository';

@Injectable()
export class RepositoryProvider {
  constructor(
    @InjectRepository(User) public readonly user: Repository<User>,
    public readonly series: SeriesRepository,
    @InjectRepository(Episode) public readonly episode: Repository<Episode>,
    public readonly pipelineStep: EpisodePipelineStepRepository,
    @InjectRepository(Character) public readonly character: Repository<Character>,
    @InjectRepository(CharacterImg) public readonly characterImg: Repository<CharacterImg>,
    @InjectRepository(Background) public readonly background: Repository<Background>,
    @InjectRepository(Bgm) public readonly bgm: Repository<Bgm>,
  ) { }
}
