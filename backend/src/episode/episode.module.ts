import { Module } from '@nestjs/common';
import { EpisodeService } from './episode.service';
import { EpisodeController } from './episode.controller';
import { EpisodePipelineService } from './episode-pipeline.service';
import { AuthModule } from '../auth/auth.module';
import { ParsingModule } from '../parsing/parsing.module';
import { ImageModule } from '../image/image.module';

@Module({
  imports: [AuthModule, ParsingModule, ImageModule],
  controllers: [EpisodeController],
  providers: [EpisodeService, EpisodePipelineService],
})
export class EpisodeModule {}
