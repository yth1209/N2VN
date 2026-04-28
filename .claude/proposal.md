지금 backend\src\episode\episode-pipeline.service.ts의 run에서 오케스트레이터 방식으로 호출하고 있는데 이걸 event driven 아키텍처로 수정.

episod-pipline는 global_pipline_start event를 발행.

그러면 이제 그 이벤트를 character parsing이 listen하여 character parsing을 진행. 

character parsing이 완료되면 character parsing done event 발행

이를 scene parser가 listen하여 parsing 진행. 
완료되면 scene parsing done event 발행. 

이를 병렬적으로 진행되도 상관없는 background img, bgm, character img generation이 event 받아서 진행.
완료 되면 개별 done event 발행

여기서 각 process의 status를 관리하는 로직은 공통된 Event Handler(? 명칭은 명확하지 않음)이 관리했으면 좋겠음. 혹은 더 좋은 아키텍처가 있으면 공통화만 되면 됨 

async parse(seriesId: string, episodeNumber: number): Promise<void> {
    const episode = await this.repo.episode.findOneBy({ seriesId, episodeNumber });
    const episodeId = episode?.id;
    if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.PARSE_SCENES, StepStatus.PROCESSING, { startedAt: new Date() });

    try {
      # 개별 parse. 여기만 다름
      await this._parseScenes(seriesId, episodeNumber);
      
      if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.PARSE_SCENES, StepStatus.DONE, { finishedAt: new Date() });
    } catch (err: any) {
      if (episodeId) await this.repo.pipelineStep.updateStep(episodeId, StepKey.PARSE_SCENES, StepStatus.FAILED, { finishedAt: new Date(), errorMessage: err.message });
      throw err;
    }
  }