/**
 * mime-types 的浏览器端轻量替代。
 * 原包 lookup() 依赖 Node 的 path.extname，Vite 下会抛
 * "Cannot access path.extname in client code"，故内置常用扩展名映射。
 * 仅用于分享页的预览能力判断（video/image/audio/text/pdf）。
 */
const MIME_MAP: Record<string, string> = {
  // image
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  avif: "image/avif", tiff: "image/tiff", heic: "image/heic",
  // video
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  avi: "video/x-msvideo", mkv: "video/x-matroska", m4v: "video/x-m4v",
  // audio
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
  m4a: "audio/mp4", aac: "audio/aac", wma: "audio/x-ms-wma",
  // text
  txt: "text/plain", md: "text/markdown", csv: "text/csv", log: "text/plain",
  json: "application/json", xml: "application/xml", yml: "text/yaml",
  yaml: "text/yaml", html: "text/html", htm: "text/html", css: "text/css",
  js: "text/javascript", ts: "text/plain", tsx: "text/plain", jsx: "text/plain",
  py: "text/x-python", sh: "text/x-sh", ini: "text/plain", conf: "text/plain",
  // document
  pdf: "application/pdf",
};

export const lookupMimeType = (fileName: string): string => {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "";
};
