import { Controller, Post, Body } from '@nestjs/common';
import { ParsingService } from './parsing.service';
import { ParseEpisodeDto } from './dto/parse-episode.dto';

@Controller('parsing')
export class ParsingController {
  constructor(private readonly parsingService: ParsingService) {}

  @Post('characters')
  async parseCharacters(@Body('episodeId') episodeId: string) {
    this.parsingService.eventParseCharacters(episodeId);
    return { success: true, message: '캐릭터 파싱 시작' };
  }

  @Post('scenes')
  async parseScenes(@Body('episodeId') episodeId: string) {
    this.parsingService.eventParseScenes(episodeId);
    return { success: true, message: '씬 파싱 시작' };
  }
}
