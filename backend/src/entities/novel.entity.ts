import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('novel')
export class Novel {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  novelTitle: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  characterStyleKey: string;

  @Column({ type: 'text', nullable: true })
  characterArtStyle: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  backgroundStyleKey: string;

  @Column({ type: 'text', nullable: true })
  backgroundArtStyle: string;
}
