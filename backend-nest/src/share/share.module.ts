/**
 * 分享模块：分享/文件/反向分享三组路由 + 服务 + 守卫
 * （过期分享定时清理已并入独立的 jobs 模块，见 src/jobs/jobs.service.ts）
 *
 * 模块要点：
 * 1. JwtModule.register——ShareService 签发分享访问令牌、ShareController 分拣
 *    share_*_token cookie、ShareSecurityGuard 验签都用 JwtService。
 *    分享令牌的 secret/有效期在每次 sign() 时显式传入（不复用 auth 的 15m 全局配置）
 * 2. RawBodyMiddleware——分块上传是 octet-stream 原始体，Nest 默认的 JSON/URL 编码
 *    解析器不处理该类型，必须自己挂 express.raw，limit = share.chunkSize（动态取配置）
 * 3. 守卫全部注册为 providers：守卫本质是带依赖注入的类，@UseGuards(类) 时由本模块
 *    的 DI 容器实例化（JwtAuthGuard 等父类依赖的 PrismaService/I18nService 是全局模块，
 *    JwtService 由本模块的 JwtModule 提供）
 * 4. PrismaService（PrismaModule @Global）、AppConfigService（AppConfigModule @Global）、
 *    EmailService（EmailModule @Global）均无需显式 import
 */
import {
  Injectable,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import * as express from 'express';
import { AppConfigService } from '../config/config.service';
import { AntivirusModule } from '../antivirus/antivirus.module';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { ReverseShareController } from './reverse-share.controller';
import { ReverseShareService } from './reverse-share.service';
import { ShareController } from './share.controller';
import { ShareService } from './share.service';
import { CreateShareGuard } from './guard/create-share.guard';
import { FileSecurityGuard } from './guard/file-security.guard';
import {
  ShareOwnerGuard,
  StrictShareOwnerGuard,
} from './guard/share-owner.guard';
import { ShareSecurityGuard } from './guard/share-security.guard';
import { ShareTokenGuard } from './guard/share-token.guard';

/**
 * octet-stream 原始体解析中间件：分块上传路由专用
 *
 * 为什么不用全局 raw body：raw 解析会把"所有"请求体无差别读进内存（包括 JSON），
 * 内存峰值不可控。这里只对"POST + Content-Type: application/octet-stream"生效。
 *
 * 为什么不用固定 limit：单块大小由 share.chunkSize 配置决定（admin 可改），
 * limit 必须跟随；按 limit 值缓存 parser 实例——配置没变就复用，变了才重建
 * （express.raw 工厂每次调用都会创建新的解析器闭包，不能每请求都造一个）
 */
@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  /** 按 limit 缓存的 parser 实例（chunkSize 配置变更后自动换新） */
  private cached: { limit: number; parser: RequestHandler } | null = null;

  constructor(private appConfig: AppConfigService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    // 只管分块上传：方法非 POST、或 Content-Type 不是 octet-stream（下载/预览等）直接放行
    if (req.method !== 'POST') return next();
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/octet-stream')) return next();

    const chunkSize = await this.appConfig.getNumber('share.chunkSize');
    if (!this.cached || this.cached.limit !== chunkSize) {
      this.cached = {
        limit: chunkSize,
        // limit 允许的最大字节数：恰好等于 chunkSize（前端按同一配置切片，单块不会超）
        parser: express.raw({
          type: 'application/octet-stream',
          limit: chunkSize,
        }),
      };
    }
    this.cached.parser(req, res, next);
  }
}

@Module({
  imports: [
    // 分享令牌签发/验签共用 JWT_SECRET（与登录 token 同密钥，但载荷与有效期独立）
    JwtModule.register({
      secret: process.env.JWT_SECRET!,
    }),
    // 病毒扫描：ShareService.complete 触发 ScanService.scanShare（先扫描后打 zip）
    AntivirusModule,
  ],
  controllers: [ShareController, FileController, ReverseShareController],
  // FileService 导出给 users 模块：注销账号时清理该用户名下分享的磁盘文件
  // ShareService 导出给 jobs 模块：任务 8 重扫 ERROR 后补打 zip
  exports: [FileService, ShareService],
  providers: [
    ShareService,
    FileService,
    ReverseShareService,
    // 守卫注册为 providers（@UseGuards(类) 时由本模块容器实例化并注入依赖）
    CreateShareGuard,
    ShareOwnerGuard,
    StrictShareOwnerGuard,
    ShareSecurityGuard,
    ShareTokenGuard,
    FileSecurityGuard,
  ],
})
export class ShareModule implements NestModule {
  /**
   * 挂载原始体解析中间件。
   * 直接对 FileController 整个控制器生效（内部再按 method+Content-Type 过滤）——
   * 比 forRoutes("shares/:shareId/files") 字符串路径更稳：不依赖通配符语义
   * （Nest 11 对 * 通配的中间件路径匹配有破坏性变更），也天然跟随控制器路由前缀。
   */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RawBodyMiddleware).forRoutes(FileController);
  }
}
