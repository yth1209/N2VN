import { IsString, Length } from 'class-validator';

export class CreateEpisodeDto {
  @IsString()
  @Length(1, 255)
  title: string;
}
