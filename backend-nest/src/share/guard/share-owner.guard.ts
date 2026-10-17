/**
 * 分享所有者守卫：挂在"管理自己的分享"的路由上（PATCH/DELETE/complete/expire…）
 *
 * 放行规则（与旧后端 ShareOwnerGuard 一致）：
 * 1. 分享创建者本人
 * 2. 管理员（allowAdmin 钩子，Strict 子类可关闭）
 * 3. 匿名分享（creatorId 为空，如经反向分享上传的）——任何人可管理
 *
 * 副作用：把 share 实体（含 security）缓存到 req.share，controller/service 可直接取用。
 */
import {
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import type { Share, ShareSecurity } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guard/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { I18nService } from 'nestjs-i18n';

/** req.share 的类型声明：守卫注入的"当前路由分享"（含安全策略） */
export type RequestShare = Share & { security: ShareSecurity | null };

/** Express Request 扩展：挂载当前分享与守卫链缓存的数据 */
declare module 'express' {
  interface Request {
    share?: RequestShare;
  }
}

@Injectable()
export class ShareOwnerGuard extends JwtAuthGuard {
  constructor(prisma: PrismaService, i18n: I18nService) {
    super(prisma, i18n);
  }

  /**
   * 管理员越权开关：默认允许 admin 管理任意分享；
   * StrictShareOwnerGuard（complete/文件上传等"仅限本人"场景）覆写为 false
   */
  protected get allowAdmin(): boolean {
    return true;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    // String() 收窄：Express 5 类型里 params 值是 string | string[]
    const shareId = String(request.params.id ?? request.params.shareId ?? '');

    // 分享必须存在（不校验过期——过期的分享仍允许创建者删除/管理）
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { security: true },
    });
    if (!share) {
      throw new NotFoundException('share.notFound');
    }
    request.share = share;

    // JWT 认证可选：匿名分享允许未登录操作（反向分享上传者无账号）
    let user: { id: string; isAdmin: boolean } | undefined;
    try {
      await super.canActivate(context);
      user = request.currentUser as any;
    } catch {
      user = undefined;
    }

    if (user && share.creatorId === user.id) return true;
    if (this.allowAdmin && user?.isAdmin) return true;
    // 匿名分享（无创建者）：任何人可管理（与旧后端语义一致）
    if (!share.creatorId) return true;
    return false;
  }
}

/**
 * 严格所有者守卫：管理员也不能越权。
 * 用于 complete（锁定上传）/ 文件分块上传 / 文件删除——
 * 这些操作语义上只能发生在"正在上传"的会话里，admin 越权没有意义还容易误操作。
 */
@Injectable()
export class StrictShareOwnerGuard extends ShareOwnerGuard {
  protected get allowAdmin(): boolean {
    return false;
  }
}
