import {
  Controller, Post, Get, Delete, Param, Body,
  UseGuards, Request, UseInterceptors, UploadedFile,
  ParseIntPipe, HttpCode, HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EpisodeService } from './episode.service';
import { CreateEpisodeDto } from './dto/create-episode.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('series/:seriesId/episodes')
export class EpisodeController {
  constructor(private readonly episodeService: EpisodeService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async createEpisode(
    @Param('seriesId') seriesId: string,
    @Body() dto: CreateEpisodeDto,
    @UploadedFile() file: any,
    @Request() req: any,
  ) {
    if (!file) {
      return { success: false, message: '파일이 필요합니다.' };
    }
    const data = await this.episodeService.createEpisode(seriesId, dto, file, req.user.id);
    return { success: true, data };
  }

  @Get(':num')
  async getEpisode(
    @Param('seriesId') seriesId: string,
    @Param('num', ParseIntPipe) num: number,
  ) {
    const data = await this.episodeService.getEpisode(seriesId, num);
    return { success: true, data };
  }

  @Get(':episodeId/vn-script')
  async getVnScript(
    @Param('seriesId') seriesId: string,
    @Param('episodeId') episodeId: string,
  ) {
    const data = await this.episodeService.getVnScript(seriesId, episodeId);
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':num')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEpisode(
    @Param('seriesId') seriesId: string,
    @Param('num', ParseIntPipe) num: number,
    @Request() req: any,
  ) {
    await this.episodeService.deleteEpisode(seriesId, num, req.user.id);
  }
}
