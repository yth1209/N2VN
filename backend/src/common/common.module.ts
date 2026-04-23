import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { RepositoryProvider } from './repository.provider';
import { S3HelperService } from './s3-helper.service';
import { User } from '../entities/user.entity';
import { Series } from '../entities/series.entity';
import { Episode } from '../entities/episode.entity';
import { EpisodePipelineStep } from '../entities/episode-pipeline-step.entity';
import { Character } from '../entities/character.entity';
import { CharacterImg } from '../entities/character-img.entity';
import { Background } from '../entities/background.entity';

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
    ]),
  ],
  providers: [RepositoryProvider, S3HelperService],
  exports: [RepositoryProvider, S3HelperService],
})
export class CommonModule {}
