import { ElMessage } from "element-plus";
import { getApiErrorMessage } from "./error.util";
import { t } from "../i18n";

/**
 * React 版 toast.util 基于 @mantine/notifications，需要在 Provider 树内调用。
 * Vue 版使用 Element Plus 的 ElMessage，可在任意位置（包括服务层）直接调用。
 * 暗色模式跟随 html.dark 上的 Element Plus CSS 变量。
 */

const error = (content: string) =>
  ElMessage({ message: content, type: "error", duration: 5000, showClose: true });

const axiosError = (axiosError: any) =>
  error(
    `${t("common.error")}: ${getApiErrorMessage(axiosError) ?? t("common.error.unknown")}`,
  );

const success = (content: string) =>
  ElMessage({ message: content, type: "success", duration: 5000, showClose: true });

const info = (content: string) => ElMessage({ message: content, type: "info" });

const warning = (content: string) =>
  ElMessage({ message: content, type: "warning", duration: 5000, showClose: true });

const toast = {
  error,
  success,
  axiosError,
  info,
  warning,
};
export default toast;
