import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { character_prompt, scene_prompt, background_prompt } from './prompt/prompt';
import { S3HelperService } from '../common/s3-helper.service';
import { Emotion, StyleKey } from '../common/constants';
import { RepositoryProvider } from '../common/repository.provider';

@Injectable()
export class ParsingService {
  private readonly logger = new Logger(ParsingService.name);
  private readonly model: ChatGoogleGenerativeAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3HelperService: S3HelperService,
    private readonly repo: RepositoryProvider,
  ) {
    this.model = new ChatGoogleGenerativeAI({
      model: this.configService.get<string>('GEMINI_MODEL') || 'gemini-2.5-flash',
      temperature: 0.1,
      apiKey: this.configService.get<string>('GEMINI_API_KEY'),
    });
  }

  async parseCharactersForEpisode(seriesId: string, episodeNumber: number): Promise<void> {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const novelText = await this.s3HelperService.readText(
      `series/${seriesId}/episodes/${episodeNumber}/novel.txt`,
    );

    // 기존 캐릭터 목록 조회 → 프롬프트에 포함 (병합 전략)
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

    const parser = StructuredOutputParser.fromZodSchema(characterSchema);
    const promptTemplate = new PromptTemplate({
      template: character_prompt,
      inputVariables: ['novel_text', 'existing_characters'],
      partialVariables: { format_instructions: parser.getFormatInstructions() },
    });

    const chain = promptTemplate.pipe(this.model).pipe(parser);
    const result = await chain.invoke({ novel_text: novelText, existing_characters: existingStr });

    // series의 스타일 정보 갱신 (최초 파싱 시에만 — null인 경우)
    if (!series.characterArtStyle) {
      series.characterArtStyle = result.globalArtStyle;
      series.characterStyleKey = result.styleKey;
      await this.repo.series.save(series);
    }

    // 신규 캐릭터만 INSERT (기존 캐릭터는 건드리지 않음)
    const newCharacters = Object.entries(result.characters).map(([name, attr]: [string, any]) => {
      return this.repo.character.create({ seriesId, name, sex: attr.sex, look: attr.look });
    });

    if (newCharacters.length > 0) {
      await this.repo.character.save(newCharacters);
      this.logger.log(`[${seriesId}] 신규 캐릭터 ${newCharacters.length}명 저장 완료`);
    }
  }

  async parseBackgroundsForEpisode(seriesId: string, episodeNumber: number): Promise<void> {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const novelText = await this.s3HelperService.readText(
      `series/${seriesId}/episodes/${episodeNumber}/novel.txt`,
    );

    // 기존 배경 목록 조회 → 프롬프트에 포함 (병합 전략)
    const existing = await this.repo.background.find({ where: { seriesId } });
    const existingStr = existing.length
      ? existing.map((b) => `- ID: ${b.id}, Name: ${b.name}, Description: ${b.description}`).join('\n')
      : '(없음)';

    const backgroundSchema = z.object({
      globalBackgroundArtStyle: z.string().describe(
        '이 소설의 모든 배경 이미지 생성에 공통으로 적용될 환경/건축물 화풍 및 분위기',
      ),
      styleKey: z.nativeEnum(StyleKey).describe(
        '소설 배경 분위기에 가장 어울리는 렌더링 필터 스타일',
      ),
      backgrounds: z.record(
        z.string().describe('배경의 임의 고유 ID'),
        z.object({
          name:        z.string().describe('배경의 실제 이름 또는 짧은 명칭'),
          description: z.string().describe('배경의 시각적 특징, 분위기, 주변 사물 (영어 줄글, 시간대 제외)'),
        }),
      ).describe('소설 내 등장하는 유의미한 주요 배경들의 목록'),
    });

    const parser = StructuredOutputParser.fromZodSchema(backgroundSchema);
    const promptTemplate = new PromptTemplate({
      template: background_prompt,
      inputVariables: ['novel_text', 'existing_backgrounds'],
      partialVariables: { format_instructions: parser.getFormatInstructions() },
    });

    const chain = promptTemplate.pipe(this.model).pipe(parser);
    const result = await chain.invoke({ novel_text: novelText, existing_backgrounds: existingStr });

    if (!series.backgroundArtStyle) {
      series.backgroundArtStyle = result.globalBackgroundArtStyle;
      series.backgroundStyleKey = result.styleKey;
      await this.repo.series.save(series);
    }

    const newBackgrounds = Object.entries(result.backgrounds).map(([, attr]: [string, any]) => {
      return this.repo.background.create({ seriesId, name: attr.name, description: attr.description });
    });

    if (newBackgrounds.length > 0) {
      await this.repo.background.save(newBackgrounds);
      this.logger.log(`[${seriesId}] 신규 배경 ${newBackgrounds.length}개 저장 완료`);
    }
  }

  async parseScenesForEpisode(seriesId: string, episodeNumber: number): Promise<void> {
    const series = await this.repo.series.findOne({ where: { id: seriesId } });
    if (!series) throw new HttpException('Series not found', HttpStatus.NOT_FOUND);

    const novelText = await this.s3HelperService.readText(
      `series/${seriesId}/episodes/${episodeNumber}/novel.txt`,
    );

    const sceneSchema = z.object({
      scenes: z.array(z.object({
        backgroundId: z.string().describe(
          '현재 장소에 가장 알맞은 backgrounds_info 내의 배경 ID. 매칭 없으면 bg_unknown',
        ),
        timeOfDay:    z.string().describe('이 Scene이 일어나는 시간대 (예: Morning, Night, Dusk)'),
        bgm_prompt:   z.string().describe('Scene 분위기에 맞는 BGM 생성용 짧은 영어 프롬프트'),
        dialogues: z.array(z.object({
          characterId: z.string().describe(
            '화자의 고유 ID (characters_info 참고). 나레이션인 경우 narrator',
          ),
          dialog:   z.string().describe('대사 또는 서술 내용 문장 원문 (번역 금지)'),
          action:   z.enum(['IDLE', 'ATTACK', 'SHAKE']).describe('화자의 행동/동작'),
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

    const parser = StructuredOutputParser.fromZodSchema(sceneSchema);
    const promptTemplate = new PromptTemplate({
      template: scene_prompt,
      inputVariables: ['novel_text', 'characters_info', 'backgrounds_info'],
      partialVariables: { format_instructions: parser.getFormatInstructions() },
    });

    const chain = promptTemplate.pipe(this.model).pipe(parser);

    const dbCharacters = await this.repo.character.find({ where: { seriesId } });
    const charactersInfoString = dbCharacters
      .map((c) => `- ID: ${c.id}, Name: ${c.name}, Sex: ${c.sex}, Description: ${c.look}`)
      .join('\n');

    const dbBackgrounds = await this.repo.background.find({ where: { seriesId } });
    const backgroundsInfoString = dbBackgrounds
      .map((b) => `- ID: ${b.id}, Name: ${b.name}, Description: ${b.description}`)
      .join('\n');

    const result = await chain.invoke({
      novel_text:       novelText,
      characters_info:  charactersInfoString,
      backgrounds_info: backgroundsInfoString,
    });

    // 사용된 감정 수집 → character_img 플레이스홀더 생성 (genId=null인 경우에만)
    const emotionMap = new Map<string, Set<Emotion>>();
    for (const scene of result.scenes) {
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

    // scenes.json을 S3에 저장
    await this.s3HelperService.uploadJson(
      `series/${seriesId}/episodes/${episodeNumber}/scenes.json`,
      result,
    );

    this.logger.log(`[${seriesId}/ep${episodeNumber}] scenes.json 저장 완료`);
  }
}
