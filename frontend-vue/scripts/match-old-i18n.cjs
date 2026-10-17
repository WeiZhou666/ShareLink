// 一次性工具：从旧前端 translations 提取 key=value，与前端缺失 key 列表求交集（跑完即删）
const fs = require("fs");

// 前端缺失 key（check-i18n-keys.cjs 的输出）
const missing = [
  "404.message", "404.title", "account.notify.account-activated.title",
  "account.received.empty", "account.received.title", "account.reverseShares.remaining-uses",
  "account.shares.views", "admin.notice.title", "common.button.close", "error.message",
  "navbar.imprint", "navbar.logout", "navbar.privacy",
  "resetPassword.button.submit", "resetPassword.input.email", "resetPassword.notify.reset-success",
  "share.download-all", "share.edit.notify.success", "share.expiration", "share.password.button",
  "share.password.placeholder", "share.password.title", "signup.error.disabled.title",
  "signup.notify.success", "totp.button.submit", "totp.input.totp",
  "upload.error.not-allowed.description", "upload.modal.completed.email",
  "upload.modal.completed.link", "upload.modal.completed.open-link", "upload.modal.completed.qr",
  "upload.modal.completed.title", "upload.modal.description.placeholder",
  "upload.modal.email.button", "upload.modal.email.placeholder", "upload.modal.email.sent",
  "upload.modal.link.copied", "upload.modal.name.placeholder",
];

for (const loc of ["zh-CN", "en-US"]) {
  const s = fs.readFileSync(`../frontend/src/i18n/translations/${loc}.ts`, "utf8");
  const flat = new Map(
    [...s.matchAll(/"([a-zA-Z0-9_.-]+)":\s*(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`)/g)]
      .map((m) => [m[1], m[2] ?? m[3] ?? ""]),
  );
  console.log(`===== ${loc}（旧前端共 ${flat.size} key） =====`);
  for (const k of missing) {
    console.log(flat.has(k) ? `${k} = ${JSON.stringify(flat.get(k))}` : `${k} = 【旧前端无】`);
  }
}
