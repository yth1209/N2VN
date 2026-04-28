import { HttpStatus, HttpException, Injectable, Logger } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { RepositoryProvider } from '../common/repository.provider';
import { S3HelperService } from '../common/s3-helper.service';
import { GenAIHelperService } from '../common/gen-ai-helper.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PipelineEvent, PipelineStepPayload } from 'src/pipeline/pipeline.events';

@Injectable()
export class SoundService {
  private readonly logger = new Logger(SoundService.name);

  constructor(
    private readonly repo: RepositoryProvider,
    private readonly s3: S3HelperService,
    private readonly genAI: GenAIHelperService,
    private readonly emitter: EventEmitter2,
  ) { }

  async eventGenerateBgm(episodeId: string): Promise<void> {
    const episode = await this.repo.episode.findOne({where : {id: episodeId}})
    if(!episode) throw new HttpException(`Episode not found: ${episodeId}`, HttpStatus.NOT_FOUND)

    this.emitter.emit(PipelineEvent.BGM_START, {episodeId} satisfies PipelineStepPayload)
  }

  async generateBgm(episodeId: string): Promise<void> {
    const series = await this.repo.series.findByEpisodeId(episodeId)
    if(!series) throw new HttpException(`Series not found: ${episodeId}`, HttpStatus.NOT_FOUND)
    const seriesId = series.id

    const pending = await this.repo.bgm.find({ where: { seriesId, genId: IsNull() } });

    if (!pending.length) {
      this.logger.log(`[${seriesId}] 생성할 BGM 없음`);
      return;
    }

    this.logger.log(`[${seriesId}] BGM 생성 시작: ${pending.length}개`);

    const results = await Promise.allSettled(
      pending.map((bgm) => this.generateSingleBgm(seriesId, bgm)),
    );

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    failures.forEach((r) => this.logger.error(`[${seriesId}] BGM 생성 실패: ${r.reason?.message}`));

    if (failures.length > 0) throw new Error(`BGM 생성 실패 ${failures.length}/${pending.length}개`);

    this.logger.log(`[${seriesId}] 모든 BGM 생성 완료`);
  }

  private async generateSingleBgm(seriesId: string, bgm: any): Promise<void> {
    const fullPrompt = `${bgm.prompt}, instrumental only, no vocals, no lyrics, loopable structure, seamless loop`;
    const audioBuffer = await this.genAI.lyriaGenerateClip(fullPrompt);

    const s3Key = `series/${seriesId}/bgm/${bgm.id}.mp3`;
    await this.s3.uploadAudio(s3Key, audioBuffer, 'audio/mpeg');

    bgm.genId = bgm.id; // genId에 자신의 id 저장 (생성 완료 플래그)
    await this.repo.bgm.save(bgm);

    this.logger.log(`[${bgm.id}] BGM 생성 완료 → ${s3Key}`);
  }
}
