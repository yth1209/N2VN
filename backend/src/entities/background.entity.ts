import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Series } from './series.entity';

@Entity('background')
export class Background {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  seriesId: string;

  @ManyToOne(() => Series, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'seriesId' })
  series: Series;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  genId: string;
}
