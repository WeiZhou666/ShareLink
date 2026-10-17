type Config = {
  key: string;
  defaultValue: string;
  value: string;
  type: string;
};

export type UpdateConfig = {
  key: string;
  value: string;
};

// admin 分类接口返回（backend-nest AppConfigValue）：label 由前端 i18n 按 key 渲染
export type AdminConfig = Config & {
  allowEdit: boolean;
};

export type ConfigHook = {
  configVariables: Config[];
  refresh: () => void;
};

export type CustomPasswordPolicy = {
  minLength: number;
  requireLowercase: boolean;
  requireUppercase: boolean;
  requireNumber: boolean;
  requireSpecialCharacter: boolean;
};

export default Config;
