import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { I18nService } from 'nestjs-i18n';
import { Logger } from 'winston';
import * as argon from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';
import {
  AdminResetPasswordDto,
  AdminUpdateUserDto,
  AdminUserQueryDto,
} from './dto/admin-user.dto';
import { AdminShareQueryDto } from './dto/admin-share.dto';

/**
 * 管理员后台服务：用户管理的全部业务逻辑
 *
 * 与旧后端（backend/src/user/user.service.ts）的差异：
 * - 列表加了分页 + 搜索（旧版 list() 全量返回，用户一多就是全表查询）
 * - 删除/禁用联动吊销会话（旧版删了用户，已签发的 access_token 15 分钟内仍有效）
 * - 不做管理员邀请创建（依赖邮件服务，注册统一走 signUp）
 */
@Injectable()
export class AdminService {
  /** winston 日志：nest-winston 提供的 provider，用法同 console 但分级可控 */
  @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger;

  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private usersService: UsersService, // 删除用户：复用自我注销的软删逻辑（半年冷静期）
    private i18n: I18nService, // 面向用户的 HTTP 消息走翻译 key，运维日志保持中文
  ) {}

  /**
   * 用户列表：分页 + 模糊搜索
   *
   * 两个教学点：
   * 1. findMany + count 并行（Promise.all）——列表页固定两次查询，并行省一半等待
   * 2. keyword 动态构造 where：Prisma 的 OR 条件里混入 undefined 字段会生成空过滤对象 {},
   *    空 OR 在部分 Prisma 版本会匹配全表（安全坑），所以只在 keyword 真的存在时才展开 OR
   */
  async listUsers(dto: AdminUserQueryDto) {
    // where 条件：搜索词去空格；没有关键词时不带 OR（避免空过滤对象匹配全表的坑）
    const keyword = dto.keyword?.trim();
    const where: Prisma.UserWhereInput = keyword
      ? {
          OR: [
            { username: { contains: keyword } },
            { email: { contains: keyword } },
          ],
        }
      : {};

    // skip = 跳过前几条；take = 取几条。page 从 1 开始，所以是 (page-1)*pageSize
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        // select 白名单：显式排除 password 等敏感字段，
        // 比查出实体再删字段安全（将来加敏感字段也不会误泄漏）
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          username: true,
          email: true,
          isAdmin: true,
          isActivated: true,
        },
        orderBy: { createdAt: 'desc' }, // 新注册的排前面，符合管理后台直觉
        skip: (dto.page - 1) * dto.pageSize,
        take: dto.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      list: users,
      total, // 总条数：前端据此算总页数
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  /**
   * 更新用户：设/撤管理员、启用/禁用
   *
   * 三条保护规则（都是管理后台常见的"自锁"事故）：
   * 1. 不能修改自己的 isAdmin —— 防止把自己降权后失去管理入口
   * 2. 禁用账号时联动吊销该用户全部会话 —— isActivated 只拦 signIn，
   *    已签发的 access_token（最长 15 分钟）不吊销就还能继续用，这是纵深防御
   * 3. 字段白名单由 DTO 保证，这里只处理业务规则
   */
  async updateUser(
    operatorId: string,
    targetUserId: string,
    dto: AdminUpdateUserDto,
  ) {
    // 目标用户必须存在，否则 Prisma update 会抛 P2025 友好度差，先查一次给出 404
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(this.i18n.t('admin.userNotFound'));
    }

    // 保护规则①：不能改自己的管理员身份（"不能改自己"只限 isAdmin，改 isActivated 无妨）
    if (
      targetUserId === operatorId &&
      dto.isAdmin !== undefined &&
      dto.isAdmin !== target.isAdmin
    ) {
      throw new BadRequestException(
        this.i18n.t('admin.cannotChangeOwnAdminRole'),
      );
    }

    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        isAdmin: dto.isAdmin,
        isActivated: dto.isActivated,
      },
      // Prisma 语义：data 里值为 undefined 的字段会被忽略（只更新提供的字段）
      select: {
        id: true,
        username: true,
        email: true,
        isAdmin: true,
        isActivated: true,
      },
    });

    // 保护规则②：禁用时把该用户所有 refresh 会话删掉 + 写用户级吊销键 auth:revoke:{userId}
    // 效果：该用户所有端立即下线（access 15 分钟寿命内也被 key 拦截，TTL 与 token 同步）
    if (dto.isActivated === false) {
      await this.authService.revokeAllUserTokens(targetUserId);
      this.logger.warn(`管理员禁用用户并吊销全部会话：${target.email}`, {
        context: AdminService.name,
      });
    }

    this.logger.info(
      `管理员更新用户：${target.email}（isAdmin=${user.isAdmin}, isActivated=${user.isActivated}）`,
      { context: AdminService.name },
    );
    return user;
  }

  /**
   * 管理员重置密码
   *
   * 流程：argon2id 哈希入库 → 吊销该用户全部会话（改密踢下线）
   * 为什么重置后必须踢下线：密码重置通常发生在"账号疑似被盗"场景，
   * 如果盗号者手里的旧 token 还能用，重置就形同虚设
   */
  async resetPassword(
    operatorEmail: string,
    targetUserId: string,
    dto: AdminResetPasswordDto,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(this.i18n.t('admin.userNotFound'));
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { password: await argon.hash(dto.newPassword) },
    });
    await this.authService.revokeAllUserTokens(targetUserId);

    this.logger.warn(
      `管理员 ${operatorEmail} 重置了用户 ${target.email} 的密码并吊销其全部会话`,
      { context: AdminService.name },
    );
  }

  /**
   * 踢下线：不改动用户任何数据，只吊销全部会话
   * 底层复用 auth.service.revokeAllUserTokens：
   * - 删 RefreshToken 表该用户全部会话（refresh 立即失效，无法续期）
   * - 写 Redis 用户级吊销键 auth:revoke:{userId}（access 立即失效，TTL 15 分钟自动过期）
   */
  async revokeSessions(operatorEmail: string, targetUserId: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(this.i18n.t('admin.userNotFound'));
    }
    await this.authService.revokeAllUserTokens(targetUserId);
    this.logger.warn(`管理员 ${operatorEmail} 踢下线用户 ${target.email}`, {
      context: AdminService.name,
    });
  }

  /**
   * 删除用户（管理端）：软删除——与自我注销（DELETE /users/me）完全同语义
   *
   * 复用 UsersService.deleteCurrentUser，其内部已包含：
   * - 目标不存在 → 404（auth.userNotFound）
   * - 已处于注销态重复删除 → 400 accountAlreadyDeleted（幂等保护）
   * - 最后管理员保护 → 400 cannotDeleteLastAdmin（与管理端同规则，天然对齐）
   * - 事务：名下分享全部置为立即过期 + deletedAt 软删标记（username/email 原值保留占名防冒充）
   * - 吊销全部会话（先置软删再吊销，堵住窗口）
   * 冷静期内可由用户自助恢复（POST /auth/recoverAccount）；到期由 jobs 任务 7 物理清除
   */
  async deleteUser(operatorId: string, targetUserId: string) {
    // 保护规则：不能删除自己（operatorId 来自 req.currentUser，非客户端传参，不可伪造）——
    // 管理端删自己语义上等于自我注销，引导走 DELETE /users/me 的正规入口
    if (operatorId === targetUserId) {
      throw new BadRequestException(this.i18n.t('admin.cannotDeleteSelf'));
    }

    await this.usersService.deleteCurrentUser(targetUserId);

    this.logger.warn(
      `管理员删除用户（软删除，半年冷静期）：${targetUserId}，操作者：${operatorId}`,
      {
        context: AdminService.name,
      },
    );
  }

  /**
   * 分享列表（管理端）：分页 + 模糊搜索（分享 id / 名称 / 创建者用户名或邮箱）
   *
   * 两个实现取舍：
   * - 每条分享的大小：include files 在内存求和——每页 ≤100 条且含文件数有限，规模可控；
   *   不为它单独写 groupBy + join 的复杂聚合
   * - 磁盘占用：File 表全量 _sum 聚合，一次查询
   */
  async listShares(dto: AdminShareQueryDto) {
    const keyword = dto.keyword?.trim();
    const where: Prisma.ShareWhereInput = keyword
      ? {
          OR: [
            { id: { contains: keyword } },
            { name: { contains: keyword } },
            {
              creator: {
                OR: [
                  { username: { contains: keyword } },
                  { email: { contains: keyword } },
                ],
              },
            },
          ],
        }
      : {};

    const [shares, total, diskUsageAgg] = await Promise.all([
      this.prisma.share.findMany({
        where,
        include: {
          files: { select: { size: true } },
          creator: { select: { id: true, username: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (dto.page - 1) * dto.pageSize,
        take: dto.pageSize,
      }),
      this.prisma.share.count({ where }),
      this.prisma.file.aggregate({ _sum: { size: true } }),
    ]);

    return {
      list: shares.map((share) => ({
        id: share.id,
        name: share.name,
        description: share.description,
        views: share.views,
        expiration: share.expiration,
        createdAt: share.createdAt,
        fileCount: share.files.length,
        // BigInt 不能直接 JSON 序列化（TypeError: Do not know how to serialize），统一转 string
        size: share.files.reduce((sum, f) => sum + f.size, 0n).toString(),
        creator: share.creator,
      })),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
      diskUsage: (diskUsageAgg._sum.size ?? 0n).toString(),
    };
  }

  /**
   * 删除分享：DB 行级联清理 files（schema onDelete: Cascade）
   * 物理文件（磁盘/对象存储）清理随 share 模块迁移接入——当前上传链路尚未迁移，无孤儿文件风险
   */
  async removeShare(operatorEmail: string, shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share) {
      throw new NotFoundException(this.i18n.t('admin.shareNotFound'));
    }
    await this.prisma.share.delete({ where: { id: shareId } });
    this.logger.warn(`管理员 ${operatorEmail} 删除分享 ${shareId}`, {
      context: AdminService.name,
    });
  }
}
