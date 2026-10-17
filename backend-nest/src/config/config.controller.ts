import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsObject } from 'class-validator';
import { AppConfigService } from './config.service';
import { AdminGuard } from '../admin/guard/admin.guard';
import { EmailService } from '../email/email.service';
import { RedisService } from '../redis/redis.service';

class UpdateConfigDto {
  /** { 'general.appName': '新名字', ... }——service 层做整批校验（未知 key/类型不符/yaml 管辖都整批拒绝） */
  @IsObject()
  updates!: Record<string, string>;
}

class TestEmailDto {
  @IsEmail()
  email!: string;
}

/**
 * 应用配置端点（路径与前端 config.service.ts 现有调用对齐，前端零改动）：
 *   GET  /api/configs              公开配置（未登录可见，全局 store 消费）
 *   GET  /api/configs/admin/:category   按分类读全部变量（表单回填）
 *   PATCH /api/configs/admin       批量修改
 *   POST /api/configs/admin/testEmail / testRedis  连通性自检
 */
@ApiTags('应用配置')
@Controller('configs')
export class AppConfigController {
  constructor(
    private readonly AppConfigService: AppConfigService,
    private readonly emailService: EmailService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @ApiOperation({ summary: '公开配置：前端全局 store 消费' })
  listPublic() {
    return this.AppConfigService.listPublic();
  }

  @Get('admin/:category')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '按分类读取全部配置变量（管理员）' })
  listByCategory(@Param('category') category: string) {
    return this.AppConfigService.listByCategory(category);
  }

  @Patch('admin')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '批量修改配置（yaml 管辖项会被拒绝）' })
  updateMany(@Body() dto: UpdateConfigDto) {
    return this.AppConfigService.updateMany(dto.updates);
  }

  @Post('admin/testEmail')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: '向指定邮箱发测试邮件（走 EmailService 同一投递链路）',
  })
  async testEmail(@Body() dto: TestEmailDto) {
    await this.emailService.sendTestEmail(dto.email);
    return { ok: true };
  }

  @Post('admin/testRedis')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Redis 连通性自检（ping）' })
  async testRedis() {
    const pong = await this.redis.ping();
    return { ok: pong, enabled: pong };
  }
}
