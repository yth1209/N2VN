import { IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  loginId: string;

  @IsString()
  password: string;
}
