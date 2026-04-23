import { IsString, Length, IsOptional } from 'class-validator';

export class CreateSeriesDto {
  @IsString()
  @Length(1, 255)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;
}
