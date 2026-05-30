export const enum PipelineEvent {
  START = 'pipeline.start',
  CHARACTERS_START = 'pipeline.characters.start',
  CHARACTERS_DONE = 'pipeline.characters.done',
  SCENES_START = 'pipeline.scenes.start',
  SCENES_DONE = 'pipeline.scenes.done',
  CHAR_IMG_START = 'pipeline.charImages.start',
  CHAR_IMG_DONE = 'pipeline.charImages.done',
  BG_IMG_START = 'pipeline.bgImages.start',
  BG_IMG_DONE = 'pipeline.bgImages.done',
  BGM_START = 'pipeline.bgm.start',
  BGM_DONE = 'pipeline.bgm.done',
}

export class PipelineStepPayload {
  episodeId: string;
}
