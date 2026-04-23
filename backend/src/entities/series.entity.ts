import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { User } from './user.entity';

@Entity('series')
export class Series {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column()
  authorId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'authorId' })
  author: User;

  @Column({ length: 100, nullable: true })
  characterStyleKey: string;

  @Column({ type: 'text', nullable: true })
  characterArtStyle: string;

  @Column({ length: 100, nullable: true })
  backgroundStyleKey: string;

  @Column({ type: 'text', nullable: true })
  backgroundArtStyle: string;

  @Column({ nullable: true, type: 'datetime' })
  latestEpisodeAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
