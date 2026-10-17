/**
 * 反向分享服务：把 {appUrl}/upload/{token} 链接发给别人，对方免登录向你上传文件
 *
 * 有效期规则：
 * - shareExpiration：令牌自身有效期（相对时间由 creator 自选）
 * - remainingUses：用一次少一次（complete 时原子递减），扣完失效
 * - 令牌创建的分享：过期时间强制 = 令牌 shareExpiration（覆盖上传者自选），
 *   大小上限 = 令牌 maxShareSize（覆盖全局 share.maxSize）
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { I18nService } from 'nestjs-i18n';
import { NEVER_EXPIRES } from './share.constants';
import { parseRelativeDateToAbsolute } from './share.utils';
import { CreateReverseShareDTO } from './dto/create-reverse-share.dto';

/** include 形状：我的反向分享列表（带已产生的分享） */
const REVERSE_SHARE_INCLUDE = {
  shares: {
    include: { files: true, security: true },
  },
} satisfies Prisma.ReverseShareInclude;

@Injectable()
export class ReverseShareService {
  constructor(
    private prisma: PrismaService,
    private appConfig: AppConfigService,
    private readonly i18n: I18nService,
  ) {}

  /** 创建反向分享令牌，返回 token（链接由前端拼装展示） */
  async create(dto: CreateReverseShareDTO, creatorId: string) {
    // 令牌有效期解析（形态同分享过期）；非管理员受 share.maxExpiration 约束
    const expirationDate =
      dto.shareExpiration === 'never'
        ? NEVER_EXPIRES
        : parseRelativeDateToAbsolute(dto.shareExpiration);
    const user = await this.prisma.user.findUnique({
      where: { id: creatorId },
    });
    if (!user) throw new BadRequestException(this.i18n.t('auth.userNotFound'));
    if (!user.isAdmin) {
      await this.validateMaxExpiration(expirationDate);
    }

    // 自定义 token 查重（唯一约束兜底见下方 P2002 转译）
    if (dto.token) {
      const existing = await this.prisma.reverseShare.findUnique({
        where: { token: dto.token },
      });
      if (existing)
        throw new BadRequestException(this.i18n.t('reverseShare.tokenInUse'));
    }

    try {
      const reverseShare = await this.prisma.reverseShare.create({
        data: {
          token: dto.token || undefined, // 未自定义时 Prisma 生成 uuid 默认值
          shareExpiration: expirationDate,
          maxShareSize: dto.maxShareSize,
          sendEmailNotification: dto.sendEmailNotification,
          remainingUses: dto.maxUseCount,
          simplified: dto.simplified,
          publicAccess: dto.publicAccess,
          creatorId,
        },
      });
      return reverseShare.token;
    } catch (e) {
      // 并发下 token 撞唯一索引 → 统一话术
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException(this.i18n.t('reverseShare.tokenInUse'));
      }
      throw e;
    }
  }

  async isReverseShareTokenAvailable(token: string) {
    const reverseShare = await this.prisma.reverseShare.findUnique({
      where: { token },
    });
    return { isAvailable: !reverseShare };
  }

  /** 公开访问：按 token 取令牌信息（上传页展示"给谁上传/上限/剩余次数"） */
  async getByToken(token: string) {
    const reverseShare = await this.prisma.reverseShare.findUnique({
      where: { token },
      include: { creator: { select: { username: true } } },
    });
    if (!reverseShare)
      throw new NotFoundException(this.i18n.t('reverseShare.notFound'));
    if (!this.isValid(reverseShare))
      throw new NotFoundException(this.i18n.t('reverseShare.notFound'));
    // 对外只暴露非敏感字段（创建者仅用户名）
    return {
      token: reverseShare.token,
      shareExpiration: reverseShare.shareExpiration,
      maxShareSize: reverseShare.maxShareSize,
      remainingUses: reverseShare.remainingUses,
      simplified: reverseShare.simplified,
      publicAccess: reverseShare.publicAccess,
      creator: reverseShare.creator,
    };
  }

  /** 我的反向分享列表：未过期的令牌 + 各自已产生的分享（"反向分享"管理页数据源） */
  async getAllByUser(userId: string) {
    const reverseShares = await this.prisma.reverseShare.findMany({
      where: { creatorId: userId, shareExpiration: { gt: new Date() } },
      orderBy: { shareExpiration: 'desc' },
      include: REVERSE_SHARE_INCLUDE,
    });
    return reverseShares.map((rs) => ({
      id: rs.id,
      token: rs.token,
      shareExpiration: rs.shareExpiration,
      maxShareSize: rs.maxShareSize.toString(),
      remainingUses: rs.remainingUses,
      simplified: rs.simplified,
      publicAccess: rs.publicAccess,
      // 已产生的分享复用分享列表的整形规则（size 求和、security 收敛）
      shares: rs.shares.map((s) => ({
        id: s.id,
        name: s.name,
        size: s.files.reduce((sum, f) => sum + f.size, 0n).toString(),
        views: s.views,
        createdAt: s.createdAt,
        expiration: s.expiration,
        hasPassword: !!s.security?.password,
      })),
    }));
  }

  /**
   * 删除令牌：其下未完成的分享一并失效（expiration 置当前时间 = 门禁立即关闭），
   * 完成的分享保留但解绑（SetNull），磁盘数据不动——删除令牌 ≠ 删除已产生的文件
   */
  async remove(id: string, requesterId: string, isAdmin: boolean) {
    const reverseShare = await this.prisma.reverseShare.findUnique({
      where: { id },
    });
    if (!reverseShare)
      throw new NotFoundException(this.i18n.t('reverseShare.notFound'));
    if (reverseShare.creatorId !== requesterId && !isAdmin) {
      throw new ForbiddenException(this.i18n.t('reverseShare.notFound'));
    }
    await this.prisma.$transaction([
      // 未完成（uploadLocked=false）的分享直接过期作废，避免"令牌没了还能续传"的悬空状态
      this.prisma.share.updateMany({
        where: { reverseShareId: id, uploadLocked: false },
        data: { reverseShareId: null, expiration: new Date() },
      }),
      this.prisma.share.updateMany({
        where: { reverseShareId: id },
        data: { reverseShareId: null },
      }),
      this.prisma.reverseShare.delete({ where: { id } }),
    ]);
  }

  /** 令牌是否可用（未过期且次数未用尽）；CreateShareGuard 据此放行匿名上传 */
  private isValid(reverseShare: {
    shareExpiration: Date;
    remainingUses: number;
  }): boolean {
    const isExpired = new Date() > reverseShare.shareExpiration;
    const usesExhausted = reverseShare.remainingUses <= 0;
    return !(isExpired || usesExhausted);
  }

  /** 非管理员的最大有效期约束（与 ShareService.validateExpiration 同构） */
  private async validateMaxExpiration(expiration: Date) {
    const maxExpiration = await this.appConfig.get('share.maxExpiration');
    const [valueStr, unit] = maxExpiration.split(' ');
    const maxValue = parseInt(valueStr);
    if (maxValue === 0) return;
    const expiresNever = expiration.getTime() === NEVER_EXPIRES.getTime();
    const limit = new Date();
    switch (unit) {
      case 'minutes':
        limit.setMinutes(limit.getMinutes() + maxValue);
        break;
      case 'hours':
        limit.setHours(limit.getHours() + maxValue);
        break;
      case 'days':
        limit.setDate(limit.getDate() + maxValue);
        break;
      case 'weeks':
        limit.setDate(limit.getDate() + maxValue * 7);
        break;
      case 'months':
        limit.setMonth(limit.getMonth() + maxValue);
        break;
      case 'years':
        limit.setFullYear(limit.getFullYear() + maxValue);
        break;
    }
    if (expiresNever || expiration > limit) {
      throw new BadRequestException(this.i18n.t('share.maxExpirationExceeded'));
    }
  }
}
