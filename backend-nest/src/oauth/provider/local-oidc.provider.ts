import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { I18nService } from 'nestjs-i18n';
import { Logger } from 'winston';
import { RedisService } from '../../redis/redis.service';
import { GenericOidcProvider } from './generic-oidc.provider';

/**
 * 本地/自建 OIDC 提供商：指向任何标准 OIDC IdP——
 * 开发回归用 scripts/mock-oidp.mjs（无需外网），生产可指向自建 Keycloak 等，
 * 通过 OAUTH_LOCAL_ISSUER 配置。与 GoogleProvider 结构完全一致，印证"新增提供商=一份配置"
 */
@Injectable()
export class LocalOidcProvider extends GenericOidcProvider {
  readonly name = 'local';
  protected readonly issuerUri =
    process.env.OAUTH_LOCAL_ISSUER ?? 'http://localhost:9099';
  protected readonly clientId: string;
  protected readonly clientSecret: string;

  constructor(
    redis: RedisService,
    i18n: I18nService, // 父类不写 constructor：依赖在子类构造里注入后赋给 protected 字段
    @Inject(WINSTON_MODULE_PROVIDER) logger: Logger,
  ) {
    super();
    this.redis = redis;
    this.i18n = i18n;
    this.logger = logger;
    this.clientId = process.env.OAUTH_LOCAL_CLIENT_ID ?? 'local-client';
    this.clientSecret = process.env.OAUTH_LOCAL_CLIENT_SECRET ?? 'local-secret';
  }
}
