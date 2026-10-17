export default [
  {
    ignores: [
      "backend-nest/**",
      "frontend-vue/**",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
    },
  },
];
