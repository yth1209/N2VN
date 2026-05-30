import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Series } from './series.entity';
import { BgmCategory } from '../common/constants';
import { GenStatus } from './common/common.enum';

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

  @Column({ type: 'enum', enum: GenStatus, nullable: true })
  status: GenStatus;
}
