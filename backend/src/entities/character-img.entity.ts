import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Character } from './character.entity';
import { Emotion } from '../common/constants';

@Entity('character_img')
export class CharacterImg {
  @PrimaryColumn({ type: 'varchar' })
  characterId: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  emotion: Emotion;

  @ManyToOne(() => Character, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'characterId' })
  _characterFk?: Character;

  @Column({ type: 'varchar', length: 255, nullable: true })
  genId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  nobgGenId: string;
}
