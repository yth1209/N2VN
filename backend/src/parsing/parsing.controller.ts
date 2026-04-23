import { Controller, Post, Body } from '@nestjs/common';
import { ParsingService } from './parsing.service';
import { ParseEpisodeDto } from './dto/parse-episode.dto';

@Controller('parsing')
export class ParsingController {
  constructor(private readonly parsingService: ParsingService) {}

  @Post('characters')
  async parseCharacters(@Body() dto: ParseEpisodeDto) {
    await this.parsingService.parseCharactersForEpisode(dto.seriesId, dto.episodeNumber);
    return { success: true, message: '캐릭터 파싱 완료' };
  }

  @Post('backgrounds')
  async parseBackgrounds(@Body() dto: ParseEpisodeDto) {
    await this.parsingService.parseBackgroundsForEpisode(dto.seriesId, dto.episodeNumber);
    return { success: true, message: '배경 파싱 완료' };
  }

  @Post('scenes')
  async parseScenes(@Body() dto: ParseEpisodeDto) {
    await this.parsingService.parseScenesForEpisode(dto.seriesId, dto.episodeNumber);
    return { success: true, message: '씬 파싱 완료' };
  }
}
