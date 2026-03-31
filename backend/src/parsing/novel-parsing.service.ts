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
export class NovelParsingService {
  private readonly logger = new Logger(NovelParsingService.name);
  private readonly model: ChatGoogleGenerativeAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3HelperService: S3HelperService,
    private readonly repo: RepositoryProvider,
  ) {
    this.model = new ChatGoogleGenerativeAI({
      model: this.configService.get<string>('GEMINI_MODEL'),
      temperature: 0.1,
      apiKey: this.configService.get<string>('GEMINI_API_KEY'),
    });
  }

  async extractCharactersMetadata(novelId: number) {
    try {
      const novel = await this.repo.novel.findOne({ where: { id: novelId } });
      if (!novel) throw new HttpException('Novel not found', HttpStatus.NOT_FOUND);

      const novelText = await this.s3HelperService.readText(`${novel.id}/novel.txt`);

      const characterSchema = z.object({
        globalArtStyle: z.string().describe("해당 소설 세계관의 모든 캐릭터 이미지 생성 시 공통으로 적용될 통일된 화풍(Art Style) 및 렌더링 스타일 특징을 묘사하는 영어 프롬프트 (예: high quality webtoon style, detailed wuxia illustration, masterpiece, aesthetic anime lighting)"),
        styleKey: z.nativeEnum(StyleKey).describe("소설 장르 및 분위기에 가장 어울리는 범용적인 렌더링 필터 스타일. 무협이나 판타지는 DYNAMIC/VIBRANT, 실사풍이나 고어/무거운 분위기는 CINEMATIC/MOODY, 몽환적이면 CREATIVE 등 가장 알맞은 하나를 고를 것."),
        characters: z.record(
          z.string().describe("등장인물의 원본 이름 (영어로 번역 절대 하지 말 것, 원문 그대로 작성, 예: 백무진, 진소룡)"),
          z.object({
            sex: z.string().describe("성별 (예: male, female, unknown)"),
            look: z.string().describe("이 캐릭터의 나이, 직업, 성격, 성향, 외견 및 옷차림 특징을 모두 포괄하여 Leonardo AI 이미지 생성 프롬프트로 바로 쓸 수 있는 1~3문장 길이의 구체적인 영어 줄글"),
          })
        )
      });

      const parser = StructuredOutputParser.fromZodSchema(characterSchema);

      const promptTemplate = new PromptTemplate({
        template: character_prompt,
        inputVariables: ['novel_text'],
        partialVariables: { format_instructions: parser.getFormatInstructions() },
      });

      const chain = promptTemplate.pipe(this.model).pipe(parser);
      const result = await chain.invoke({ novel_text: novelText });

      // DB 저장 (Reset)
      novel.characterArtStyle = result.globalArtStyle;
      novel.characterStyleKey = result.styleKey;
      await this.repo.novel.save(novel);

      // 기존 소설에 속한 캐릭터 정보 삭제하여 완전 리셋
      await this.repo.character.delete({ novelId });

      const newCharacters = Object.entries(result.characters).map(([name, attr]: [string, any], idx) => {
        const id = `${novelId}_char_${idx + 1}`;
        return this.repo.character.create({
          id,
          novelId,
          name,
          sex: attr.sex,
          look: attr.look,
        });
      });

      await this.repo.character.save(newCharacters);

      return {
        globalArtStyle: result.globalArtStyle,
        styleKey: result.styleKey,
        characters: newCharacters,
      };
    } catch (error) {
      this.logger.error('메타데이터 추출 중 오류 발생:', error);
      throw new HttpException('로직 처리 중 오류가 발생했습니다.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async extractBackgroundsMetadata(novelId: number) {
    try {
      const novel = await this.repo.novel.findOne({ where: { id: novelId } });
      if (!novel) throw new HttpException('Novel not found', HttpStatus.NOT_FOUND);

      const novelText = await this.s3HelperService.readText(`${novel.id}/novel.txt`);

      const backgroundSchema = z.object({
        globalBackgroundArtStyle: z.string().describe("이 소설의 모든 배경 이미지 생성에 공통으로 적용될 환경/건축물 화풍 및 분위기 (예: highly detailed wuxia landscape, majestic ancient architecture, oriental ink painting style, 8k resolution, cinematic lighting)"),
        styleKey: z.nativeEnum(StyleKey).describe("소설 배경 분위기에 가장 어울리는 범용적인 렌더링 필터 스타일. 무협이나 판타지는 DYNAMIC/VIBRANT, 실사풍이나 고어/무거운 분위기는 CINEMATIC/MOODY, 몽환적이면 CREATIVE 등 가장 알맞은 하나를 고를 것."),
        backgrounds: z.record(
          z.string().describe("배경 장소의 고유 ID (이 필드는 쓰지 말고 DB에서 덮어씌울 예정이지만 명확히 구분 가능한 임의 ID 유지)"),
          z.object({
            name: z.string().describe("배경의 실제 이름 또는 짧은 명칭 (예: 화산파 연무장, 십만대산 감옥)"),
            description: z.string().describe("이 배경의 시각적 특징, 분위기, 주변 사물 등을 1~3문장 길이의 구체적인 영어 줄글로 묘사 (Leonardo AI 프롬프트용. 시간대 묘사는 제외할 것.)"),
          })
        ).describe("소설 내에 등장하는 유의미한 주요 배경들의 목록")
      });

      const parser = StructuredOutputParser.fromZodSchema(backgroundSchema);

      const promptTemplate = new PromptTemplate({
        template: background_prompt,
        inputVariables: ['novel_text'],
        partialVariables: { format_instructions: parser.getFormatInstructions() },
      });

      const chain = promptTemplate.pipe(this.model).pipe(parser);
      const result = await chain.invoke({ novel_text: novelText });

      novel.backgroundArtStyle = result.globalBackgroundArtStyle;
      novel.backgroundStyleKey = result.styleKey;
      await this.repo.novel.save(novel);

      await this.repo.background.delete({ novelId });

      const newBackgrounds = Object.entries(result.backgrounds).map(([bgOriginalId, attr]: [string, any], idx) => {
        const id = `${novelId}_bg_${idx + 1}`;
        return this.repo.background.create({
          id,
          novelId,
          name: attr.name,
          description: attr.description,
        });
      });

      await this.repo.background.save(newBackgrounds);

      return {
        globalBackgroundArtStyle: result.globalBackgroundArtStyle,
        styleKey: result.styleKey,
        backgrounds: newBackgrounds,
      };
    } catch (error) {
      this.logger.error('배경 메타데이터 추출 중 오류 발생:', error);
      throw new HttpException('로직 처리 중 오류가 발생했습니다.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async extractScenesMetadata(novelId: number) {
    try {
      const novel = await this.repo.novel.findOne({ where: { id: novelId } });
      if (!novel) throw new HttpException('Novel not found', HttpStatus.NOT_FOUND);

      const novelText = await this.s3HelperService.readText(`${novel.id}/novel.txt`);

      const sceneSchema = z.object({
        scenes: z.array(z.object({
          backgroundId: z.string().describe("현재 장소에 가장 알맞은 backgrounds_info 내의 배경 ID (예: 1_bg_1). 매칭되는 곳이 없다면 'bg_unknown'"),
          timeOfDay: z.string().describe("이 Scene이 일어나는 시간대 (예: Morning, Night, Dusk)"),
          bgm_prompt: z.string().describe("Scene 분위기에 맞는 BGM 생성용 짧은 영어 프롬프트 (예: majestic orchestral battle music)"),
          dialogues: z.array(z.object({
            characterId: z.string().describe("화자의 고유 ID (characters_info 참고. 예: 1_char_1). 나레이션인 경우 'narrator'"),
            dialog: z.string().describe("대사 또는 서술 내용 문장 원문 (번역 금지)"),
            action: z.enum(['IDLE', 'ATTACK', 'SHAKE']).describe("화자의 행동/동작 (반드시 다음 중 한 가지만 선택: IDLE, ATTACK, SHAKE)"),
            emotion: z.nativeEnum(Emotion).describe(`화자의 감정 (반드시 다음 중 한 가지만 선택: ${Object.values(Emotion).join(', ')})`),
            look: z.string().describe("화자의 표정이나 드러나는 외모를 묘사하는 짧은 영어 구문 (알 수 없으면 'unknown')")
          })).describe("이 씬에 포함되는 모든 대사와 나레이션을 순서대로 담은 배열")
        }))
      });

      const parser = StructuredOutputParser.fromZodSchema(sceneSchema);

      const promptTemplate = new PromptTemplate({
        template: scene_prompt,
        inputVariables: ['novel_text', 'characters_info', 'backgrounds_info'],
        partialVariables: { format_instructions: parser.getFormatInstructions() },
      });

      const chain = promptTemplate.pipe(this.model).pipe(parser);

      const dbCharacters = await this.repo.character.find({ where: { novelId } });
      const charactersInfoString = dbCharacters.map(c => `- ID: ${c.id}, Name: ${c.name}, Sex: ${c.sex}, Description: ${c.look}`).join('\n');

      const dbBackgrounds = await this.repo.background.find({ where: { novelId } });
      const backgroundsInfoString = dbBackgrounds.map(b => `- ID: ${b.id}, Name: ${b.name}, Description: ${b.description}`).join('\n');

      const result = await chain.invoke({
        novel_text: novelText,
        characters_info: charactersInfoString,
        backgrounds_info: backgroundsInfoString
      });

      // 1. Scene 데이터를 바탕으로 필요한 캐릭터-감정 쌍 추출
      const emotionMap = new Map<string, Set<Emotion>>(); // characterId -> Set of Emotions

      result.scenes.forEach(scene => {
        scene.dialogues.forEach(dialogue => {
          const charId = dialogue.characterId;
          if (charId && charId !== 'narrator') {
            if (!emotionMap.has(charId)) {
              emotionMap.set(charId, new Set<Emotion>([Emotion.DEFAULT])); // DEFAULT는 항상 포함
            }
            emotionMap.get(charId).add(dialogue.emotion as Emotion);
          }
        });
      });

      // 2. DB에 저장 (생성 대기 상태)
      for (const [charId, emotions] of emotionMap.entries()) {
        for (const emotion of emotions) {
          try {
            // Upsert 느낌으로 처리 (이미 있으면 무시)
            const exists = await this.repo.characterImg.findOne({ where: { characterId: charId, emotion } });
            if (!exists) {
              await this.repo.characterImg.save(this.repo.characterImg.create({
                characterId: charId,
                emotion,
                genId: null,
                nobgGenId: null
              }));
            }
          } catch (e: any) {
            this.logger.warn(`Failed to pre-register CharacterImg [${charId}, ${emotion}]: ${e.message}`);
          }
        }
      }

      // Scenes are still stored in S3 for game runtime
      await this.s3HelperService.uploadJson(`${novel.id}/scenes.json`, result);

      return result;

    } catch (error) {
      this.logger.error('Scene 추출 중 오류 발생:', error);
      throw new HttpException('로직 처리 중 오류가 발생했습니다.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
