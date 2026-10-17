import { defineStore } from "pinia";
import type { Config } from "../types/config.type";
import configService from "../api/config.service";
import { getDefaultConfig } from "../utils/defaultConfig.util";

// 对齐 React 版 ConfigContext：全局配置变量 + 按 key 取值
export const useConfigStore = defineStore("config", {
  state: () => ({
    configVariables: [] as Config[],
    isFallback: false,
  }),
  actions: {
    async load() {
      try {
        this.configVariables = await configService.list();
        this.isFallback = false;
      } catch {
        this.configVariables = getDefaultConfig();
        this.isFallback = true;
      }
    },
    get(key: string, returnDefault?: boolean): any {
      // SPA 首帧渲染时配置尚未加载完成，缺失时静默返回 undefined
      //（React 版由 getInitialProps 预载配置规避了此问题，SPA 需容错）
      try {
        return configService.get(key, this.configVariables, returnDefault);
      } catch {
        return undefined;
      }
    },
  },
});
