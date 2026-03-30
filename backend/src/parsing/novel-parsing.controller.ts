import { Controller, Post, Body } from '@nestjs/common';
import { NovelParsingService } from './novel-parsing.service';
@Controller('parsing')
export class NovelParsingController {
  constructor(private readonly novelParsingService: NovelParsingService) { }

  @Post('characters')
  async parseCharacters(
    @Body('novelTitle') novelTitle: string
  ) {
    if (!novelTitle) {
      return { success: false, error: 'novelTitle parameter is required' };
    }

    // 서비스 로직 호출 및 반환
    const data = await this.novelParsingService.extractCharactersMetadata(novelTitle);

    return {
      success: true,
      data, // { "CharacterA": { look: [], job: [], character: [] }, "CharacterB": ... }
    };
  }

  @Post('backgrounds')
  async parseBackgrounds(
    @Body('novelTitle') novelTitle: string
  ) {
    if (!novelTitle) {
      return { success: false, error: 'novelTitle parameter is required' };
    }

    const data = await this.novelParsingService.extractBackgroundsMetadata(novelTitle);

    return {
      success: true,
      data,
    };
  }

  @Post('scenes')
  async parseScenes(
    @Body('novelTitle') novelTitle: string
  ) {
    if (!novelTitle) {
      return { success: false, error: 'novelTitle parameter is required' };
    }

    const data = await this.novelParsingService.extractScenesMetadata(novelTitle);

    return {
      success: true,
      data,
    };
  }
}
