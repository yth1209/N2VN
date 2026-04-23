import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from './entities/user.entity';
import { Series } from './entities/series.entity';
import { Episode } from './entities/episode.entity';
import { EpisodePipelineStep } from './entities/episode-pipeline-step.entity';
import { Character } from './entities/character.entity';
import { CharacterImg } from './entities/character-img.entity';
import { Background } from './entities/background.entity';

import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { SeriesModule } from './series/series.module';
import { EpisodeModule } from './episode/episode.module';
import { ParsingModule } from './parsing/parsing.module';
import { ImageModule } from './image/image.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'mariadb',
        host:     configService.get<string>('DB_HOST', '127.0.0.1'),
        port:     parseInt(configService.get<string>('DB_PORT', '3306')),
        username: configService.get<string>('DB_USERNAME', 'root'),
        password: configService.get<string>('DB_PASSWORD', ''),
        database: configService.get<string>('DB_DATABASE', 'n2vn'),
        entities: [User, Series, Episode, EpisodePipelineStep, Character, CharacterImg, Background],
        // 개발: synchronize: true. 운영 배포 전 false로 전환 후 마이그레이션 실행 필요.
        synchronize: true,
        ssl: { rejectUnauthorized: false },
        // logging: true,
      }),
      inject: [ConfigService],
    }),
    CommonModule,
    AuthModule,
    SeriesModule,
    EpisodeModule,
    ParsingModule,
    ImageModule,
  ],
})
export class AppModule {}
