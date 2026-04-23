import { Controller, Get, Post, Body, Param, UseGuards, Request } from '@nestjs/common';
import { SeriesService } from './series.service';
import { CreateSeriesDto } from './dto/create-series.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('series')
export class SeriesController {
  constructor(private readonly seriesService: SeriesService) {}

  @Get()
  async getSeriesList() {
    const data = await this.seriesService.getSeriesList();
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  async getMySeries(@Request() req: any) {
    const data = await this.seriesService.getMySeries(req.user.id);
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async createSeries(@Body() dto: CreateSeriesDto, @Request() req: any) {
    const data = await this.seriesService.createSeries(dto, req.user.id);
    return { success: true, data };
  }

  @Get(':id')
  async getSeriesDetail(@Param('id') id: string) {
    const data = await this.seriesService.getSeriesDetail(id);
    return { success: true, data };
  }

  @Get(':id/assets')
  async getSeriesAssets(@Param('id') id: string) {
    const data = await this.seriesService.getSeriesAssets(id);
    return { success: true, data };
  }
}
