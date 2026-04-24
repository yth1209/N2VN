import { Injectable, Logger } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { RepositoryProvider } from '../common/repository.provider';
import { S3HelperService } from '../common/s3-helper.service';
import { GenAIHelperService } from '../common/gen-ai-helper.service';
import { StepKey, StepStatus } from '../entities/episode-pipeline-step.entity';

@Injectable()
export class BgmService {
  private readonly logger = new Logger(BgmService.name);

  constructor(
    private readonly repo: RepositoryProvider,
    private readonly s3: S3HelperService,
    private readonly genAI: GenAIHelperService,
  ) {}

  /**
   * seriesId에 속한 미생성 BGM(genId = null) 전체에 대해 Lyria 3 Clip 음원 생성 후 S3 업로드.
   * EpisodePipelineService의 GENERATE_BGM 단계 및 retry에서 호출.
   */
  async generateBgmForSeries(seriesId: string, episodeNumber?: number): Promise<void> {
    const episode = episodeNumber != null ? await this.repo.episode.findOneBy({ seriesId, episodeNumber }) : null;
    const episodeId = episode?.id;
    if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.GENERATE_BGM, StepStatus.PROCESSING, { startedAt: new Date() });

    try {
      await this._generateBgmForSeries(seriesId);
      if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.GENERATE_BGM, StepStatus.DONE, { finishedAt: new Date() });
    } catch (err: any) {
      if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.GENERATE_BGM, StepStatus.FAILED, { finishedAt: new Date(), errorMessage: err.message });
      throw err;
    }
  }

  private async _generateBgmForSeries(seriesId: string): Promise<void> {
    const pending = await this.repo.bgm.find({ where: { seriesId, genId: IsNull() } });

    if (!pending.length) {
      this.logger.log(`[${seriesId}] 생성할 BGM 없음`);
      return;
    }

    this.logger.log(`[${seriesId}] BGM 생성 시작: ${pending.length}개`);

    await Promise.all(
      pending.map((bgm) =>
        this.generateSingleBgm(seriesId, bgm).catch((err) =>
          this.logger.error(`[${bgm.id}] BGM 생성 실패: ${err.message}`),
        ),
      ),
    );

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
