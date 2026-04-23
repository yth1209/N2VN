import { IsEmail, IsString, Length, Matches, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-z0-9_]+$/, { message: 'loginId는 영문 소문자, 숫자, 밑줄만 허용됩니다.' })
  loginId: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @Length(2, 50)
  nickname: string;
}
