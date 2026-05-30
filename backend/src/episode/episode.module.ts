import { Module } from '@nestjs/common';
import { EpisodeService } from './episode.service';
import { EpisodeController } from './episode.controller';
import { EpisodePipelineService } from './episode-pipeline.service';
import { AuthModule } from '../auth/auth.module';
import { PipelineModule } from '../pipeline/pipeline.module';

@Module({
  imports: [AuthModule, PipelineModule],
  controllers: [EpisodeController],
  providers: [EpisodeService, EpisodePipelineService],
})
export class EpisodeModule {}
