import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Series } from './series.entity';
import { BgmCategory } from '../common/constants';

@Entity('bgm')
export class Bgm {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  seriesId: string;

  @ManyToOne(() => Series, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'seriesId' })
  series: Series;

  @Column({ type: 'enum', enum: BgmCategory })
  category: BgmCategory;

  @Column({ type: 'text' })
  prompt: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  genId: string | null;
  // S3 경로는 코드에서 조합: series/{seriesId}/bgm/{id}.mp3
}
