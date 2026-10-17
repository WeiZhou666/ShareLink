import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import Redis from 'ioredis';
import { Logger } from 'winston';

/** JWT 黑名单键前缀：键由本服务的 setBlackList/isInBlackList 独占读写，前缀就近定义并导出
 *  （用户级吊销键前缀在 auth/auth.constants.ts——由 auth.service 用通用 set/get 拼装，归属不同） */
export const JWT_BLACKLIST_PREFIX = 'jwt:black:';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    this.client = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      // 快速失败：离线命令不排队、最多重试 1 次，故障立即走下面的降级逻辑
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 1000, 5000),
    });
    // 必须挂 error 监听：否则 ioredis 的连接错误走 unhandled event 直接刷控制台
    this.client.on('error', (err) => {
      this.logger.error(
        `Redis 连接异常（命令层已 fail-open 降级）：${err.message}`,
        { context: RedisService.name },
      );
    });
  }

  /** 连通性自检（admin testRedis 端点）：PING → PONG，失败返回 false 而非抛错 */
  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** 设置黑名单（ttl 单位秒） */
  async setBlackList(jti: string, ttl: number) {
    try {
      await this.client.set(
        `${JWT_BLACKLIST_PREFIX}${jti}`,
        '1',
        'EX',
        Math.max(1, Math.ceil(ttl)),
      );
    } catch (err) {
      // 黑名单是加强项：Redis 故障时丢弃写入并告警（fail-open），不能把登录体系打挂
      this.logger.error(
        `Redis setBlackList 失败（降级为丢弃写入）：${JWT_BLACKLIST_PREFIX}${jti} - ${(err as Error).message}`,
        { context: RedisService.name },
      );
    }
  }

  /** 判断是否黑名单；Redis 故障时降级为未命中（fail-open），请求放行 */
  async isInBlackList(jti: string): Promise<boolean> {
    try {
      const val = await this.client.get(`${JWT_BLACKLIST_PREFIX}${jti}`);
      return val !== null;
    } catch (err) {
      this.logger.error(
        `Redis isInBlackList 失败（降级为未命中）：jwt:black:${jti} - ${(err as Error).message}`,
        { context: RedisService.name },
      );
      return false;
    }
  }

  // 通用get（Redis 故障时降级为 null，调用方按"未命中"处理）
  async get(key: string) {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.error(
        `Redis get 失败（降级为未命中）：${key} - ${(err as Error).message}`,
        { context: RedisService.name },
      );
      return null;
    }
  }

  /** 原子"取值即删除"（Redis 6.2+ GETDEL 命令）：OAuth 的 state/nonce 等一次性凭证校验专用。
   *  比先 get 再 del 少一次往返，且天然杜绝两次并发校验同时通过的竞态重放 */
  async getDel(key: string) {
    try {
      return await this.client.getdel(key);
    } catch (err) {
      this.logger.error(
        `Redis getDel 失败（降级为未命中）：${key} - ${(err as Error).message}`,
        { context: RedisService.name },
      );
      return null;
    }
  }
  /** 原子自增并给首置键配 TTL：验证码错误计数等防爆破计数器专用（INCR + 首次 EXPIRE）。
   *  必须原子：并发请求各自 get→set 会把计数互相覆盖，爆破者可借此绕过次数上限 */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number | null> {
    try {
      const count = await this.client.incr(key);
      if (count === 1) {
        await this.client.expire(key, Math.max(1, Math.ceil(ttlSeconds)));
      }
      return count;
    } catch (err) {
      this.logger.error(
        `Redis incrWithTtl 失败（降级为 0）：${key} - ${(err as Error).message}`,
        { context: RedisService.name },
      );
      return null;
    }
  }

  //通用set（Redis 故障时降级为丢弃写入并告警）
  async set(key: string, value: string, ttl?: number) {
    try {
      if (ttl) {
        return await this.client.set(
          key,
          value,
          'EX',
          Math.max(1, Math.ceil(ttl)),
        );
      }
      return await this.client.set(key, value);
    } catch (err) {
      this.logger.error(
        `Redis set 失败（降级为丢弃写入）：${key} - ${(err as Error).message}`,
        { context: RedisService.name },
      );
    }
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => undefined);
  }
}
