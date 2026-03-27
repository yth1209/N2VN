import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { character_prompt, scene_prompt } from './prompt/prompt';

@Injectable()
export class NovelParsingService {
  private readonly logger = new Logger(NovelParsingService.name);
  private readonly model: ChatGoogleGenerativeAI;

  constructor(private readonly configService: ConfigService) {
    this.model = new ChatGoogleGenerativeAI({
      model: this.configService.get<string>('GEMINI_MODEL'),
      temperature: 0.1,
      apiKey: this.configService.get<string>('GEMINI_API_KEY'),
    });
  }

  /**
   * 로컬 폴더에 JSON 데이터를 저장하는 공통 헬퍼 메서드
   */
  private async saveJsonToFile(novelTitle: string, fileName: string, data: any) {
    const fs = require('fs/promises');
    const path = require('path');
    const dirPath = path.join(process.cwd(), '..', 'novel', novelTitle);
    await fs.mkdir(dirPath, { recursive: true });
    const savePath = path.join(dirPath, fileName);
    await fs.writeFile(savePath, JSON.stringify(data, null, 2), 'utf-8');
    this.logger.log(`Saved ${fileName} to: ${savePath}`);
  }

  /**
   * 로컬 폴더에서 소설 텍스트를 읽어오는 공통 헬퍼 메서드
   */
  private async readNovelText(novelTitle: string): Promise<string> {
    const fs = require('fs/promises');
    const path = require('path');
    const novelPath = path.join(process.cwd(), '..', 'novel', novelTitle, 'novel.txt');
    try {
      return await fs.readFile(novelPath, 'utf8');
    } catch (error) {
      this.logger.error(`소설 텍스트 읽기 실패: ${novelPath}`, error);
      throw new HttpException(`Failed to read novel.txt for title: ${novelTitle}`, HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * 내부 파일을 로드하여 등장인물 메타데이터를 추출하고 로컬 파일에 저장합니다.
   * @param novelTitle 소설 제목 (파일 저장을 위한 폴더명)
   */
  async extractCharactersMetadata(novelTitle: string) {
    try {
      const novelText = await this.readNovelText(novelTitle);

      // 2. 강제할 JSON 포맷에 대한 스키마 정의 (Zod 활용)
      const characterSchema = z.record(
        z.string().describe("등장인물의 원본 이름 (영어로 번역 절대 하지 말 것, 원문 그대로 작성, 예: 백무진, 진소룡)"),
        z.object({
          sex: z.string().describe("성별 (예: male, female, unknown)"),
          age: z.string().describe("나이 또는 연령대 (예: 20s, unknown, elderly)"),
          look: z.array(z.string()).describe("외모, 옷차림 등에 대한 짧은 영단어/구문 배열 (예: handsome, blue shirt)"),
          job: z.array(z.string()).describe("직업, 칭호, 역할 등에 대한 짧은 영단어/구문 배열 (예: sword master)"),
          character: z.array(z.string()).describe("성격, 태도, 기질 등에 대한 짧은 영단어/구문 배열 (예: quiet, strong)"),
        })
      );

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
      Object.entries(result).forEach(([name, attributes], index) => {
        const id = `char_${index + 1}`;
        charactersObject[id] = {
          name,
          ...(attributes as any)
        };
      });

      await this.saveJsonToFile(novelTitle, 'characters.json', charactersObject);

      return charactersObject;

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
      const novelText = await this.readNovelText(novelTitle);

      const sceneSchema = z.object({
        scenes: z.array(z.object({
          location: z.string().describe("이 Scene이 일어나는 물리적 장소"),
          time: z.string().describe("이 Scene이 일어나는 시간적 배경"),
          bgm_prompt: z.string().describe("Scene 분위기에 맞는 BGM 생성용 짧은 영어 프롬프트 (예: majestic orchestral battle music)"),
          dialogues: z.array(z.object({
            characterId: z.string().describe("화자의 고유 ID (characters_info 참고). 나레이션인 경우 'narrator'"),
            dialog: z.string().describe("대사 또는 서술 내용 문장 원문 (번역 금지)"),
            action: z.string().describe("화자의 행동/동작을 묘사하는 짧은 영어 구문 (예: turning back, swinging sword)"),
            emotion: z.string().describe("화자의 감정을 묘사하는 짧은 영어 단어/구문 (예: furious, calm)"),
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

      const fs = require('fs/promises');
      const path = require('path');
      let charactersInfoString = '';
      try {
        const charPath = path.join(process.cwd(), '..', 'novel', novelTitle, 'characters.json');
        const charactersData = await fs.readFile(charPath, 'utf-8');
        const charactersObject = JSON.parse(charactersData);
        charactersInfoString = Object.entries(charactersObject).map(([id, c]: [string, any]) => `- ID: ${id}, Name: ${c.name}, Sex: ${c.sex}, Job: ${c.job.join(', ')}`).join('\n');
      } catch (e) {
        this.logger.warn('characters.json not found. Proceeding without characters_info.');
      }

      const result = await chain.invoke({
        novel_text: novelText,
        characters_info: charactersInfoString
      });

      await this.saveJsonToFile(novelTitle, 'scenes.json', result);

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
