import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guard/jwt-auth.guard';

/**
 * 管理员守卫：管理员后台所有接口的权限门槛
 *
 * 设计要点：**继承 JwtAuthGuard 而不是另写一套校验**
 * 1. super.canActivate() 先完整走一遍 JWT 校验链（验签 → 两级黑名单 → 查库缓存 req.currentUser）
 *    —— 认证（你是谁）复用既有实现，不重复不漂移
 * 2. 本守卫只追加一步授权（authorization）：req.currentUser.isAdmin !== true → 403
 *    —— 认证（authentication）与授权（authorization）分层，这是 RBAC 最小实现
 *
 * 用法：@UseGuards(AdminGuard) 替代 @UseGuards(JwtAuthGuard)
 */
@Injectable()
export class AdminGuard extends JwtAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ① 先执行父类（JwtAuthGuard）的完整认证链：
    //    验签 + Redis 两级黑名单（strategy）→ 查库 + 缓存 req.currentUser（guard）
    //    token 无效时父类内部已抛 401，走不到下面
    await super.canActivate(context);

    // ② 授权检查：只有 isAdmin=true 的用户能访问管理接口
    //    req.currentUser 由父类保证一定存在（查库成功才会放行），这里只判断角色
    const request = context.switchToHttp().getRequest();
    if (!request.currentUser?.isAdmin) {
      throw new ForbiddenException(this.i18n.t('admin.adminRequired'));
    }
    return true;
  }
}
