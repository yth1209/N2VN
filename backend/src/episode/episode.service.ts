import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In } from 'typeorm';
import { RepositoryProvider } from '../common/repository.provider';
import { S3HelperService } from '../common/s3-helper.service';
import { EpisodePipelineService } from './episode-pipeline.service';
import { CreateEpisodeDto } from './dto/create-episode.dto';
import { EpisodeResponseDto } from './dto/episode.response.dto';
import { EpisodeStatus } from '../entities/episode.entity';
import { StepKey, STEP_ORDER, StepStatus } from '../entities/episode-pipeline-step.entity';
import { Emotion } from '../common/constants';

type VnCharacterMap = Record<string, { name: string; sprites: Record<string, string> }>;

@Injectable()
export class EpisodeService {
  constructor(
    private readonly repo: RepositoryProvider,
    private readonly s3Helper: S3HelperService,
    private readonly configService: ConfigService,
    private readonly pipelineService: EpisodePipelineService,
  ) {}

  private getBaseUrl(): string {
    const bucket = this.configService.get<string>('AWS_S3_BUCKET_NAME');
    const region = this.configService.get<string>('AWS_REGION');
    return `https://${bucket}.s3.${region}.amazonaws.com`;
  }

  async createEpisode(
    seriesId: string,
    dto: CreateEpisodeDto,
    file: any,
    userId: string,
  ): Promise<EpisodeResponseDto> {
    // 1. series 소유권 확인
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);
    if (series.authorId !== userId) throw new HttpException('권한이 없습니다.', HttpStatus.FORBIDDEN);

    // 2. PROCESSING 중인 에피소드 존재 여부 확인
    const processing = await this.repo.episode.findOne({
      where: { seriesId, status: EpisodeStatus.PROCESSING },
    });
    if (processing) {
      throw new HttpException(
        '현재 처리 중인 회차가 있습니다. 완료 후 다시 시도해주세요.',
        HttpStatus.CONFLICT,
      );
    }

    // 3. 다음 episodeNumber 계산
    const maxResult = await this.repo.episode
      .createQueryBuilder('e')
      .select('MAX(e.episodeNumber)', 'max')
      .where('e.seriesId = :seriesId', { seriesId })
      .getRawOne();
    const episodeNumber = (maxResult?.max ?? 0) + 1;

    // 4. episode INSERT (status: PROCESSING)
    const episode = await this.repo.episode.save(
      this.repo.episode.create({
        seriesId,
        episodeNumber,
        title:  dto.title,
        status: EpisodeStatus.PROCESSING,
      }),
    );

    // 5. episode_pipeline_step 5개 row 일괄 INSERT
    const stepRows = STEP_ORDER.map((stepKey) =>
      this.repo.pipelineStep.create({ episodeId: episode.id, stepKey, status: StepStatus.PENDING }),
    );
    await this.repo.pipelineStep.save(stepRows);

    // 6. S3 업로드: novel.txt
    await this.s3Helper.uploadText(
      `series/${seriesId}/episodes/${episodeNumber}/novel.txt`,
      file.buffer.toString('utf-8'),
    );

    // 7. 파이프라인 fire-and-forget
    this.pipelineService.run(episode.id).catch(() => {});

