import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { I18nService } from 'nestjs-i18n';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import * as argon from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { FileService } from '../share/file.service';
import { UpdateCurrentUserDto } from './dto/update-current-user.dto';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private i18n: I18nService, // 面向用户的响应消息走 i18n
    private authService: AuthService, // 注销账号：吊销该用户全部会话
    private fileService: FileService, // 注销账号：清理名下分享的磁盘文件
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** 修改当前用户资料（用户名/邮箱）：稀疏更新（只更新提供的字段），唯一冲突 → 409 */
  async updateCurrentUser(userId: string, dto: UpdateCurrentUserDto) {
    const data: { username?: string; email?: string } = {};
    if (dto.username != null) data.username = dto.username.trim();
    if (dto.email != null) data.email = dto.email.trim().toLowerCase(); // 邮箱统一小写落库，与 signIn 的小写查询匹配
    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data,
      });
      // 剔除敏感字段 + hasPassword（与 auth.service.stripPassword 同构）
      const {
        password: _password,
        activationToken: _activationToken,
        activationTokenExpiresAt: _activationTokenExpiresAt,
        resetPasswordToken: _resetPasswordToken,
        resetPasswordTokenExpiresAt: _resetPasswordTokenExpiresAt,
        ...safe
      } = user;
      return { ...safe, hasPassword: user.password !== null };
    } catch (e) {
      // 唯一约束冲突：邮箱或用户名已被占用
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(this.i18n.t('auth.userAlreadyExists'));
      }
      throw e;
    }
  }

  /**
   * 修改当前用户密码：已设密码者必须验旧密码；OAuth 创建的无密码用户可直接设置
   * 不吊销现有会话（与旧后端一致）——改密后当前登录态保持，避免自己把自己踢下线
   */
  async updatePassword(
    userId: string,
    oldPassword: string | undefined,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.password) {
      if (!oldPassword || !(await argon.verify(user.password, oldPassword))) {
        throw new UnauthorizedException(this.i18n.t('auth.wrongCredentials'));
      }
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: await argon.hash(newPassword) },
    });
    this.logger.info(`密码修改成功：${user?.email}`, {
      context: UsersService.name,
    });
  }

  /**
   * 注销账号（DELETE /users/me）：软删除 —— 进入半年冷静期（182 天），期间可自助恢复，到期由 jobs 物理清除
   *
   * 执行顺序：
   * 1. 查用户 —— 不存在直接 400；已处于注销态重复请求同样 400（幂等保护）
   * 2. 最后管理员保护 —— 管理员只有自己时禁止注销（软删期间系统失去管理入口同样不可接受）
   * 3. 事务：名下分享置为立即过期 + 软删标记
   *    - 分享置过期：所有访问链路（令牌签发/文件下载/zip）的过期检查自动 404，
   *      无需侵入任何查询；磁盘保留（jobs.deleteExpiredShares 排除软删创建者的分享）
   *    - username/email 原值保留不动：行还在 + unique 索引还在 = 冷静期内名字被占用，
   *      新用户注册同名被 P2002 → 400 userAlreadyExists 自然拦截（占名防冒充：
   *      防止注销后他人注册同邮箱收到原用户邮件）；物理删行后名字自动释放
   *    - 作废重置码/激活码：注销态下不允许用历史凭证改密或激活
   * 4. 吊销全部会话 —— 删 RefreshToken 行 + 写 Redis 吊销键（旧 access JWT 立即失效）
   * 5. 到期物理清除：jobs.deleteSoftDeletedUsers 对 deletedAt 超半年（182 天）的用户调 physicallyDeleteUser
   */
  async deleteCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException(this.i18n.t('auth.userNotFound'));
    }
    if (user.deletedAt) {
      throw new BadRequestException(this.i18n.t('auth.accountAlreadyDeleted'));
    }

    // 最后管理员保护：与 admin.service.deleteUser 同规则（不能让系统失去唯一管理员）
    if (user.isAdmin) {
      const adminCount = await this.prisma.user.count({
        where: { isAdmin: true },
      });
      if (adminCount <= 1) {
        throw new BadRequestException(
          this.i18n.t('admin.cannotDeleteLastAdmin'),
        );
      }
    }

    await this.prisma.$transaction([
      // 名下分享全部置为立即过期（含「永不」分享——注销了就该全停；磁盘由 jobs 排除规则保护）
      this.prisma.share.updateMany({
        where: { creatorId: userId },
        data: { expiration: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          deletedAt: new Date(),
          resetPasswordToken: null,
          resetPasswordTokenExpiresAt: null,
          activationToken: null,
          activationTokenExpiresAt: null,
        },
      }),
    ]);

    // 立即踢出：先置软删再吊销，防止吊销与置标记之间的窗口内旧 token 打到"注销态用户"
    await this.authService.revokeAllUserTokens(userId);

    this.logger.warn(
      `用户注销账号（软删除，半年冷静期）：${user.email}（${userId}），名下分享已全部置为过期`,
      {
        context: UsersService.name,
      },
    );
  }

  /**
   * 物理删除用户（冷静期到期由 jobs.deleteSoftDeletedUsers 调用；管理员彻底删除亦可复用）：
   * 清磁盘 → 吊销会话 → 删行。顺序即安全：
   * - 先清磁盘：Share.creator onDelete: SetNull，先删人会让文件变无主（没有任务认领）
   * - 先吊销再删行：避免"行已删但 Redis 吊销键没写"窗口内旧 token 还能打接口
   * 用户不存在时静默返回（jobs 幂等语义：物理删执行前用户可能已被管理员手动删掉）
   */
  async physicallyDeleteUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { shares: { select: { id: true } } }, // 只要分享 id，用于逐个清理磁盘
    });
    if (!user) return;

    await Promise.all(
      user.shares.map((share) => this.fileService.deleteAllFiles(share.id)),
    );
    await this.authService.revokeAllUserTokens(userId);
    await this.prisma.user.delete({ where: { id: userId } });

    this.logger.warn(
      `物理删除用户：${user.email}（${userId}），名下 ${user.shares.length} 个分享的磁盘文件已清理`,
      {
        context: UsersService.name,
      },
    );
  }
}
