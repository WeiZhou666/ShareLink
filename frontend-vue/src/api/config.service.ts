import type { AdminConfig, Config, UpdateConfig } from "../types/config.type";
import api from "./client";
import { stringToTimespan } from "../utils/date.util";

// 与 backend-nest CONFIG_CATEGORIES 对齐（config.yaml 同构）；appearance/ldap/s3 等分类随对应模块迁移追加
const categories = ["general", "security", "smtp", "oauth", "share", "legal"];

const list = async (): Promise<Config[]> => {
  return (await api.get("/configs")).data;
};

const getByCategory = async (categoryInput: string): Promise<AdminConfig[]> => {
  let category: string;
  if (categories.indexOf(categoryInput.trim()) === -1) {
    category = "general";
  } else {
    category = categoryInput.trim();
  }

  return (await api.get(`/configs/admin/${category}`)).data;
};

const updateMany = async (data: UpdateConfig[]): Promise<AdminConfig[]> => {
  // 后端契约（UpdateConfigDto）：{ updates: { 'key': 'value', ... } }——裸数组会被 @IsObject 拒绝
  const updates = Object.fromEntries(data.map((c) => [c.key, c.value]));
  return (await api.patch("/configs/admin", { updates })).data;
};

const get = (
  key: string,
  configVariables: Config[],
  returnDefault: boolean = false,
): any => {
  if (!configVariables) return null;

  const configVariable = configVariables.filter(
    (variable) => variable.key == key,
  )[0];

  if (!configVariable) throw new Error(`Config variable ${key} not found`);

  const value = returnDefault
    ? configVariable.defaultValue
    : (configVariable.value ?? configVariable.defaultValue);

  if (configVariable.type == "number" || configVariable.type == "filesize")
    return parseInt(value);
  if (configVariable.type == "boolean") return value == "true";
  if (configVariable.type == "string" || configVariable.type == "text")
    return value;
  if (configVariable.type == "timespan") return stringToTimespan(value);
};

const sendTestEmail = async (email: string) => {
  await api.post("/configs/admin/testEmail", { email });
};

const testRedisConnection = async () => {
  return (await api.post("/configs/admin/testRedis")).data as {
    ok: boolean;
    enabled: boolean;
  };
};

// 旧后端的 finishSetup/logo/logoDark/新版本检测端点 backend-nest 未迁移，已删——页面无引用

export default {
  categories,
  list,
  getByCategory,
  updateMany,
  get,
  sendTestEmail,
  testRedisConnection,
};