    const pipelineSteps = await this.repo.pipelineStep.find({ where: { episodeId: episode.id } });
    return new EpisodeResponseDto(episode, pipelineSteps);
  }

  async getEpisode(seriesId: string, episodeNumber: number): Promise<EpisodeResponseDto> {
    const episode = await this.repo.episode.findOne({
      where: { seriesId, episodeNumber },
    });
    if (!episode) throw new HttpException('Episode not found', HttpStatus.NOT_FOUND);

    const pipelineSteps = await this.repo.pipelineStep.find({
      where: { episodeId: episode.id },
      order: { stepKey: 'ASC' },
    });

    return new EpisodeResponseDto(episode, pipelineSteps);
  }

  async deleteEpisode(seriesId: string, episodeNumber: number, userId: string): Promise<void> {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);
    if (series.authorId !== userId) throw new HttpException('권한이 없습니다.', HttpStatus.FORBIDDEN);

    const episode = await this.repo.episode.findOne({ where: { seriesId, episodeNumber } });
    if (!episode) throw new HttpException('Episode not found', HttpStatus.NOT_FOUND);

    await this.repo.episode.remove(episode);
  }

  async getVnScript(seriesId: string, episodeId: string) {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const episode = await this.repo.episode.findOne({ where: { id: episodeId } });
    if (!episode) throw new HttpException('Episode not found', HttpStatus.NOT_FOUND);
    if (episode.status !== EpisodeStatus.DONE) {
      throw new HttpException('에피소드 처리가 완료되지 않았습니다.', HttpStatus.BAD_REQUEST);
    }

    const baseUrl = this.getBaseUrl();

    // S3에서 scenes.json 읽기
    const scenesData = await this.s3Helper.readJson(
      `series/${seriesId}/episodes/${episodeId}/scenes.json`,
    );

    // 캐릭터, 배경 조회 (N+1 방지)
    const characters  = await this.repo.character.find({ where: { seriesId } });
    const backgrounds = await this.repo.background.find({ where: { seriesId } });

    const charIds   = characters.map((c) => c.id);
    const allImages = charIds.length
      ? await this.repo.characterImg.find({ where: { characterId: In(charIds) } })
      : [];

    const imagesByChar = new Map<string, typeof allImages>();
    for (const img of allImages) {
      if (!imagesByChar.has(img.characterId)) imagesByChar.set(img.characterId, []);
      imagesByChar.get(img.characterId)!.push(img);
    }

    // 캐릭터별 스프라이트 맵
    const characterMap: VnCharacterMap = {};
    for (const char of characters) {
      const images  = imagesByChar.get(char.id) ?? [];
      const sprites: Record<string, string> = {};
      for (const img of images) {
        if (img.nobgGenId) {
          sprites[img.emotion] = `${baseUrl}/series/${seriesId}/characters/${char.id}/${img.emotion}_NOBG.png`;
        } else if (img.genId) {
          sprites[img.emotion] = `${baseUrl}/series/${seriesId}/characters/${char.id}/${img.emotion}.png`;
        }
      }
      const defaultUrl = sprites[Emotion.DEFAULT];
      if (defaultUrl) {
        for (const img of images) {
          if (!sprites[img.emotion]) sprites[img.emotion] = defaultUrl;
        }
      }
      characterMap[char.id] = { name: char.name, sprites };
    }

    // 배경 맵
    const sceneMap: Record<string, string> = {};
    for (const bg of backgrounds) {
      if (bg.genId) sceneMap[bg.id] = `${baseUrl}/series/${seriesId}/backgrounds/${bg.id}.png`;
    }

    // BGM 맵
    const bgmList = await this.repo.bgm.find({ where: { seriesId } });
    const bgmMap: Record<string, string | null> = {};
    for (const bgm of bgmList) {
      bgmMap[bgm.id] = bgm.genId
        ? `${baseUrl}/series/${seriesId}/bgm/${bgm.id}.mp3`
        : null;
    }

    const script = this.buildVnScript(scenesData.scenes, characterMap);
    return { characters: characterMap, scenes: sceneMap, bgm: bgmMap, script };
  }

  private buildVnScript(
    scenes: any[],
    characterMap: VnCharacterMap,
  ): (string | Record<string, string>)[] {
    const script: (string | Record<string, string>)[] = [];
    let currentBgmId: string | null = null;

    for (const scene of scenes) {
      // bgmId가 변경된 경우에만 play bgm 명령 삽입
      if (scene.bgmId && scene.bgmId !== currentBgmId) {
        script.push(`play bgm ${scene.bgmId}`);
        currentBgmId = scene.bgmId;
      }
      script.push(`show scene ${scene.backgroundId} with fade`);
      const onScreen = new Map<string, { emotion: string; position: string }>();

      for (const dialogue of scene.dialogues) {
        const { characterId, dialog, emotion, isEntry, isExit, position } = dialogue;
        const entry = isEntry  ?? false;
        const exit  = isExit   ?? false;
        const pos   = position ?? 'center';
        const emo   = emotion  ?? Emotion.DEFAULT;

        if (characterId === 'narrator' || characterId === 'unknown') {
          script.push(dialog);
          continue;
        }

        const charName = characterMap[characterId]?.name ?? characterId;

        if (entry && !onScreen.has(characterId)) {
          script.push(`show character ${characterId} ${emo} ${pos}`);
          onScreen.set(characterId, { emotion: emo, position: pos });
        } else if (onScreen.has(characterId)) {
          const prev = onScreen.get(characterId)!;
          if (prev.emotion !== emo || prev.position !== pos) {
            script.push(`show character ${characterId} ${emo} ${pos}`);
            onScreen.set(characterId, { emotion: emo, position: pos });
          }
        }

        script.push({ [charName]: dialog });

        if (exit) {
          script.push(`hide character ${characterId}`);
          onScreen.delete(characterId);
        }
      }

      for (const charId of onScreen.keys()) script.push(`hide character ${charId}`);
      onScreen.clear();
    }

    script.push('stop bgm');
    script.push('end');
    return script;
  }
}
