import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AuthModule } from '../auth/auth.module';
import { ShareModule } from '../share/share.module';

/**
 * 用户资料模块：
 * - PATCH /users/me（修改用户名/邮箱）+ PATCH /users/password（修改密码，从 auth 模块迁入）
 * - DELETE /users/me（注销账号）：依赖 AuthModule（吊销会话 + 清 Cookie）与
 *   ShareModule（FileService 清理名下分享的磁盘文件），两者均已 exports 对应服务
 */
@Module({
  imports: [AuthModule, ShareModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService], // jobs.deleteSoftDeletedUsers 复用 physicallyDeleteUser（冷静期到期物理清除）
})
export class UsersModule {}
