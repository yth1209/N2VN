import { Controller, Post, Body } from '@nestjs/common';
import { NovelParsingService } from './novel-parsing.service';
@Controller('parsing')
export class NovelParsingController {
  constructor(private readonly novelParsingService: NovelParsingService) { }

  @Post('characters')
  async parseCharacters(
    @Body('novelId') novelId: number
  ) {
    if (!novelId) {
      return { success: false, error: 'novelId parameter is required' };
    }

    const data = await this.novelParsingService.extractCharactersMetadata(novelId);

    return {
      success: true,
      data,
    };
  }

  @Post('backgrounds')
  async parseBackgrounds(
    @Body('novelId') novelId: number
  ) {
    if (!novelId) {
      return { success: false, error: 'novelId parameter is required' };
    }

    const data = await this.novelParsingService.extractBackgroundsMetadata(novelId);

    return {
      success: true,
      data,
    };
  }

  @Post('scenes')
  async parseScenes(
    @Body('novelId') novelId: number
  ) {
    if (!novelId) {
      return { success: false, error: 'novelId parameter is required' };
    }

    const data = await this.novelParsingService.extractScenesMetadata(novelId);

    return {
      success: true,
      data,
    };
  }
}
