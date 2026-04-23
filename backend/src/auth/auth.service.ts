import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RepositoryProvider } from '../common/repository.provider';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: RepositoryProvider,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existingLoginId = await this.repo.user.findOne({ where: { loginId: dto.loginId } });
    if (existingLoginId) {
      throw new HttpException('이미 사용 중인 loginId입니다.', HttpStatus.CONFLICT);
    }
    const existingEmail = await this.repo.user.findOne({ where: { email: dto.email } });
    if (existingEmail) {
      throw new HttpException('이미 사용 중인 이메일입니다.', HttpStatus.CONFLICT);
    }

    const hashed = await bcrypt.hash(dto.password, 10);
    const user = this.repo.user.create({
      loginId:  dto.loginId,
      email:    dto.email,
      password: hashed,
      nickname: dto.nickname,
    });
    const saved = await this.repo.user.save(user);
    return { id: saved.id, loginId: saved.loginId, nickname: saved.nickname };
  }

  async login(dto: LoginDto) {
    const user = await this.repo.user.findOne({ where: { loginId: dto.loginId } });
    if (!user) {
      throw new HttpException('존재하지 않는 계정입니다.', HttpStatus.UNAUTHORIZED);
    }
    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) {
      throw new HttpException('비밀번호가 일치하지 않습니다.', HttpStatus.UNAUTHORIZED);
    }
    const payload = { sub: user.id, loginId: user.loginId };
    const accessToken = this.jwtService.sign(payload);
    return { accessToken };
  }

  async getMe(userId: string) {
    const user = await this.repo.user.findOne({ where: { id: userId } });
    if (!user) throw new HttpException('사용자를 찾을 수 없습니다.', HttpStatus.NOT_FOUND);
    return { id: user.id, loginId: user.loginId, email: user.email, nickname: user.nickname, createdAt: user.createdAt };
  }
}
