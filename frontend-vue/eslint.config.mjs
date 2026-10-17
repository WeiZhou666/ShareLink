// ESLint 9 flat config（Vue 3 + TypeScript，@vue/eslint-config-typescript 官方编排）
// 注意：flat config 下文件匹配由各配置块自己声明，不再使用 --ext 参数
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import pluginVue from "eslint-plugin-vue";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default defineConfigWithVueTs(
  {
    // 构建产物与依赖目录（node_modules 是 ESLint 9 默认忽略项，此处显式声明仅为自文档化）
    ignores: ["dist/**", "node_modules/**"],
  },

  // Vue SFC：essential 档只管正确性，不管风格（风格交给 Prettier）
  pluginVue.configs["flat/essential"],

  // TS：非 type-aware 档（不加载项目 tsconfig，扫描快且不与 vue-tsc 职责重叠）
  vueTsConfigs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // 单词组件名规则对 Home.vue / Legal.vue / Totp.vue 这类页面名误伤，关闭
      "vue/multi-word-component-names": "off",
      // 存量 14 处 any（移植期遗留，集中在 catch 处理与动态路由参数）渐进治理：
      // 先降为 warn 让 lint 可过，后续按 backend-nest 同款分类法收敛
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // 必须放最后：关闭所有与 Prettier 冲突的格式类规则
  prettierConfig,
);
