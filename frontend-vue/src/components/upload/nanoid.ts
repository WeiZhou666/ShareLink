// 分享 ID 生成器（与 nanoid 官方 url-alphabet 逐字符一致，64 位）
// ⚠️ 曾漏掉 '-' 和 '_' 只剩 62 字符，而 & 63 产生 0-63 的索引 →
// 62/63 越界取到 undefined 被拼进 ID（线上出现过 "ciPßundefinedp" 这类脏 ID）
const ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

export const nanoid = (size = 8): string => {
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  while (size--) {
    id += ALPHABET[bytes[size] & 63];
  }
  return id;
};
