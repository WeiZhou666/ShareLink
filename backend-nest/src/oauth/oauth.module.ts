import { Module } from '@nestjs/common';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { GithubProvider } from './provider/github.provider';
import { LocalOidcProvider } from './provider/local-oidc.provider';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  // AuthModule：复用 generateToken（双 token 签发）与 addTokensToResponse（Set-Cookie）
  // RedisModule：state/nonce 一次性凭证存取
  imports: [AuthModule, RedisModule],
  controllers: [OAuthController],
  providers: [OAuthService, GithubProvider, LocalOidcProvider],
})
export class OAuthModule {}
