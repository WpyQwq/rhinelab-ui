// 一条命令同时拉起本地归档服务与 Vite 开发服务器。
// 服务先起（生成令牌与快照），随后 Vite 通过 /archive-api 代理访问它。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokenFile = path.join(projectRoot, ".archive-token");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// 令牌是每次启动新生成的，先删掉旧值，避免 Vite 代理到已经退出的旧服务。
fs.rmSync(tokenFile, { force: true });

const children = [];
const shutdown = (code = 0) => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const service = spawn(process.execPath, ["scripts/archive-service.mjs"], {
  cwd: projectRoot,
  stdio: "inherit",
});
children.push(service);
service.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.error(`归档服务已退出（代码 ${code}），同时停止开发服务器。`);
    shutdown(code);
  }
});

// 等令牌文件出现，确保 Vite 启动时代理已能取到凭据。
const deadline = Date.now() + 30_000;
while (!fs.existsSync(tokenFile)) {
  if (Date.now() > deadline) {
    console.error("等待归档服务启动超时。");
    shutdown(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

console.log("归档服务就绪，启动 Vite 开发服务器……");
const vite = spawn(npm, ["run", "dev", "--", ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
children.push(vite);
vite.on("exit", (code) => shutdown(code ?? 0));
