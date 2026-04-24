import { Controller, Post, Body } from '@nestjs/common';
import { ImageService } from './image.service';

@Controller('images')
export class ImageController {
  constructor(private readonly imageService: ImageService) {}

  @Post('characters')
  async generateCharacterImages(@Body('seriesId') seriesId: string, @Body('episodeNumber') episodeNumber?: number) {
    this.imageService.generateCharacterImages(seriesId, episodeNumber).catch(() => {});
    return { success: true, message: '캐릭터 이미지 생성이 백그라운드에서 시작되었습니다.' };
  }

  @Post('backgrounds')
  async generateBackgroundImages(@Body('seriesId') seriesId: string, @Body('episodeNumber') episodeNumber?: number) {
    this.imageService.generateBackgroundImagesForSeries(seriesId, episodeNumber).catch(() => {});
    return { success: true, message: '배경 이미지 생성이 백그라운드에서 시작되었습니다.' };
  }
}
