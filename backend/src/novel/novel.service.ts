import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In } from 'typeorm';
import { RepositoryProvider } from '../common/repository.provider';
import { S3HelperService } from '../common/s3-helper.service';
import { Emotion } from '../common/constants';

type VnCharacterMap = Record<string, { name: string; sprites: Record<string, string> }>;

@Injectable()
export class NovelService {
  constructor(
    private readonly repo: RepositoryProvider,
    private readonly configService: ConfigService,
    private readonly s3Helper: S3HelperService,
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

  async getVnScript(id: number) {
    const novel = await this.repo.novel.findOne({ where: { id } });
    if (!novel) throw new HttpException('Novel not found', HttpStatus.NOT_FOUND);

    const bucket = this.configService.get<string>('AWS_S3_BUCKET_NAME');
    const region = this.configService.get<string>('AWS_REGION');
    const baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;

    // 1. S3에서 scenes.json 읽기
    const scenesData = await this.s3Helper.readJson(`${id}/scenes.json`);

    // 2. DB에서 캐릭터, 배경, 캐릭터 이미지 조회 (N+1 방지)
    const characters = await this.repo.character.find({ where: { novelId: id } });
    const backgrounds = await this.repo.background.find({ where: { novelId: id } });

    const charIds = characters.map(c => c.id);
    const allImages = charIds.length
      ? await this.repo.characterImg.find({ where: { characterId: In(charIds) } })
      : [];

    const imagesByChar = new Map<string, typeof allImages>();
    for (const img of allImages) {
      if (!imagesByChar.has(img.characterId)) imagesByChar.set(img.characterId, []);
      imagesByChar.get(img.characterId)!.push(img);
    }

    // 3. 캐릭터별 스프라이트 맵 (emotion -> NOBG URL, 없으면 원본, 둘 다 없으면 DEFAULT로 폴백)
    const characterMap: VnCharacterMap = {};
    for (const char of characters) {
      const images = imagesByChar.get(char.id) ?? [];
      const sprites: Record<string, string> = {};
      for (const img of images) {
        if (img.nobgGenId) {
          sprites[img.emotion] = `${baseUrl}/${id}/characters/${char.id}_${img.emotion}_NOBG.png`;
        } else if (img.genId) {
          sprites[img.emotion] = `${baseUrl}/${id}/characters/${char.id}_${img.emotion}.png`;
        }
      }
      // genId조차 없는 감정은 DEFAULT 이미지로 대체
      const defaultUrl = sprites[Emotion.DEFAULT];
      if (defaultUrl) {
        for (const img of images) {
          if (!sprites[img.emotion]) {
            sprites[img.emotion] = defaultUrl;
          }
        }
      }
      characterMap[char.id] = { name: char.name, sprites };
    }

    // 4. 배경 맵 (bgId -> URL)
    const sceneMap: Record<string, string> = {};
    for (const bg of backgrounds) {
      if (bg.genId) {
        sceneMap[bg.id] = `${baseUrl}/${id}/backgrounds/${bg.id}.png`;
      }
    }

    // 5. scenes.json -> VN script 변환
    const script = this.buildVnScript(scenesData.scenes, characterMap);

    return { characters: characterMap, scenes: sceneMap, script };
  }

  private buildVnScript(
    scenes: any[],
    characterMap: VnCharacterMap,
  ): (string | Record<string, string>)[] {
    const script: (string | Record<string, string>)[] = [];

    for (const scene of scenes) {
      script.push(`show scene ${scene.backgroundId} with fade`);

      // 현재 씬에서 화면에 있는 캐릭터 추적 (charId -> { emotion, position })
      const onScreen = new Map<string, { emotion: string; position: string }>();

      for (const dialogue of scene.dialogues) {
        const { characterId, dialog, emotion, isEntry, isExit, position } = dialogue;

        // isEntry/isExit/position 방어 처리 (구버전 scenes.json 대응)
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
          // 첫 등장: show character 삽입
          script.push(`show character ${characterId} ${emo} ${pos}`);
          onScreen.set(characterId, { emotion: emo, position: pos });
        } else if (onScreen.has(characterId)) {
          // 이미 화면에 있는 캐릭터 — 감정/위치 실제 변화 시에만 재렌더링
          const prev = onScreen.get(characterId)!;
          if (prev.emotion !== emo || prev.position !== pos) {
            script.push(`show character ${characterId} ${emo} ${pos}`);
            onScreen.set(characterId, { emotion: emo, position: pos });
          }
        }

        // 대사
        script.push({ [charName]: dialog });

        // 퇴장
        if (exit) {
          script.push(`hide character ${characterId}`);
          onScreen.delete(characterId);
        }
      }

      // 씬 종료 시 화면 잔류 캐릭터 정리 (isExit 누락 방어)
      for (const charId of onScreen.keys()) {
        script.push(`hide character ${charId}`);
      }
      onScreen.clear();
    }

    script.push('end');
    return script;
  }
}
