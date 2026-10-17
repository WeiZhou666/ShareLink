// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,// 识别node全局变量: process, __dirname
        ...globals.jest,// 识别jest全局变量: it, expect, describe
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',// 允许使用 any 类型
      '@typescript-eslint/no-floating-promises': 'warn',// 警告未处理的 Promise
      '@typescript-eslint/no-unsafe-argument': 'warn',// 警告不安全的参数
      'prettier/prettier': 'error',// Prettier格式不满足时，ESLint直接报error（阻断lint）
    },
  },
);
