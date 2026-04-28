import { DataSource, Repository } from 'typeorm';
import { Injectable } from '@nestjs/common';
import { EpisodePipelineStep, StepKey, StepStatus } from '../episode-pipeline-step.entity';

@Injectable()
export class EpisodePipelineStepRepository extends Repository<EpisodePipelineStep> {
  constructor(dataSource: DataSource) {
    super(EpisodePipelineStep, dataSource.createEntityManager());
  }

  async updateStep(
    episodeId: string,
    stepKey: StepKey,
    status: StepStatus,
    extra: { startedAt?: Date; finishedAt?: Date; errorMessage?: string } = {},
  ): Promise<void> {
    await this.update({ episodeId, stepKey }, { status, ...extra });
  }
}
