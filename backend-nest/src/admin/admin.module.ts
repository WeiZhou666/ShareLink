import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminNoticeService } from './admin-notice.service';
import { AdminGuard } from './guard/admin.guard';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

/**
 * 管理员后台模块
 *
 * imports AuthModule：复用 AuthService.revokeAllUserTokens（踢下线/禁用/重置密码/删除
 * 都要联动吊销会话）——吊销逻辑只有 auth 一份实现，admin 只做编排，不复制安全代码
 *
 * imports UsersModule：删除用户复用 UsersService.deleteCurrentUser（软删半年冷静期，
 * 与自我注销同语义）——UsersModule 已 exports UsersService
 *
 * PrismaModule 是 @Global（见 app.module），无需显式 import 即可注入 PrismaService；
 * AppConfigService 同理（config 模块 @Global），AdminNoticeService 读 s3.enabled 用
 */
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [AdminController],
  // AdminGuard 同时也是 provider：守卫本质是带依赖注入的类，需要在模块里注册才能被实例化
  providers: [AdminService, AdminNoticeService, AdminGuard],
})
export class AdminModule {}
