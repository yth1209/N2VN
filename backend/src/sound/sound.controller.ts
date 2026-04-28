import { Controller, Post, Body } from '@nestjs/common';
import { SoundService } from './sound.service';

@Controller('sound')
export class SoundController {
  constructor(private readonly soundSerivce: SoundService) {}

  @Post('bgm')
  async generateBgm(@Body('episodeId') episodeId: string) {
    this.soundSerivce.eventGenerateBgm(episodeId);
    return { success: true, message: 'BGM 생성 시작' };
  }

}
