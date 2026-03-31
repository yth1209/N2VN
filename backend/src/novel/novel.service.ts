import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RepositoryProvider } from '../common/repository.provider';

@Injectable()
export class NovelService {
  constructor(
    private readonly repo: RepositoryProvider,
    private readonly configService: ConfigService,
  ) {}

  async getAllNovels() {
    return this.repo.novel.find();
  }

  async createNovel(novelTitle: string) {
    if (!novelTitle) throw new HttpException('novelTitle parameter is required', HttpStatus.BAD_REQUEST);
    
    // Check if it already exists
    const existing = await this.repo.novel.findOne({ where: { novelTitle } });
    if (existing) {
      return existing; // Return existing novel context
    }

    const novel = this.repo.novel.create({ novelTitle });
    const saved = await this.repo.novel.save(novel);
    return saved;
  }

  async getNovelAssets(id: number) {
    const novel = await this.repo.novel.findOne({ where: { id } });
    if (!novel) throw new HttpException('Novel not found', HttpStatus.NOT_FOUND);

    const bucket = this.configService.get<string>('AWS_S3_BUCKET_NAME');
    const region = this.configService.get<string>('AWS_REGION');
    const baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;

    const characters = await this.repo.character.find({ where: { novelId: id } });
    const backgrounds = await this.repo.background.find({ where: { novelId: id } });

    const characterData = await Promise.all(characters.map(async (char) => {
      const images = await this.repo.characterImg.find({ where: { characterId: char.id } });
      return {
        ...char,
        images: images.map(img => ({
          emotion: img.emotion,
          url: img.genId ? `${baseUrl}/${id}/characters/${char.id}_${img.emotion}.png` : null,
          nobgUrl: img.nobgGenId ? `${baseUrl}/${id}/characters/${char.id}_${img.emotion}_NOBG.png` : null,
        }))
      };
    }));

    const backgroundData = backgrounds.map(bg => ({
      ...bg,
      url: bg.genId ? `${baseUrl}/${id}/backgrounds/${bg.id}.png` : null,
    }));

    return {
      novel,
      characters: characterData,
      backgrounds: backgroundData,
    };
  }
}
