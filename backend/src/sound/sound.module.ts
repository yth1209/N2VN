import { Module } from '@nestjs/common';
import { SoundService } from './sound.service';
import { SoundController } from './sound.controller';

@Module({
  providers: [SoundService],
  controllers: [SoundController],
  exports: [SoundService],
})
export class SoundModule { }
