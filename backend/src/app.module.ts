import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NovelParsingController } from './parsing/novel-parsing.controller';
import { NovelParsingService } from './parsing/novel-parsing.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [NovelParsingController],
  providers: [NovelParsingService],
})
export class AppModule { }