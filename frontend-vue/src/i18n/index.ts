import { computed } from "vue";
import { LOCALES, type Locale } from "./locales";
import { getCookie, setCookie } from "../utils/cookies";

/**
 * 轻量 i18n 运行时（替代 react-intl）。
 *
 * 设计约束：33 个语言包是扁平的 Record<string, string>（来自 Crowdin 导出），
 * 其中含 react-intl 的 ICU 语法。vue-i18n 的消息编译器无法直接消化 ICU 复数
 * 和 `@`/`|` 保留字，因此这里自实现一个最小运行时，语言包文件零改动复用：
 *  1. 扁平 key 查找，缺失时回退 en-US，再回退 key 本身；
 *  2. {name} 命名插值；
 *  3. ICU 复数的最小解析：{count, plural, =1 {...} other {...}}，
 *     仅按 =n 精确匹配与 other 兜底（覆盖项目现有全部用法）。
 */

const pluralPattern =
  /\{(\w+),\s*plural,\s*((?:=[\w!]+\s*\{[^{}]*\}\s*)+)other\s*\{([^{}]*)\}\}/;

const formatIcuPlural = (
  message: string,
  values: Record<string, unknown> | undefined,
): string => {
  let result = message;
  let match: RegExpExecArray | null;
  // 处理消息中出现的每一处 ICU 复数段
  while ((match = pluralPattern.exec(result)) !== null) {
    const [full, varName, exacts, other] = match;
    const count = Number(values?.[varName] ?? 0);
    const exact = new RegExp(`=([\\w!]+)\\s*\\{([^{}]*)\\}`, "g");
    let replacement = other;
    let exactMatch: RegExpExecArray | null;
    while ((exactMatch = exact.exec(exacts)) !== null) {
      if (Number(exactMatch[1].replace("!", "")) === count) {
        replacement = exactMatch[2];
        break;
      }
    }
    replacement = replacement.replace(/#/g, String(count));
    result = result.replace(full, replacement);
  }
  return result;
};

const interpolate = (
  message: string,
  values: Record<string, unknown> | undefined,
): string => {
  const withPlural = formatIcuPlural(message, values);
  if (!values) return withPlural;
  return withPlural.replace(/\{(\w+)\}/g, (full, name: string) => {
    return values[name] !== undefined ? String(values[name]) : full;
  });
};

const getLocaleByCode = (code: string): Locale => {
  return Object.values(LOCALES).find((l) => l.code === code) ?? LOCALES.ENGLISH;
};

const isLanguageSupported = (code: string) => {
  return Object.values(LOCALES).some((l) => l.code === code);
};

const setLanguageCookie = (code: string) => {
  setCookie("language", code, {
    sameSite: "lax",
    expires: new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
  });
};

const getBrowserLanguage = (): string => {
  if (typeof navigator === "undefined") return "zh-CN";
  const preferred = navigator.language;
  if (isLanguageSupported(preferred)) return preferred;
  const base = preferred.split("-")[0];
  const similar = Object.values(LOCALES).find((l) =>
    l.code.startsWith(base),
  );
  return similar?.code ?? "zh-CN";
};

const currentLocaleCode = (): string => {
  const cookie = getCookie("language");
  return cookie ?? getBrowserLanguage();
};

export const t = (
  id: string,
  values?: Record<string, unknown>,
): string => {
  const locale = getLocaleByCode(currentLocaleCode());
  const message = locale.messages[id] ?? LOCALES.ENGLISH.messages[id] ?? id;
  return interpolate(message, values);
};

export { getLocaleByCode, currentLocaleCode, setLanguageCookie };

// 组合式 API：组件内直接解构使用
export const useI18n = () => {
  return {
    t,
    locale: computed(currentLocaleCode),
    setLocale: (code: string) => {
      setLanguageCookie(code);
      window.location.reload();
    },
  };
};

export default {
  t,
  useI18n,
  getLocaleByCode,
  isLanguageSupported,
  setLanguageCookie,
  getBrowserLanguage,
  currentLocaleCode,
};
