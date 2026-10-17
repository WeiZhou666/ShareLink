# ESLint / TypeScript / Prettier：三层代码守护体系

> 面向面试讲解的完整梳理。结构：前置知识 → 演进逻辑 → 三工具分工与原理 → 本项目实现 → 常用命令 → 面试速答。

---

## 一、前置知识：为什么 JS 生态需要「三层守护」

### 1.1 动态类型语言的痛点

JavaScript 是**动态弱类型**语言，大量错误无法在编码期发现，只能等运行时爆炸：

```js
// 拼写错误：cods 未定义，运行时才 ReferenceError
const code = cods.length;

// == 的隐式转换陷阱：都是 true
0 == "";      // true
"1" == 1;     // true
null == undefined; // true
```

TypeScript 解决了**类型层**的问题，但类型正确 ≠ 代码正确：

```ts
// 类型完全合法，逻辑却是坑：
if (user.isAdmin = true) { ... }   // 赋值当判断
const data = await fetch();         // 忘了 .json()
// eslint-disable-next-line 滥用、未使用的 import、悬空的 Promise……
```

### 1.2 守护体系的三层分工

| 层 | 工具 | 管什么 | 典型例子 |
|---|---|---|---|
| **类型层** | `tsc`（TypeScript 编译器） | 类型是否匹配 | `string` 传给 `number` 参数 |
| **质量层** | ESLint | 代码是否「写得好」 | 未用变量、`==` 混用、悬空 Promise |
| **格式层** | Prettier | 代码是否「长得齐」 | 缩进、单双引号、换行、尾逗号 |

三者的关键区别：

- **tsc** 看的是「数据形状」，错了编译不过（CI 阻断）
- **ESLint** 看的是「写法习惯」，大部分是 error/warn 提示，**部分可自动修复**
- **Prettier** 只动**排版**，绝不改变代码逻辑（AST 等价输出），全部可自动修复

### 1.3 术语对齐

- **Linter**：静态检查工具，读代码找问题，不执行代码
- **静态分析**：不运行程序、只分析源码的技术统称
- **AST（Abstract Syntax Tree，抽象语法树）**：源码的树状结构化表示，`const a = 1` 会变成 `VariableDeclaration → VariableDeclarator → Identifier + Literal` 这样的节点树。三个工具的底层全是 AST
- **规则（Rule）**：一条独立的检查逻辑，如 `no-unused-vars`（禁止未使用变量）
- **自动修复（autofix）**：规则附带「怎么改」的信息，工具能直接改写源码

---

## 二、演进逻辑：从 JSLint 到 ESLint 统一江湖

```
2010          2011          2013                    2019 → 至今
JSLint  ──分叉──►  JSHint  ──►  ESLint              ESLint v9 (flat config)
规则写死       可配置        规则皆插件            eslint.config.mjs
（Crockford）  （社区）     （Nicholas Zakas）     成为止事实标准
```

1. **JSLint**（2010 前后）：最早的 JS 检查器，作者 Crockford 把自己的编程观点全部写死成规则，「不接受配置」——用不用随你。
2. **JSHint**（2011）：从 JSLint 分叉，核心改进是**可配置**，一度成为主流。
3. **ESLint**（2013）：Nicholas Zakas 的革命性设计——**每条规则是独立的可插拔函数**，基于 AST 编程，任何人都能为团队/框架写专属规则。开放架构让它后来居上：React 的 `eslint-plugin-react-hooks`、Vue 的 `eslint-plugin-vue`、TypeScript 的 `@typescript-eslint` 都建立在它之上。
4. **Prettier**（2017）：不再「报告问题」，而是「直接把代码重排成唯一正确格式」——终结了团队里「缩进 2 格还是 4 格」的圣战。
5. **flat config**（ESLint v9，2024 起默认）：配置从分散的 `.eslintrc.json` + 层级合并，改为单一 `eslint.config.mjs` 数组显式组合，可预测、可调试。

---

## 三、核心原理：AST 是一切的底座

