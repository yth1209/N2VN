import { Module } from '@nestjs/common';
import { BgmService } from './bgm.service';

@Module({
  providers: [BgmService],
  exports:   [BgmService],
})
export class BgmModule {}
