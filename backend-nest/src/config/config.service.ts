import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { parse as yamlParse } from 'yaml';
import * as fs from 'node:fs';
import { Logger } from 'winston';
import { PrismaService } from '../prisma/prisma.service';
import {
  CONFIG_CATEGORIES,
  CONFIG_VARIABLES,
  ConfigType,
} from './config.constants';

export interface AppConfigValue {
  key: string;
  value: string;
  defaultValue: string;
  type: ConfigType;
  /** false = 被 config.yaml 管辖，admin 界面只读 */
  allowEdit: boolean;
}

/**
 * 应用配置服务：三层取值，优先级 config.yaml > DB > 代码内默认值
 *
 * 与旧后端（backend/src/config/config.service.ts）的差异：
 * - 不用 EventEmitter：旧版靠 'update' 事件做热更新，当前消费方（注册开关、前端渲染开关）
 *   每次读值即可，yaml 修改本就需要重启才生效（启动时加载一次），事件机制是过度设计
 * - 不做全量 seed 落库：DB 只存 admin 改过的值（稀疏表），清单常驻代码
 * - config.yaml 覆盖过的 key，admin 界面改会明确拒绝（editNotAllowed）——
 *   否则会出现"界面显示改成功、重启后被打回"的假象，这是旧版踩过的坑
 */
@Injectable()
export class AppConfigService implements OnModuleInit {
  /** config.yaml 覆盖层：启动时加载一次，进程生命周期内只读 */
  private readonly yamlOverrides = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async onModuleInit() {
    await this.loadYamlOverrides();
  }

  /** 读 config.yaml（CONFIG_FILE env 可指定，默认项目根），按 '{category}.{name}' 匹配清单内变量 */
  private async loadYamlOverrides() {
    const filePath = process.env.CONFIG_FILE || '../config.yaml';
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // 没有配置文件是常态，静默走 DB/默认值
    }
    try {
      const yaml = yamlParse(raw) as Record<
        string,
        Record<string, unknown>
      > | null;
      if (!yaml) return;
      for (const variable of CONFIG_VARIABLES) {
        const [category, name] = variable.key.split('.');
        const value = yaml[category]?.[name];
        // 只认清单里存在的变量（yaml 里的未知键忽略），String() 统一转字符串存取
        if (value !== undefined && value !== null)
          this.yamlOverrides.set(variable.key, String(value));
      }
      if (this.yamlOverrides.size > 0) {
        this.logger.info(
          `config.yaml 已加载，覆盖 ${this.yamlOverrides.size} 个配置项：${filePath}`,
          { context: AppConfigService.name },
        );
      }
    } catch (e) {
      // yaml 坏了不能让应用起不来：记 ERROR 后降级为 DB/默认值
      this.logger.error(
        `config.yaml 解析失败，回退到数据库配置：${(e as Error).message}`,
        { context: AppConfigService.name },
      );
    }
  }

  /** 单值读取（字符串）。yaml > DB > 默认值 */
  async get(key: string): Promise<string> {
    const variable = CONFIG_VARIABLES.find((v) => v.key === key);
    if (!variable) throw new NotFoundException(`未知的配置项：${key}`);
    if (this.yamlOverrides.has(key)) return this.yamlOverrides.get(key)!;
    const row = await this.prisma.config.findUnique({ where: { key } });
    return row?.value ?? variable.defaultValue;
  }

  async getBoolean(key: string): Promise<boolean> {
    return (await this.get(key)) === 'true';
  }

  async getNumber(key: string): Promise<number> {
    return parseInt(await this.get(key), 10);
  }

  /** 公开配置：GET /api/configs，前端全局 store 消费（与前端 Config[] 结构对齐） */
  async listPublic(): Promise<AppConfigValue[]> {
    return this.listByKeys(
      CONFIG_VARIABLES.filter((v) => v.public).map((v) => v.key),
    );
  }

  /** admin 分类读取：该分类全部变量（含未改的，前端表单直接回填） */
  async listByCategory(category: string): Promise<AppConfigValue[]> {
    if (!CONFIG_CATEGORIES.includes(category)) {
      throw new NotFoundException(`未知的配置分类：${category}`);
    }
    return this.listByKeys(
      CONFIG_VARIABLES.filter((v) => v.key.startsWith(`${category}.`)).map(
        (v) => v.key,
      ),
    );
  }

  private async listByKeys(keys: string[]): Promise<AppConfigValue[]> {
    const rows = await this.prisma.config.findMany({
      where: { key: { in: keys } },
    });
    const dbValues = new Map(rows.map((r) => [r.key, r.value]));
    return keys.map((key) => {
      const variable = CONFIG_VARIABLES.find((v) => v.key === key)!;
      return {
        key,
        // 顺序即优先级：yaml 覆盖 > DB 稀疏值 > 代码默认值
        value:
          this.yamlOverrides.get(key) ??
          dbValues.get(key) ??
          variable.defaultValue,
        defaultValue: variable.defaultValue,
        type: variable.type,
        // yaml 管辖的变量部署时锁死，admin 界面只读（PATCH 侧 updateMany 有同款 400 拦截，这里管 UI 显隐）
        allowEdit: !this.yamlOverrides.has(key),
      };
    });
  }

  /**
   * admin 批量修改：yaml 覆盖的拒绝、未知 key 拒绝，其余 upsert 进稀疏表
   * 全部成功才提交语义由调用方保证（controller 层先整体校验再写入）
   */
  async updateMany(updates: Record<string, string>): Promise<AppConfigValue[]> {
    // 先整体校验：任何一个 key 非法都整批拒绝（避免半成功状态）
    for (const [key, value] of Object.entries(updates)) {
      const variable = CONFIG_VARIABLES.find((v) => v.key === key);
      if (!variable) throw new NotFoundException(`未知的配置项：${key}`);
      if (this.yamlOverrides.has(key)) {
        throw new BadRequestException(
          `配置项 ${key} 由 config.yaml 管理，只能通过配置文件修改`,
        );
      }
      if (
        variable.type === 'boolean' &&
        value !== 'true' &&
        value !== 'false'
      ) {
        throw new BadRequestException(
          `配置项 ${key} 的值必须是 "true" 或 "false"`,
        );
      }
      if (variable.type === 'number' && Number.isNaN(Number(value))) {
        throw new BadRequestException(`配置项 ${key} 的值必须是数字`);
      }
      // filesize：字节数，等价于 number 校验（前端按 parseInt 消费）
      if (variable.type === 'filesize' && Number.isNaN(Number(value))) {
        throw new BadRequestException(`配置项 ${key} 的值必须是数字（字节数）`);
      }
      // timespan："<数值> <单位>" 形式（如 "7 days"、"0 hours"），单位白名单与前端 stringToTimespan 对齐；
      // 特例 "never" = 永不过期（前端 form 会选中「永不」选项，后端 parseExpiration 语义一致）
      if (
        variable.type === 'timespan' &&
        !/^\d+ (minutes|hours|days|weeks|months|years)$|^never$/.test(value)
      ) {
        throw new BadRequestException(
          `配置项 ${key} 的值必须是 "<数值> <单位>" 形式，如 "7 days"`,
        );
      }
    }
    await this.prisma.$transaction(
      Object.entries(updates).map(([key, value]) =>
        this.prisma.config.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        }),
      ),
    );
    return this.listByKeys(Object.keys(updates));
  }
}
