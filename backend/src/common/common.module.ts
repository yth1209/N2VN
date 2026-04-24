import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { RepositoryProvider } from './repository.provider';
import { S3HelperService } from './s3-helper.service';
import { GenAIHelperService } from './gen-ai-helper.service';
import { User } from '../entities/user.entity';
import { Series } from '../entities/series.entity';
import { Episode } from '../entities/episode.entity';
import { EpisodePipelineStep } from '../entities/episode-pipeline-step.entity';
import { EpisodePipelineStepRepository } from '../entities/episode-pipeline-step.repository';
import { Character } from '../entities/character.entity';
import { CharacterImg } from '../entities/character-img.entity';
import { Background } from '../entities/background.entity';
import { Bgm } from '../entities/bgm.entity';

const episodePipelineStepRepositoryProvider = {
  provide:    EpisodePipelineStepRepository,
  inject:     [DataSource],
  useFactory: (ds: DataSource) => new EpisodePipelineStepRepository(ds),
};

@Global()
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      User,
      Series,
      Episode,
      EpisodePipelineStep,
      Character,
      CharacterImg,
      Background,
      Bgm,
    ]),
  ],
  providers: [episodePipelineStepRepositoryProvider, RepositoryProvider, S3HelperService, GenAIHelperService],
  exports:   [episodePipelineStepRepositoryProvider, RepositoryProvider, S3HelperService, GenAIHelperService],
})
export class CommonModule {}
