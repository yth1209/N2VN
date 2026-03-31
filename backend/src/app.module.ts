import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NovelParsingController } from './parsing/novel-parsing.controller';
import { NovelParsingService } from './parsing/novel-parsing.service';
import { S3HelperService } from './common/s3-helper.service';
import { ImageGenerationController } from './image/image-generation.controller';
import { ImageGenerationService } from './image/image-generation.service';
import { NovelController } from './novel/novel.controller';
import { NovelService } from './novel/novel.service';

import { Novel } from './entities/novel.entity';
import { Character } from './entities/character.entity';
import { CharacterImg } from './entities/character-img.entity';
import { Background } from './entities/background.entity';
import { RepositoryProvider } from './common/repository.provider';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'mariadb',
        host: configService.get<string>('DB_HOST', '127.0.0.1'),
        port: parseInt(configService.get<string>('DB_PORT', '3306')),
        username: configService.get<string>('DB_USERNAME', 'root'),
        password: configService.get<string>('DB_PASSWORD', ''),
        database: configService.get<string>('DB_DATABASE', 'n2vn'),
        entities: [Novel, Character, CharacterImg, Background],
        synchronize: true, // Auto-create tables for faster development
        ssl: {
          // RDS가 자체 서명된 인증서를 사용하므로, 
          // 로컬 개발 환경에서는 엄격한 인증서 검증을 건너뛰도록 설정합니다.
          rejectUnauthorized: false,
        },
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([Novel, Character, CharacterImg, Background]),
  ],
  controllers: [NovelParsingController, ImageGenerationController, NovelController],
  providers: [NovelParsingService, S3HelperService, ImageGenerationService, NovelService, RepositoryProvider],
})
export class AppModule { }