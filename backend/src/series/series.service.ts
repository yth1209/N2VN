import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In } from 'typeorm';
import { RepositoryProvider } from '../common/repository.provider';
import { CreateSeriesDto } from './dto/create-series.dto';
import { SeriesListItemDto } from './dto/series-list.response.dto';
import { SeriesDetailResponseDto } from './dto/series-detail.response.dto';
import { SeriesAssetsResponseDto } from './dto/series-assets.response.dto';

@Injectable()
export class SeriesService {
  constructor(
    private readonly repo: RepositoryProvider,
    private readonly configService: ConfigService,
  ) {}

  private getBaseUrl(): string {
    const bucket = this.configService.get<string>('AWS_S3_BUCKET_NAME');
    const region = this.configService.get<string>('AWS_REGION');
    return `https://${bucket}.s3.${region}.amazonaws.com`;
  }

  async getSeriesList(): Promise<SeriesListItemDto[]> {
    const list = await this.repo.series.find({
      order: { latestEpisodeAt: 'DESC' },
      relations: ['author'],
    });

    const baseUrl = this.getBaseUrl();

    const result = await Promise.all(list.map(async (s) => {
      const episodeCount = await this.repo.episode.count({ where: { seriesId: s.id } });

      // 썸네일: 첫 번째 캐릭터의 DEFAULT_NOBG 이미지
      const firstChar = await this.repo.character.findOne({ where: { seriesId: s.id } });
      let thumbnailUrl: string | null = null;
      if (firstChar) {
        const defaultImg = await this.repo.characterImg.findOne({
          where: { characterId: firstChar.id, emotion: 'DEFAULT' as any },
        });
        if (defaultImg?.nobgGenId) {
          thumbnailUrl = `${baseUrl}/series/${s.id}/characters/${firstChar.id}/DEFAULT_NOBG.png`;
        } else if (defaultImg?.genId) {
          thumbnailUrl = `${baseUrl}/series/${s.id}/characters/${firstChar.id}/DEFAULT.png`;
        }
      }

      return new SeriesListItemDto(s, episodeCount, thumbnailUrl);
    }));

    return result;
  }

  async getMySeries(userId: string): Promise<SeriesListItemDto[]> {
    const list = await this.repo.series.find({
      where: { authorId: userId },
      order: { createdAt: 'DESC' },
      relations: ['author'],
    });

    const baseUrl = this.getBaseUrl();

    const result = await Promise.all(list.map(async (s) => {
      const episodeCount = await this.repo.episode.count({ where: { seriesId: s.id } });
      const firstChar = await this.repo.character.findOne({ where: { seriesId: s.id } });
      let thumbnailUrl: string | null = null;
      if (firstChar) {
        const defaultImg = await this.repo.characterImg.findOne({
          where: { characterId: firstChar.id, emotion: 'DEFAULT' as any },
        });
        if (defaultImg?.nobgGenId) {
          thumbnailUrl = `${baseUrl}/series/${s.id}/characters/${firstChar.id}/DEFAULT_NOBG.png`;
        } else if (defaultImg?.genId) {
          thumbnailUrl = `${baseUrl}/series/${s.id}/characters/${firstChar.id}/DEFAULT.png`;
        }
      }
      return new SeriesListItemDto(s, episodeCount, thumbnailUrl);
    }));

    return result;
  }

  async createSeries(dto: CreateSeriesDto, userId: string) {
    const series = this.repo.series.create({
      title:       dto.title,
      description: dto.description ?? null,
      authorId:    userId,
    });
    const saved = await this.repo.series.save(series);
    return { id: saved.id, title: saved.title, description: saved.description, createdAt: saved.createdAt };
  }

  async getSeriesDetail(seriesId: string): Promise<SeriesDetailResponseDto> {
    const series = await this.repo.series.findOne({
      where: { id: seriesId },
      relations: ['author'],
    });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const episodes = await this.repo.episode.find({
      where: { seriesId },
      order: { episodeNumber: 'ASC' },
    });

    const episodeIds = episodes.map((e) => e.id);
    const allSteps = episodeIds.length
      ? await this.repo.pipelineStep.find({ where: { episodeId: In(episodeIds) } })
      : [];

    const stepsMap = new Map<string, typeof allSteps>();
    for (const step of allSteps) {
      if (!stepsMap.has(step.episodeId)) stepsMap.set(step.episodeId, []);
      stepsMap.get(step.episodeId)!.push(step);
    }

    return new SeriesDetailResponseDto(series, episodes, stepsMap);
  }

  async getSeriesAssets(seriesId: string): Promise<SeriesAssetsResponseDto> {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const baseUrl = this.getBaseUrl();

    const characters = await this.repo.character.find({ where: { seriesId } });
    const backgrounds = await this.repo.background.find({ where: { seriesId } });

    const charIds = characters.map((c) => c.id);
    const allImages = charIds.length
      ? await this.repo.characterImg.find({ where: { characterId: In(charIds) } })
      : [];

    const imagesByChar = new Map<string, typeof allImages>();
    for (const img of allImages) {
      if (!imagesByChar.has(img.characterId)) imagesByChar.set(img.characterId, []);
      imagesByChar.get(img.characterId)!.push(img);
    }

    const characterAssets = characters.map((char) => {
      const images = (imagesByChar.get(char.id) ?? []).map((img) => ({
        emotion: img.emotion,
        url:     img.genId    ? `${baseUrl}/series/${seriesId}/characters/${char.id}/${img.emotion}.png`      : null,
        nobgUrl: img.nobgGenId ? `${baseUrl}/series/${seriesId}/characters/${char.id}/${img.emotion}_NOBG.png` : null,
      }));
      return { id: char.id, name: char.name, sex: char.sex, look: char.look, images };
    });

    const backgroundAssets = backgrounds.map((bg) => ({
      id:          bg.id,
      name:        bg.name,
      description: bg.description,
      url:         bg.genId ? `${baseUrl}/series/${seriesId}/backgrounds/${bg.id}.png` : null,
    }));

    return { characters: characterAssets, backgrounds: backgroundAssets };
  }
}
