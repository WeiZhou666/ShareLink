// moment 单例（React 版在 _app 引入全部 locale；SPA 简化为按需默认 locale）
import momentLib from "moment";

export const moment = momentLib;
