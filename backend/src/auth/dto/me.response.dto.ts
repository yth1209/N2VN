import { User } from '../../entities/user.entity';

export class MeResponseDto {
  id: string;
  loginId: string;
  email: string;
  nickname: string;
  createdAt: Date;

  constructor(user: User) {
    this.id        = user.id;
    this.loginId   = user.loginId;
    this.email     = user.email;
    this.nickname  = user.nickname;
    this.createdAt = user.createdAt;
  }
}
