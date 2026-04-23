import { IsString, IsNumber } from 'class-validator';

export class ParseEpisodeDto {
  @IsString()
  seriesId: string;

  @IsNumber()
  episodeNumber: number;
}
