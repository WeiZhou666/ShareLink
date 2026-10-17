/**
 * 分享模块通用工具：过期时间解析 / HTTP Range 解析 / Content-Disposition 组装
 * 均为纯函数（无注入依赖），从旧后端 src/utils/ 与 file 层移植并补充注释。
 */
import { BadRequestException } from '@nestjs/common';

/** timespan 结构：与前端 utils/date.util.ts 的 stringToTimespan 输出对齐 */
export interface Timespan {
  value: number;
  unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';
}

/**
 * timespan 字符串 → 结构体（如 "7 days" → {value:7, unit:"days"}）
 * 消费方：config 清单里的 share.maxExpiration / share.defaultExpiration
 */
export function stringToTimespan(value: string): Timespan {
  const [time, unit] = value.split(' ');
  return {
    value: parseInt(time),
    unit: unit as Timespan['unit'],
  };
}

/** timespan 结构体 → 字符串（admin 配置页回显用） */
export function timespanToString(timespan: Timespan): string {
  return `${timespan.value} ${timespan.unit}`;
}

/**
 * 相对过期时间 → 绝对时间点（"3-days" → 3 天后的 Date）
 * 旧后端支持 "never"（永不过期）与 "{num}-{unit}" 两种写法；
 * 本项目前端 CreateUploadModal 实际发送 "{num}{unit}"（如 "3days"，无连字符），
 * 故两种分隔形式都兼容，其余情况视为 ISO 绝对日期字符串。
 */
export function parseRelativeDateToAbsolute(relativeDate: string): Date {
  if (relativeDate === 'never') return new Date(0);

  // 兼容 "3-days" 与 "3days" 两种写法：先按连字符拆，拆不开再按"数字+单位"拆
  const [numPart, unitPart] = relativeDate.includes('-')
    ? [relativeDate.split('-')[0], relativeDate.split('-')[1]]
    : [
        relativeDate.replace(/[a-z]+$/i, ''),
        relativeDate.match(/[a-z]+$/i)?.[0] ?? '',
      ];

  const VALID_UNITS = [
    'seconds',
    'minutes',
    'hours',
    'days',
    'weeks',
    'months',
    'years',
  ];
  if (!numPart || !VALID_UNITS.includes(unitPart)) {
    throw new BadRequestException('invalidExpiration');
  }

  const result = new Date();
  const n = parseInt(numPart);
  switch (unitPart) {
    case 'seconds':
      result.setSeconds(result.getSeconds() + n);
      break;
    case 'minutes':
      result.setMinutes(result.getMinutes() + n);
      break;
    case 'hours':
      result.setHours(result.getHours() + n);
      break;
    case 'days':
      result.setDate(result.getDate() + n);
      break;
    case 'weeks':
      result.setDate(result.getDate() + n * 7);
      break;
    case 'months':
      result.setMonth(result.getMonth() + n);
      break;
    case 'years':
      result.setFullYear(result.getFullYear() + n);
      break;
  }
  return result;
}

/** RFC3339/ISO8601 绝对日期校验（分享创建 API 也接受绝对时间点） */
export function isValidISODate(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}/.test(value);
}

/**
 * 解析 HTTP Range 头（"bytes=start-end"），用于视频/音频拖动播放。
 * 返回 null 表示头缺失或非法（按整文件返回）；rangeStart 越界返回 "unsatisfiable"。
 * 自实现以避免引入 range-parser 依赖——语义只覆盖前端实际用到的单区间场景。
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  totalSize: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || totalSize <= 0) return 'unsatisfiable';
  // "bytes=N-"：从 N 到末尾；"bytes=-N"：最后 N 字节；"bytes=a-b"：闭区间
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    // 后缀区间：取文件末尾 N 字节
    const suffixLength = parseInt(rawEnd);
    if (suffixLength === 0 || suffixLength > totalSize) return 'unsatisfiable';
    start = totalSize - suffixLength;
    end = totalSize - 1;
  } else {
    start = parseInt(rawStart);
    end = rawEnd === '' ? totalSize - 1 : parseInt(rawEnd);
  }
  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start > end ||
    start >= totalSize
  ) {
    return 'unsatisfiable';
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

/**
 * 组装 Content-Disposition 头。
 * - attachment：浏览器下载；inline：浏览器内联预览（文本/PDF/图片）
 * - 文件名含非 ASCII（中文）时用 RFC 5987 的 filename* 编码，否则乱码或被截断
 * 自实现以替代 content-disposition 依赖（只覆盖本项目两种模式）。
 */
export function buildContentDisposition(
  fileName: string,
  mode: 'attachment' | 'inline',
): string {
  // 先把对 HTTP 头有毒的字符去掉（引号、换行、百分号）
  const fallbackName = fileName
    .replace(/[^\x20-\x7e]|["%\\]/g, '_')
    .replace(/"/g, "'");
  const encodedName = encodeURIComponent(fileName)
    // 按 RFC 5987，括号/星号/单引号虽允许出现在 query 里但 header 里必须转义
    .replace(
      /['()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  return mode === 'inline'
    ? `inline; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
    : `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}
