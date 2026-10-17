import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategy/jwt.strategy';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    PassportModule,
    // RedisService 在本模块内使用（AuthService 写黑名单 / JwtStrategy 查黑名单）
    RedisModule,
    // access JWT：15 分钟短过期；secret 来自当前环境的 env 文件
    JwtModule.register({
      secret: process.env.JWT_SECRET!,
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController],
  // providers 内的服务可注入 RedisService（RedisModule 已在上方 imports）
  // 过期 refresh 会话的定时清理统一在 jobs 模块（deleteExpiredTokens），不再本模块注册
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
