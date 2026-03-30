import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { ImageGenerationService } from './image-generation.service';

@Controller('images')
export class ImageGenerationController {
  constructor(private readonly imageGenerationService: ImageGenerationService) {}

  @Post('characters')
  async generateCharacterImages(@Body('novelTitle') novelTitle: string) {
    if (!novelTitle) {
      throw new HttpException('novelTitle is required', HttpStatus.BAD_REQUEST);
    }

    // 서버 단에서는 비동기로 동작하도록 Promise를 반환 (단, 응답은 즉시 반환)
    // 에러 핸들링은 내부 서비스에서 로깅됨.
    this.imageGenerationService.generateCharacterImages(novelTitle).catch(err => {
      // 로거 등 처리는 서비스 단에서 이미 함
    });

    return {
      success: true,
      message: 'Image generation started in background. Check server logs for progress.',
    };
  }

  @Post('backgrounds')
  async generateBackgroundImages(@Body('novelTitle') novelTitle: string) {
    if (!novelTitle) {
      throw new HttpException('novelTitle is required', HttpStatus.BAD_REQUEST);
    }

    this.imageGenerationService.generateBackgroundImages(novelTitle).catch(err => {
      // 로거 등 처리는 서비스 단에서 이미 함
    });

    return {
      success: true,
      message: 'Background image generation started in background. Check server logs for progress.',
    };
  }
}
