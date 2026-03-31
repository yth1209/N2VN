import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Character } from './character.entity';

import { Emotion } from '../common/constants';

@Entity('character_img')
export class CharacterImg {
  @PrimaryColumn({ type: 'varchar', length: 150 })
  characterId: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  emotion: Emotion;

  /** DB 상의 FK 제약조건 및 Cascade 명시를 위한 가상 관계 매핑 (로직 사용 X) */
  @ManyToOne(() => Character, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'characterId' })
  _characterFk?: Character;

  @Column({ type: 'varchar', length: 255, nullable: true })
  genId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  nobgGenId: string;
}