三个工具的处理流水线同构：**源码 → 解析成 AST → 遍历节点 → 匹配规则 → 报告/修复**。

```ts
// 源代码
const x = foo(1);

// 大致对应的 AST（简化）
{
  type: "VariableDeclaration",
  kind: "const",
  declarations: [{
    id: { type: "Identifier", name: "x" },
    init: {
      type: "CallExpression",        // ← no-unused-vars 规则看到 x 从未被读 → 报告
      callee: { name: "foo" },
      arguments: [{ value: 1 }]
    }
  }]
}
```

一条 ESLint 规则的本质：**一个对象，声明「我关注哪类 AST 节点」+「遇到了怎么办」**：

```js
// 规则骨架（示意）
export default {
  meta: { fixable: "code" },          // 声明可自动修复
  create(context) {
    return {
      BinaryExpression(node) {        // 关注所有二元表达式
        if (node.operator === "==") {
          context.report({
            node,
            message: "Use === instead of ==",
            fix: (fixer) => fixer.replaceTextRange(node.range, "..."), // 自动修复逻辑
          });
        }
      },
    };
  },
};
```

**Prettier 的不同**：它不用「规则集」，而是把代码解析成 AST 后**重新打印**（print）成自己唯一的格式——所以它永远不改变语义，只改变外观。

**TypeScript 的不同**：tsc 的类型检查需要跨文件收集类型信息（类型不是局部信息），所以 `@typescript-eslint` 的**类型感知规则**（如 `no-floating-promises`）需要访问 tsconfig 的类型系统，配置上要额外声明 `projectService: true`（见第五节，这也是 lint 慢的根源）。

---

## 四、三者如何协作（与冲突解决）

### 4.1 标准协作模式

```
编辑器保存
   │
   ├─ ESLint 检查质量问题 ──► --fix 自动修复（含委托给 Prettier 的格式问题）
   ├─ Prettier 格式化排版
   └─ tsc 在后台做类型检查（IDE 红线 + vite/tsc 构建兜底）
```

### 4.2 冲突与桥接

ESLint 早期自带一批**格式类规则**（indent、quotes），与 Prettier 天然打架。解法两种：

1. **`eslint-config-prettier`**：关掉 ESLint 里所有与 Prettier 重复的格式规则，ESLint 与 Prettier 各跑各的（前端主流方案）。
2. **`eslint-plugin-prettier`**（本项目后端采用）：把 Prettier 作为**一条 ESLint 规则**跑，格式不一致直接以 ESLint `error` 报出，`--fix` 时调用 Prettier 修复。一个命令全搞定，代价是 lint 变慢。

---

## 五、本项目实现

### 5.1 全局配置（根目录 `eslint.config.mjs`）

只管根目录散落的 js/mjs 脚本文件，两个子项目被显式排除（各自有自己的工具链）：

```js
export default [
  {
    ignores: [
      "backend-nest/**",   // 子项目内部有自己的 eslint 配置
      "frontend-vue/**",
      "docs/**",
      "scripts/**",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
    },
  },
];
```

### 5.2 后端（`backend-nest/eslint.config.mjs`）——最完整的示例

NestJS 11 脚手架生成的 flat config，四层组合：

```js
export default tseslint.config(
  { ignores: ['eslint.config.mjs'] },
  eslint.configs.recommended,                 // ① JS 通用规则
  ...tseslint.configs.recommendedTypeChecked, // ② TS 类型感知规则（最强档）
  eslintPluginPrettierRecommended,            // ③ Prettier 桥接（格式问题=ESLint error）
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,                 // ④ 关键：让规则访问 tsconfig 类型系统
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',         // 项目允许 any
      '@typescript-eslint/no-floating-promises': 'warn',   // 悬空 Promise（忘 await）
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }], // Win/Mac 行尾不互踩
    },
  },
);
```

**三个值得面试展开的点**：

