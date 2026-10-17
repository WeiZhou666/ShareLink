import type { Timespan } from "../types/timespan.type";

export const timespanToString = (timespan: Timespan) => {
  return `${timespan.value} ${timespan.unit}`;
};

export const stringToTimespan = (value: string): Timespan => {
  // "never"（无空格单 token）= 永不过期：unit 用 "never"，value 给 1 占位——
  // CreateUploadModal 的单位下拉本就有 never 选项，form 初始化会自然选中「永不」；
  // value 用 1 保证用户切回具体单位时数字框有合理初值
  if (value.trim() === "never") {
    return { value: 1, unit: "never" } as Timespan;
  }
  return {
    value: parseInt(value.split(" ")[0]),
    unit: value.split(" ")[1],
  } as Timespan;
};
