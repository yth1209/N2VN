import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { NovelService } from './novel.service';

@Controller('novels')
export class NovelController {
  constructor(private readonly novelService: NovelService) {}

  @Get()
  async getNovels() {
    const data = await this.novelService.getAllNovels();
    return {
      success: true,
      data,
    };
  }

  @Post()
  async createNovel(@Body('novelTitle') novelTitle: string) {
    const data = await this.novelService.createNovel(novelTitle);
    return {
      success: true,
      data,
    };
  }

  @Get(':id/assets')
  async getNovelAssets(@Param('id') id: string) {
    const data = await this.novelService.getNovelAssets(Number(id));
    return {
      success: true,
      data,
    };
  }

  @Get(':id/vn-script')
  async getVnScript(@Param('id') id: string) {
    const data = await this.novelService.getVnScript(Number(id));
    return {
      success: true,
      data,
    };
  }
}
