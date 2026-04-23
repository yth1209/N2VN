import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, OneToMany, JoinColumn, Unique } from 'typeorm';
import { Series } from './series.entity';

export enum EpisodeStatus {
  PENDING    = 'PENDING',
  PROCESSING = 'PROCESSING',
  DONE       = 'DONE',
  FAILED     = 'FAILED',
}

@Entity('episode')
@Unique(['seriesId', 'episodeNumber'])
export class Episode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  seriesId: string;

  @ManyToOne(() => Series, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'seriesId' })
  series: Series;

  @Column()
  episodeNumber: number;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'enum', enum: EpisodeStatus, default: EpisodeStatus.PENDING })
  status: EpisodeStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @CreateDateColumn()
  createdAt: Date;
}
