/**
 * 应用配置变量清单（单一事实来源）
 *
 * 与旧后端（backend/prisma/seed/config.seed.ts 全量落库）的差异：
 * - DB 只存 admin 改过的值（稀疏表），未改的用这里的 defaultValue——清单在代码里一目了然，
 *   加变量不用写 seed/migration
 * - 类型：string/text/boolean/number + filesize（字节数，前端 parseInt 取值）+ timespan
 *   （"7 days" 形式，前端 stringToTimespan 转 {value, unit}）
 * - secret 类敏感值（SMTP 凭证、OAuth secret）不进配置体系，仍走 env——凭证只该有一处来源
 */

export type ConfigType =
  'string' | 'text' | 'boolean' | 'number' | 'filesize' | 'timespan';

export interface ConfigVariable {
  /** 全键名：'{category}.{name}'，点号前缀即分类（前端按分类分区渲染） */
  key: string;
  type: ConfigType;
  defaultValue: string;
  /**
   * public=true 时随 GET /api/configs 下发给前端（未登录可见）——
   * 注册开关、应用名这类渲染依据必须 public；admin 才需要的进 admin 分类接口
   */
  public: boolean;
}

export const CONFIG_VARIABLES: ConfigVariable[] = [
  // ---- general ----
  {
    key: 'general.appName',
    type: 'string',
    defaultValue: 'ShareLink',
    public: true,
  },
  {
    key: 'general.showHomePage',
    type: 'boolean',
    defaultValue: 'true',
    public: true,
  },
  // 未带 cookie 语言时前端默认语言（硬约束：默认简体中文）
  {
    key: 'general.defaultLanguage',
    type: 'string',
    defaultValue: 'zh-CN',
    public: true,
  },
  // 站点对外地址（旧后端同款变量）：前端弹窗用它拼 /s/{id} 分享链接，管理员可改成实际域名
  {
    key: 'general.appUrl',
    type: 'string',
    defaultValue: 'http://localhost:5173',
    public: true,
  },
  // ---- security ----
  {
    key: 'security.allowRegistration',
    type: 'boolean',
    defaultValue: 'true',
    public: true,
  },
  {
    key: 'security.allowUnauthenticatedShares',
    type: 'boolean',
    defaultValue: 'false',
    public: true,
  },
  // 注册后是否需要邮箱验证码激活（旧 env ENABLE_EMAIL_VERIFICATION 迁入配置体系）
  {
    key: 'security.enableEmailVerification',
    type: 'boolean',
    defaultValue: 'false',
    public: true,
  },
  // 管理员越权访问所有分享（含密码/过期分享）；yaml 里已有此键，share 守卫消费
  {
    key: 'security.allowAdminAccessAllShares',
    type: 'boolean',
    defaultValue: 'false',
    public: false,
  },
  // ---- smtp（仅开关；凭证在 env，绝不进配置） ----
  { key: 'smtp.enabled', type: 'boolean', defaultValue: 'false', public: true },
  // ---- oauth（逗号分隔的公开登录方式列表，驱动登录页按钮显隐） ----
  {
    key: 'oauth.openProviders',
    type: 'string',
    defaultValue: 'github',
    public: true,
  },
  // ---- share（分享/上传链路的核心参数；前端上传页直接消费 public 的那几个） ----
  // 单文件分块大小（字节）：前端按此切片，后端 raw body 限额同源取值，两端必须一致
  {
    key: 'share.chunkSize',
    type: 'filesize',
    defaultValue: '10000000',
    public: true,
  },
  // 单次分享总大小上限（字节）
  {
    key: 'share.maxSize',
    type: 'filesize',
    defaultValue: '1000000000',
    public: true,
  },
  // 最长有效期："0 days" = 不限制（后端校验 + 前端弹窗上限提示）
  {
    key: 'share.maxExpiration',
    type: 'timespan',
    defaultValue: '0 days',
    public: true,
  },
  // 创建分享时的默认选中有效期
  {
    key: 'share.defaultExpiration',
    type: 'timespan',
    defaultValue: '7 days',
    public: true,
  },
  // 随机分享 ID 长度（前端 nanoid 生成）
  {
    key: 'share.shareIdLength',
    type: 'number',
    defaultValue: '8',
    public: true,
  },
  // 收件人体系总开关：开启后可给分享指定邮箱收件人、注册用户可见"收到的分享"
  {
    key: 'share.enableUserRecipients',
    type: 'boolean',
    defaultValue: 'false',
    public: true,
  },
  // 以下两个属于"下载通知邮件"链路，对应邮件模板本期未迁移，字段先行保留（admin 可见不可用）
  {
    key: 'share.enableShareEmailRecipients',
    type: 'boolean',
    defaultValue: 'false',
    public: false,
  },
  {
    key: 'share.enableShareDownloadNotifications',
    type: 'boolean',
    defaultValue: 'false',
    public: false,
  },
  // zip 压缩等级 0-9（仅后端用，不随公开配置下发）
  {
    key: 'share.zipCompressionLevel',
    type: 'number',
    defaultValue: '9',
    public: false,
  },
  // ---- antivirus（ClamAV 病毒扫描；连接参数在 env：CLAMAV_HOST/CLAMAV_PORT） ----
  // 上传文件病毒扫描总开关：关闭时 complete 后所有文件直接落 CLEAN（视为通过）；
  // 开启时 complete 后异步扫描（先扫描后打 zip，INFECTED 文件删磁盘保留记录）
  {
    key: 'antivirus.enabled',
    type: 'boolean',
    defaultValue: 'true',
    public: false,
  },
  // ---- legal（页脚法律页） ----
  {
    key: 'legal.enabled',
    type: 'boolean',
    defaultValue: 'false',
    public: true,
  },
  { key: 'legal.imprintText', type: 'text', defaultValue: '', public: true },
  { key: 'legal.imprintUrl', type: 'string', defaultValue: '', public: true },
  {
    key: 'legal.privacyPolicyText',
    type: 'text',
    defaultValue: '',
    public: true,
  },
  {
    key: 'legal.privacyPolicyUrl',
    type: 'string',
    defaultValue: '',
    public: true,
  },
];

/** admin 修改时校验用：允许的分类（config.yaml 同样按分类组织） */
export const CONFIG_CATEGORIES = [
  ...new Set(CONFIG_VARIABLES.map((v) => v.key.split('.')[0])),
];
