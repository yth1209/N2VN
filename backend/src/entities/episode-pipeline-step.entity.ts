import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { Episode } from './episode.entity';

export enum StepKey {
  PARSE_CHARACTERS           = 'parseCharacters',
  PARSE_BACKGROUNDS          = 'parseBackgrounds',
  PARSE_SCENES               = 'parseScenes',
  GENERATE_CHARACTER_IMAGES  = 'generateCharacterImages',
  GENERATE_BACKGROUND_IMAGES = 'generateBackgroundImages',
}

export const STEP_ORDER: StepKey[] = [
  StepKey.PARSE_CHARACTERS,
  StepKey.PARSE_BACKGROUNDS,
  StepKey.PARSE_SCENES,
  StepKey.GENERATE_CHARACTER_IMAGES,
  StepKey.GENERATE_BACKGROUND_IMAGES,
];

export enum StepStatus {
  PENDING    = 'PENDING',
  PROCESSING = 'PROCESSING',
  DONE       = 'DONE',
  FAILED     = 'FAILED',
}

@Entity('episode_pipeline_step')
@Unique(['episodeId', 'stepKey'])
export class EpisodePipelineStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  episodeId: string;

  @ManyToOne(() => Episode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'episodeId' })
  episode: Episode;

  @Column({ type: 'enum', enum: StepKey })
  stepKey: StepKey;

  @Column({ type: 'enum', enum: StepStatus, default: StepStatus.PENDING })
  status: StepStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ nullable: true, type: 'datetime' })
  startedAt: Date;

  @Column({ nullable: true, type: 'datetime' })
  finishedAt: Date;
}
