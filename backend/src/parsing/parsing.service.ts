import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { character_prompt, scene_prompt } from './prompt/prompt';
import { S3HelperService } from '../common/s3-helper.service';
import { GenAIHelperService } from '../common/gen-ai-helper.service';
import { Emotion, StyleKey, BgmCategory } from '../common/constants';
import { RepositoryProvider } from '../common/repository.provider';
import { StepKey, StepStatus } from '../entities/episode-pipeline-step.entity';

@Injectable()
export class ParsingService {
  private readonly logger = new Logger(ParsingService.name);

  constructor(
    private readonly s3HelperService: S3HelperService,
    private readonly genAI: GenAIHelperService,
    private readonly repo: RepositoryProvider,
  ) {}

  async parseCharactersForEpisode(seriesId: string, episodeNumber: number): Promise<void> {
    const episode = await this.repo.episode.findOneBy({ seriesId, episodeNumber });
    const episodeId = episode?.id;
    if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.PARSE_CHARACTERS, StepStatus.PROCESSING, { startedAt: new Date() });

    try {
      await this._parseCharacters(seriesId, episodeNumber);
      if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.PARSE_CHARACTERS, StepStatus.DONE, { finishedAt: new Date() });
    } catch (err: any) {
      if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.PARSE_CHARACTERS, StepStatus.FAILED, { finishedAt: new Date(), errorMessage: err.message });
      throw err;
    }
  }

  private async _parseCharacters(seriesId: string, episodeNumber: number): Promise<void> {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const novelText = await this.s3HelperService.readText(
      `series/${seriesId}/episodes/${episodeNumber}/novel.txt`,
    );

    const existing = await this.repo.character.find({ where: { seriesId } });
    const existingStr = existing.length
      ? existing.map((c) => `- ID: ${c.id}, Name: ${c.name}, Sex: ${c.sex}, Look: ${c.look}`).join('\n')
      : '(없음)';

    const characterSchema = z.object({
      globalArtStyle: z.string().describe(
        '이 소설의 모든 캐릭터 이미지 생성 시 공통으로 적용될 화풍 및 렌더링 스타일 영어 키워드 리스트',
      ),
      styleKey: z.nativeEnum(StyleKey).describe(
        '소설 장르 및 분위기에 가장 어울리는 렌더링 필터 스타일',
      ),
      characters: z.record(
        z.string().describe('등장인물의 원본 이름 (번역 금지, 원문 그대로)'),
        z.object({
          sex:  z.string().describe('성별 (male, female, unknown)'),
          look: z.string().describe('캐릭터 비주얼 Character Bible 프롬프트 (영어 키워드)'),
        }),
      ),
    });

    const result = await this.genAI.geminiParse(
      character_prompt,
      ['novel_text', 'existing_characters'],
      characterSchema,
      { novel_text: novelText, existing_characters: existingStr },
    );

    // 시리즈 스타일 최초 1회만 저장
    if (!series.characterArtStyle) {
      series.characterArtStyle = result.globalArtStyle;
      series.characterStyleKey = result.styleKey;
      await this.repo.series.save(series);
    }

    const newCharacters = Object.entries(result.characters).map(([name, attr]: [string, any]) => {
      return this.repo.character.create({ seriesId, name, sex: attr.sex, look: attr.look });
    });

    if (newCharacters.length > 0) {
      await this.repo.character.save(newCharacters);
      this.logger.log(`[${seriesId}] 신규 캐릭터 ${newCharacters.length}명 저장 완료`);
    }
  }

  async parseScenesForEpisode(seriesId: string, episodeNumber: number): Promise<void> {
    const episode = await this.repo.episode.findOneBy({ seriesId, episodeNumber });
    const episodeId = episode?.id;
    if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.PARSE_SCENES, StepStatus.PROCESSING, { startedAt: new Date() });

    try {
      await this._parseScenes(seriesId, episodeNumber);
      if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.PARSE_SCENES, StepStatus.DONE, { finishedAt: new Date() });
    } catch (err: any) {
      if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.PARSE_SCENES, StepStatus.FAILED, { finishedAt: new Date(), errorMessage: err.message });
      throw err;
    }
  }

  private async _parseScenes(seriesId: string, episodeNumber: number): Promise<void> {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const novelText = await this.s3HelperService.readText(
      `series/${seriesId}/episodes/${episodeNumber}/novel.txt`,
    );

    // 기존 배경 목록
    const dbBackgrounds = await this.repo.background.find({ where: { seriesId } });
    const existingBgStr = dbBackgrounds.length
      ? dbBackgrounds.map((b) => `- ID: ${b.id}, Name: ${b.name}, Description: ${b.description}`).join('\n')
      : '(없음)';

    // 기존 BGM 목록
    const dbBgms = await this.repo.bgm.find({ where: { seriesId } });
    const existingBgmStr = dbBgms.length
      ? dbBgms.map((b) => `- ID: ${b.id}, Category: ${b.category}, Prompt: ${b.prompt}`).join('\n')
      : '(없음)';

    // 캐릭터 목록
    const dbCharacters = await this.repo.character.find({ where: { seriesId } });
    const charactersInfoStr = dbCharacters
      .map((c) => `- ID: ${c.id}, Name: ${c.name}, Sex: ${c.sex}, Description: ${c.look}`)
      .join('\n');

    const sceneSchema = z.object({
      globalBackgroundArtStyle: z.string().describe(
        '이 소설의 모든 배경 이미지 생성에 공통 적용될 화풍·분위기 영어 키워드',
      ),
      backgroundStyleKey: z.nativeEnum(StyleKey).describe(
        '배경 렌더링 필터 스타일',
      ),
      newBackgrounds: z.array(z.object({
        tempId:      z.string().describe('new_bg_{n} 형식의 임시 ID'),
        name:        z.string().describe('배경 명칭'),
        description: z.string().describe('시각적 특징·분위기 영문 줄글 (시간대 제외)'),
      })).describe('기존 배경 목록에 없어 새로 생성해야 하는 배경들'),
      newBgms: z.array(z.object({
        tempId:   z.string().describe('new_bgm_{n} 형식의 임시 ID'),
        category: z.nativeEnum(BgmCategory).describe('BGM 감정 카테고리'),
        prompt:   z.string().describe('Lyria 3 Clip 생성용 영어 텍스트 프롬프트 (30단어 이내)'),
      })).describe('기존 BGM 목록에 없어 새로 생성해야 하는 BGM들'),
      scenes: z.array(z.object({
        backgroundId: z.string().describe(
          '이 씬의 배경 ID. 기존 배경이면 그대로, 신규면 newBackgrounds 선언 후 동일 tempId 사용',
        ),
        bgmId: z.string().describe(
          '이 씬의 BGM ID. 기존 BGM이면 그대로, 신규면 newBgms 선언 후 동일 tempId 사용',
        ),
        timeOfDay: z.string().describe('씬이 일어나는 시간대 (예: Morning, Night, Dusk)'),
        dialogues: z.array(z.object({
          characterId: z.string().describe(
            '화자의 고유 ID (characters_info 참고). 나레이션인 경우 narrator',
          ),
          dialog:   z.string().describe('대사 또는 서술 내용 문장 원문 (번역 금지)'),
          action:   z.enum(['IDLE', 'ATTACK', 'SHAKE']).describe('화자의 행동/동작. 항상 제약 조건에 맞는 단어 사용'),
          emotion:  z.nativeEnum(Emotion).describe(
            `화자의 감정 (반드시 다음 중 한 가지만 선택: ${Object.values(Emotion).join(', ')})`,
          ),
          look:     z.string().describe('화자의 표정이나 드러나는 외모 (알 수 없으면 unknown)'),
          isEntry:  z.boolean().describe('씬 내 캐릭터 첫 번째 등장인 경우 true, narrator는 항상 false'),
          isExit:   z.boolean().describe('씬 내 캐릭터 마지막 대사인 경우 true, narrator는 항상 false'),
          position: z.enum(['left', 'center', 'right']).describe(
            '캐릭터의 화면 위치. 혼자면 center, 2인 이상이면 left/right. narrator는 center',
          ),
        })).describe('이 씬에 포함되는 모든 대사와 나레이션을 순서대로 담은 배열'),
      })),
    });

    const result = await this.genAI.geminiParse(
      scene_prompt,
      ['novel_text', 'characters_info', 'existing_backgrounds', 'existing_bgms'],
      sceneSchema,
      {
        novel_text:           novelText,
        characters_info:      charactersInfoStr,
        existing_backgrounds: existingBgStr,
        existing_bgms:        existingBgmStr,
      },
    );

    // === 1. 신규 배경 DB 적재 + ID 맵 구성 ===
    const bgTempToRealId = new Map<string, string>();
    for (const nb of result.newBackgrounds) {
      const entity = this.repo.background.create({
        seriesId,
        name:        nb.name,
        description: nb.description,
      });
      const saved = await this.repo.background.save(entity);
      bgTempToRealId.set(nb.tempId, saved.id);
    }

    // === 2. 신규 BGM DB 적재 + ID 맵 구성 ===
    const bgmTempToRealId = new Map<string, string>();
    for (const nb of result.newBgms) {
      const entity = this.repo.bgm.create({
        seriesId,
        category: nb.category,
        prompt:   nb.prompt,
      });
      const saved = await this.repo.bgm.save(entity);
      bgmTempToRealId.set(nb.tempId, saved.id);
    }

    // === 3. 시리즈 배경 스타일 최초 1회만 저장 ===
    if (!series.backgroundArtStyle) {
      series.backgroundArtStyle = result.globalBackgroundArtStyle;
      series.backgroundStyleKey = result.backgroundStyleKey;
      await this.repo.series.save(series);
    }

    // === 4. scenes의 임시 ID를 실제 UUID로 치환 ===
    const resolvedScenes = result.scenes.map((scene) => ({
      ...scene,
      backgroundId: bgTempToRealId.get(scene.backgroundId) ?? scene.backgroundId,
      bgmId:        bgmTempToRealId.get(scene.bgmId)        ?? scene.bgmId,
    }));

    // === 5. character_img 플레이스홀더 생성 (genId=null) ===
    const emotionMap = new Map<string, Set<Emotion>>();
    for (const scene of resolvedScenes) {
      for (const dialogue of scene.dialogues) {
        const charId = dialogue.characterId;
        if (charId && charId !== 'narrator' && charId !== 'unknown') {
          if (!emotionMap.has(charId)) emotionMap.set(charId, new Set<Emotion>([Emotion.DEFAULT]));
          emotionMap.get(charId)!.add(dialogue.emotion as Emotion);
        }
      }
    }
    for (const [charId, emotions] of emotionMap.entries()) {
      for (const emotion of emotions) {
        const exists = await this.repo.characterImg.findOne({ where: { characterId: charId, emotion } });
        if (!exists) {
          await this.repo.characterImg.save(
            this.repo.characterImg.create({ characterId: charId, emotion, genId: null, nobgGenId: null }),
          );
        }
      }
    }

    // === 6. scenes.json S3 저장 ===
    await this.s3HelperService.uploadJson(
      `series/${seriesId}/episodes/${episodeNumber}/scenes.json`,
      { scenes: resolvedScenes },
    );

    this.logger.log(`[${seriesId}/ep${episodeNumber}] 씬 파싱 완료 (신규 배경 ${result.newBackgrounds.length}개, 신규 BGM ${result.newBgms.length}개)`);
  }
}
