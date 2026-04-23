import { Module } from '@nestjs/common';
import { ParsingService } from './parsing.service';
import { ParsingController } from './parsing.controller';

@Module({
  controllers: [ParsingController],
  providers: [ParsingService],
  exports: [ParsingService],
})
export class ParsingModule {}
