import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { character_prompt, scene_prompt } from './prompt/prompt';
import { S3HelperService } from '../common/s3-helper.service';
import { ALL_EMOTIONS, STYLE_KEYS } from '../common/constants';

@Injectable()
export class NovelParsingService {
  private readonly logger = new Logger(NovelParsingService.name);
  private readonly model: ChatGoogleGenerativeAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3HelperService: S3HelperService,
  ) {
    this.model = new ChatGoogleGenerativeAI({
      model: this.configService.get<string>('GEMINI_MODEL'),
      temperature: 0.1,
      apiKey: this.configService.get<string>('GEMINI_API_KEY'),
    });
  }

  /**
   * 내부 파일을 로드하여 등장인물 메타데이터를 추출하고 로컬 파일에 저장합니다.
   * @param novelTitle 소설 제목 (파일 저장을 위한 폴더명)
   */
  async extractCharactersMetadata(novelTitle: string) {
    try {
      const novelText = await this.s3HelperService.readText(`${novelTitle}/novel.txt`);

      // 2. 강제할 JSON 포맷에 대한 스키마 정의 (Zod 활용)
      const characterSchema = z.object({
        globalArtStyle: z.string().describe("해당 소설 세계관의 모든 캐릭터 이미지 생성 시 공통으로 적용될 통일된 화풍(Art Style) 및 렌더링 스타일 특징을 묘사하는 영어 프롬프트 (예: high quality webtoon style, detailed wuxia illustration, masterpiece, aesthetic anime lighting)"),
        styleKey: z.enum(STYLE_KEYS).describe("소설 장르 및 분위기에 가장 어울리는 범용적인 렌더링 필터 스타일. 무협이나 판타지는 DYNAMIC/VIBRANT, 실사풍이나 고어/무거운 분위기는 CINEMATIC/MOODY, 몽환적이면 CREATIVE 등 가장 알맞은 하나를 고를 것."),
        characters: z.record(
          z.string().describe("등장인물의 원본 이름 (영어로 번역 절대 하지 말 것, 원문 그대로 작성, 예: 백무진, 진소룡)"),
          z.object({
            sex: z.string().describe("성별 (예: male, female, unknown)"),
            look: z.string().describe("이 캐릭터의 나이, 직업, 성격, 성향, 외견 및 옷차림 특징을 모두 포괄하여 Leonardo AI 이미지 생성 프롬프트로 바로 쓸 수 있는 1~3문장 길이의 구체적인 영어 줄글 (예: A handsome 20s sword master. He has sharp eyes and tied black hair, wearing a traditional blue shirt. He looks tall, serious, and highly confident.)"),
          })
        )
      });

      const parser = StructuredOutputParser.fromZodSchema(characterSchema);

      // 3. LLM에게 전달할 프롬프트 템플릿 작성
      const promptTemplate = new PromptTemplate({
        template: character_prompt,
        inputVariables: ['novel_text'],
        partialVariables: { format_instructions: parser.getFormatInstructions() },
      });

      // 4. LangChain 실행 파이프라인(Chain) 구성
      const chain = promptTemplate.pipe(this.model).pipe(parser);

      const result = await chain.invoke({
        novel_text: novelText,
      });

      const charactersObject: Record<string, any> = {};
      Object.entries(result.characters).forEach(([name, attributes], index) => {
        const id = `char_${index + 1}`;
        charactersObject[id] = {
          name,
          ...(attributes as any)
        };
      });

      const finalOutput = {
        globalArtStyle: result.globalArtStyle,
        styleKey: result.styleKey,
        characters: charactersObject
      };

      await this.s3HelperService.uploadJson(`${novelTitle}/characters.json`, finalOutput);

      return finalOutput;

    } catch (error) {
      this.logger.error('메타데이터 추출 중 오류 발생:', error);
      throw new HttpException(
        '로직 처리 중 오류가 발생했습니다.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 소설 텍스트를 파싱하여 장소/시간별 씬(Scene) 정보와 대사 배열을 추출합니다.
   * @param novelTitle 소설 제목 (캐릭터 메타데이터 로드용 결합)
   */
  async extractScenesMetadata(novelTitle: string) {
    try {
      const novelText = await this.s3HelperService.readText(`${novelTitle}/novel.txt`);

      const sceneSchema = z.object({
        scenes: z.array(z.object({
          location: z.string().describe("이 Scene이 일어나는 물리적 장소"),
          time: z.string().describe("이 Scene이 일어나는 시간적 배경"),
          bgm_prompt: z.string().describe("Scene 분위기에 맞는 BGM 생성용 짧은 영어 프롬프트 (예: majestic orchestral battle music)"),
          dialogues: z.array(z.object({
            characterId: z.string().describe("화자의 고유 ID (characters_info 참고). 나레이션인 경우 'narrator'"),
            dialog: z.string().describe("대사 또는 서술 내용 문장 원문 (번역 금지)"),
            action: z.enum(['IDLE', 'ATTACK', 'SHAKE']).describe("화자의 행동/동작 (반드시 다음 중 한 가지만 선택: IDLE, ATTACK, SHAKE)"),
            emotion: z.enum(ALL_EMOTIONS).describe(`화자의 감정 (반드시 다음 중 한 가지만 선택: ${ALL_EMOTIONS.join(', ')})`),
            look: z.string().describe("화자의 표정이나 드러나는 외모를 묘사하는 짧은 영어 구문 (알 수 없으면 'unknown')")
          })).describe("이 씬에 포함되는 모든 대사와 나레이션을 순서대로 담은 배열")
        }))
      });

      const parser = StructuredOutputParser.fromZodSchema(sceneSchema);

      const promptTemplate = new PromptTemplate({
        template: scene_prompt,
        inputVariables: ['novel_text', 'characters_info'],
        partialVariables: { format_instructions: parser.getFormatInstructions() },
      });

      const chain = promptTemplate.pipe(this.model).pipe(parser);

      let charactersInfoString = '';
      try {
        const extractedData = await this.s3HelperService.readJson(`${novelTitle}/characters.json`);
        const chars = extractedData.characters || extractedData; // 호환성 고려
        charactersInfoString = Object.entries(chars).map(([id, c]: [string, any]) => `- ID: ${id}, Name: ${c.name}, Sex: ${c.sex}, Description: ${c.look}`).join('\n');
      } catch (e) {
        this.logger.warn('characters.json not found in S3. Proceeding without characters_info.');
      }

      const result = await chain.invoke({
        novel_text: novelText,
        characters_info: charactersInfoString
      });

      await this.s3HelperService.uploadJson(`${novelTitle}/scenes.json`, result);

      return result;

    } catch (error) {
      this.logger.error('Scene 추출 중 오류 발생:', error);
      throw new HttpException(
        '로직 처리 중 오류가 발생했습니다.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
