import Config from "../types/config.type";

// 后端不可达时的最小配置兜底，保证页面能渲染出壳（与 React 版语义一致）。
export function getDefaultConfig(): Config[] {
  return [
    {
      key: "general.appName",
      value: "ShareLink",
      defaultValue: "ShareLink",
      type: "string",
    },
    {
      key: "general.showHomePage",
      value: "true",
      defaultValue: "true",
      type: "boolean",
    },
    {
      key: "general.defaultLanguage",
      value: "en-US",
      defaultValue: "en-US",
      type: "string",
    },
    {
      key: "security.allowRegistration",
      value: "false",
      defaultValue: "false",
      type: "boolean",
    },
    {
      key: "security.allowUnauthenticatedShares",
      value: "false",
      defaultValue: "false",
      type: "boolean",
    },
    {
      key: "smtp.enabled",
      value: "false",
      defaultValue: "false",
      type: "boolean",
    },
    {
      key: "oauth.openProviders",
      value: "github",
      defaultValue: "github",
      type: "string",
    },
    {
      key: "legal.enabled",
      value: "false",
      defaultValue: "false",
      type: "boolean",
    },
    { key: "legal.imprintText", value: "", defaultValue: "", type: "text" },
    { key: "legal.imprintUrl", value: "", defaultValue: "", type: "string" },
    {
      key: "legal.privacyPolicyText",
      value: "",
      defaultValue: "",
      type: "text",
    },
    {
      key: "legal.privacyPolicyUrl",
      value: "",
      defaultValue: "",
      type: "string",
    },
  ];
}
