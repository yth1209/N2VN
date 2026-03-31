import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Novel } from '../entities/novel.entity';
import { Character } from '../entities/character.entity';
import { CharacterImg } from '../entities/character-img.entity';
import { Background } from '../entities/background.entity';

@Injectable()
export class RepositoryProvider {
  constructor(
    @InjectRepository(Novel) public readonly novel: Repository<Novel>,
    @InjectRepository(Character) public readonly character: Repository<Character>,
    @InjectRepository(CharacterImg) public readonly characterImg: Repository<CharacterImg>,
    @InjectRepository(Background) public readonly background: Repository<Background>,
  ) {}
}
