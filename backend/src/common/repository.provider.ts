import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { Series } from '../entities/series.entity';
import { Episode } from '../entities/episode.entity';
import { EpisodePipelineStep } from '../entities/episode-pipeline-step.entity';
import { Character } from '../entities/character.entity';
import { CharacterImg } from '../entities/character-img.entity';
import { Background } from '../entities/background.entity';

@Injectable()
export class RepositoryProvider {
  constructor(
    @InjectRepository(User)                public readonly user:         Repository<User>,
    @InjectRepository(Series)              public readonly series:       Repository<Series>,
    @InjectRepository(Episode)             public readonly episode:      Repository<Episode>,
    @InjectRepository(EpisodePipelineStep) public readonly pipelineStep: Repository<EpisodePipelineStep>,
    @InjectRepository(Character)           public readonly character:    Repository<Character>,
    @InjectRepository(CharacterImg)        public readonly characterImg: Repository<CharacterImg>,
    @InjectRepository(Background)          public readonly background:   Repository<Background>,
  ) {}
}