1. **`recommendedTypeChecked` + `projectService: true`**：类型感知规则（如 `no-floating-promises`，抓「调了 async 函数没 await」）需要完整类型信息，`projectService` 让 ESLint 直接复用 tsconfig 增量编译缓存，而不是全量重编译——这是配置里最容易被忽略、错了就「规则不生效」的一处。
2. **`prettier/prettier: endOfLine: 'auto'`**：Windows 是 CRLF、macOS/Linux 是 LF，团队协作时 Prettier 会强制统一成一种造成大量假 diff；`auto` 表示跟随当前文件现有行尾，跨平台团队的标准解法。
3. **规则分级的取舍**：`no-floating-promises` 只给 `warn`（后端大量 `fire-and-forget` 场景，全 error 误伤）；`no-explicit-any` 直接关（Prisma JSON 字段等场景类型体操成本过高）——**规则强度要匹配业务现实，不是越严越好**。

### 5.3 后端格式配置（`backend-nest/.prettierrc`）

```json
{
  "singleQuote": true,
  "trailingComma": "all"
}
```

只声明与 Prettier 默认值不同的两项：单引号（与 TS 社区惯例一致）、 everywhere 尾逗号（git diff 最小化）。

### 5.4 前端（frontend-vue）

当前未配置 ESLint（Vue 脚手架的 lint 未启用），质量守护依赖 `vue-tsc` 类型检查 + 构建验证。若要补齐，标准组合是 `eslint-plugin-vue`（抓 `v-for` 缺 `:key`、`v-html` 风险等 Vue 专属陷阱）+ `eslint-config-prettier` 桥接格式。

---

## 六、常用命令速查

```bash
# ESLint
npx eslint .                     # 检查整个项目
npx eslint src/**/*.ts --fix     # 检查并自动修复
npx eslint src --format stylish  # 默认 human 可读输出

# Prettier
npx prettier --write .           # 格式化全部（会改文件）
npx prettier --check .           # 只检查不改（CI 用）
npx prettier --write src/app.module.ts

# TypeScript
npx tsc --noEmit                 # 只做类型检查不产出 js（CI 标配）
```

编辑器集成（真正的日常）：装 ESLint + Prettier 插件，配置保存自动修复：

```jsonc
// .vscode/settings.json
{
  "editor.codeActionsOnSave": { "source.fixAll.eslint": "explicit" },
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true
}
```

---

## 七、面试速答

**Q: ESLint 是什么？原理？**
> JS/TS 静态分析工具。把源码解析成 AST，逐节点执行规则集，报告错误并支持 autofix。规则皆插件（每条规则是独立的 AST 访问器函数），v9 起用 flat config（`eslint.config.mjs`）显式组合。

**Q: ESLint、TSLint、tsc、Prettier 什么关系？**
> TSLint 已废弃（2019 并入 `@typescript-eslint`）。tsc 管类型错误（编译期阻断）；ESLint 管代码质量与陷阱（风格+正确性提示，可修复）；Prettier 管排版（重打印 AST，不改语义，全可修复）。三者互补，重叠部分用 `eslint-config-prettier` 或 `eslint-plugin-prettier` 消解。

**Q: 为什么 `@typescript-eslint` 有「类型感知规则」更慢？**
> 这些规则（如 `no-floating-promises`）需要跨文件的完整类型信息，ESLint 必须加载 tsconfig 的类型系统做分析；`projectService: true` 可复用增量编译缓存缓解，但本质仍比纯语法规则重。

**Q: flat config 和旧 .eslintrc 的区别？**
> 旧配置是分散的 `.eslintrc.{json,js}` + 父子目录层级合并（隐式规则，难调试）；flat config 是单一 `eslint.config.mjs`，导出数组、按序组合、作用域显式（`files`/`ignores`），可预测可编程。

**Q: 团队里怎么落地这些工具？**
> 配置进仓库（`.prettierrc` / `eslint.config.mjs`）+ 编辑器保存即修复 + git pre-commit 钩子（husky + lint-staged 只查暂存文件）+ CI 跑 `eslint` 与 `prettier --check` 与 `tsc --noEmit` 三道闸。规则强度匹配业务现实（如本项目 `no-floating-promises` 用 warn 而非 error）。
