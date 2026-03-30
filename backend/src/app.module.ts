import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NovelParsingController } from './parsing/novel-parsing.controller';
import { NovelParsingService } from './parsing/novel-parsing.service';
import { S3HelperService } from './common/s3-helper.service';
import { ImageGenerationController } from './image/image-generation.controller';
import { ImageGenerationService } from './image/image-generation.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [NovelParsingController, ImageGenerationController],
  providers: [NovelParsingService, S3HelperService, ImageGenerationService],
})
export class AppModule { }