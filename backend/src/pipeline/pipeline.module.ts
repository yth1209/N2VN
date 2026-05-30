import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ParsingModule } from '../parsing/parsing.module';
import { ImageModule } from '../image/image.module';
import { SoundModule } from '../sound/sound.module';
import { CharacterParsingHandler } from './handlers/character-parsing.handler';
import { SceneParsingHandler } from './handlers/scene-parsing.handler';
import { CharacterImageHandler } from './handlers/character-image.handler';
import { BackgroundImageHandler } from './handlers/background-image.handler';
import { BgmHandler } from './handlers/bgm.handler';

@Module({
  imports: [CommonModule, ParsingModule, ImageModule, SoundModule],
  providers: [
    CharacterParsingHandler,
    SceneParsingHandler,
    CharacterImageHandler,
    BackgroundImageHandler,
    BgmHandler,
  ],
})
export class PipelineModule { }
