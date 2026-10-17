// 一次性工具：扫描 src 中全部 t("key") 调用，对比两份翻译文件，列出缺失 key（跑完即删）
const fs = require("fs");
const path = require("path");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(vue|ts)$/.test(p) ? [p] : [];
  });
}

const used = new Set();
for (const f of walk("src")) {
  if (f.includes("i18n")) continue;
  const s = fs.readFileSync(f, "utf8");
  for (const m of s.matchAll(/\bt\((['"])([a-zA-Z0-9_.-]+)\1/g)) used.add(m[2]);
}

for (const loc of ["zh-CN", "en-US"]) {
  const s = fs.readFileSync(`src/i18n/translations/${loc}.ts`, "utf8");
  const have = new Set([...s.matchAll(/"([a-zA-Z0-9_.-]+)":/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !have.has(k)).sort();
  console.log(`== ${loc} 缺失 ${missing.length} 个 ==`);
  missing.forEach((k) => console.log(k));
}
