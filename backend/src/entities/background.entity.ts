import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Novel } from './novel.entity';

@Entity('background')
export class Background {
  @PrimaryColumn({ type: 'varchar', length: 150 })
  id: string;

  @Column({ type: 'int' })
  novelId: number;

  /** DB 상의 FK 제약조건 및 Cascade 명시를 위한 가상 관계 매핑 (로직 사용 X) */
  @ManyToOne(() => Novel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'novelId' })
  _novelFk?: Novel;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  genId: string;
}
