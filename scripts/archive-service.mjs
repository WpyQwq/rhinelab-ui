// 本地归档服务：只监听 127.0.0.1，用每次启动生成的令牌限制网页访问。
//
// 职责：
//   1. 监视归档根目录，变动后自动重新生成快照（对应"有新文件自动更新"）
//   2. 提供检索索引（gzip）
//   3. 提供读操作：打开文件、在资源管理器中定位
//   4. 提供安全写操作：新建分类目录、移动、复制、解压；一律先 plan 预览再 apply
//      —— 不提供删除与重命名
//
// 所有写操作都校验解析后的绝对路径必须落在归档根目录内，并追加到操作日志。

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, regenerate } from "./archive-source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const SEVEN_ZIP = "C:\\Program Files\\7-Zip\\7z.exe";

const config = await loadConfig();
const PORT = config.port ?? 43117;
const TOKEN = crypto.randomBytes(24).toString("hex");
const TOKEN_FILE = path.join(projectRoot, ".archive-token");
await fsp.writeFile(TOKEN_FILE, TOKEN, "utf8");

const state = {
  watching: false,
  lastScan: null,
  lastError: null,
  pendingRescan: null,
};

// ---------- 归档根目录围栏 ----------
// 客户端一律传相对路径（/ 分隔）。解析后必须仍在根目录内，且真实路径也不得越界。
function resolveInside(relPath) {
  if (typeof relPath !== "string" || relPath.includes("\0"))
    throw httpError(400, "路径不合法");
  const cleaned = relPath.replace(/^[/\\]+/, "").replace(/\//g, path.sep);
  if (!cleaned) throw httpError(400, "路径为空");
  const abs = path.resolve(config.root, cleaned);
  const rel = path.relative(config.root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
    throw httpError(403, "只允许访问归档目录内的路径");
  return abs;
}

function realInside(abs) {
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return abs; // 还不存在（例如待新建目录）；上一级已校验
  }
  const rel = path.relative(fs.realpathSync(config.root), real);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw httpError(403, "解析后的真实路径越出归档目录");
  return real;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// ---------- 统计与日志 ----------
function statsOf(abs) {
  const out = { exists: false, isDir: false, bytes: 0, files: 0 };
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return out;
  }
  out.exists = true;
  out.isDir = stat.isDirectory();
  if (!out.isDir) {
    out.bytes = stat.size;
    out.files = 1;
    return out;
  }
  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const child = path.join(dir, item.name);
      let s;
      try {
        s = fs.lstatSync(child);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(child);
      else if (s.isFile()) {
        out.files += 1;
        out.bytes += s.size;
      }
    }
  };
  walk(abs);
  return out;
}

async function writeLog(entry) {
  const logRel = config.logFile ?? "00_索引\\操作日志.jsonl";
  const logAbs = path.join(config.root, logRel);
  await fsp.mkdir(path.dirname(logAbs), { recursive: true });
  await fsp.appendFile(
    logAbs,
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    "utf8",
  );
}

const sameVolume = (a, b) =>
  path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase();

// ---------- 操作计划（读操作也能生成计划） ----------
function buildPlan({ op, from, to, folder }) {
  switch (op) {
    case "mkdir": {
      const abs = resolveInside(folder);
      const exists = fs.existsSync(abs);
      return {
        op,
        from: null,
        to: path.relative(config.root, abs).replace(/\\/g, "/"),
        targetExists: exists,
        blocked: exists ? "目标目录已存在" : null,
        note: exists ? null : "将新建一个分类目录",
        bytes: 0,
        files: 0,
      };
    }
    case "move":
    case "copy": {
      const srcAbs = realInside(resolveInside(from));
      const dstAbs = resolveInside(to);
      const src = statsOf(srcAbs);
      if (!src.exists) return { op, from, to, blocked: "源不存在", bytes: 0, files: 0 };
      const targetExists = fs.existsSync(dstAbs);
      const crossVolume = !sameVolume(srcAbs, dstAbs);
      const blocked =
        op === "move" && crossVolume
          ? "跨盘移动不被允许（请改用复制）"
          : targetExists
            ? "目标已存在，请换一个名字"
            : null;
      return {
        op,
        from: path.relative(config.root, srcAbs).replace(/\\/g, "/"),
        to: path.relative(config.root, dstAbs).replace(/\\/g, "/"),
        bytes: src.bytes,
        files: src.files,
        isDir: src.isDir,
        targetExists,
        crossVolume,
        blocked,
        note: src.isDir
          ? `目录，含 ${src.files} 个文件`
          : `文件，${src.bytes} 字节`,
      };
    }
    case "extract": {
      const srcAbs = realInside(resolveInside(from));
      if (!fs.existsSync(srcAbs)) return { op, from, to, blocked: "压缩包不存在", bytes: 0, files: 0 };
      const dstAbs = resolveInside(to);
      const dst = statsOf(dstAbs);
      const targetExists = dst.exists && dst.files > 0;
      return {
        op,
        from: path.relative(config.root, srcAbs).replace(/\\/g, "/"),
        to: path.relative(config.root, dstAbs).replace(/\\/g, "/"),
        bytes: fs.statSync(srcAbs).size,
        files: 0,
        targetExists,
        blocked: targetExists ? "目标目录已存在且非空" : null,
        note: `解压到 ${path.relative(config.root, dstAbs).replace(/\\/g, "/") || "."}`,
      };
    }
    default:
      throw httpError(400, `不支持的操作：${op}`);
  }
}

async function applyPlan({ op, from, to, folder }) {
  const plan = buildPlan({ op, from, to, folder });
  if (plan.blocked) throw httpError(409, plan.blocked);

  if (op === "mkdir") {
    const abs = resolveInside(folder);
    await fsp.mkdir(abs, { recursive: true });
  } else if (op === "move") {
    const abs = resolveInside(to);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.rename(resolveInside(from), abs);
  } else if (op === "copy") {
    const abs = resolveInside(to);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.cp(resolveInside(from), abs, { recursive: true, errorOnExist: true });
  } else if (op === "extract") {
    if (!fs.existsSync(SEVEN_ZIP)) throw httpError(500, `找不到 7-Zip：${SEVEN_ZIP}`);
    const abs = resolveInside(to);
    await fsp.mkdir(abs, { recursive: true });
    const code = await new Promise((resolve) => {
      const child = spawn(
        SEVEN_ZIP,
        ["x", resolveInside(from), `-o${abs}`, "-y", "-bso0", "-bsp0"],
        { stdio: "ignore", windowsHide: true },
      );
      child.on("close", resolve);
      child.on("error", () => resolve(-1));
    });
    if (code !== 0) throw httpError(500, `7-Zip 解压失败（退出码 ${code}）`);
  }

  await writeLog({ op, from: plan.from, to: plan.to, result: "ok" });
  scheduleRescan();
  return plan;
}

// ---------- 读操作：交给系统 ----------
function reveal(abs) {
  spawn("explorer.exe", [`/select,${abs}`], { stdio: "ignore", windowsHide: false }).unref();
}
function openWith(abs) {
  spawn("cmd.exe", ["/c", "start", "", abs], { stdio: "ignore", windowsHide: true }).unref();
}

// ---------- 快照刷新与自动更新 ----------
let timer = null;
function scheduleRescan(delay = 2500) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const result = await regenerate({ quiet: true });
      state.lastScan = result.generated;
      state.lastError = null;
      broadcast({ type: "rescan", generated: result.generated, totals: result.totals });
    } catch (error) {
      state.lastError = error.message;
    }
  }, delay);
}

const clients = new Set();
function broadcast(message) {
  const line = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

function startWatcher() {
  try {
    fs.watch(config.root, { recursive: true }, (_event, filename) => {
      if (filename && String(filename).includes("操作日志.jsonl")) return;
      scheduleRescan();
    });
    state.watching = true;
  } catch (error) {
    state.watching = false;
    state.lastError = `无法监视归档目录：${error.message}`;
  }
}

// ---------- HTTP ----------
const indexAbs = path.join(projectRoot, config.indexFile ?? "public/archive-index.json");
let indexCache = { mtime: 0, gzip: null, raw: null };

function readIndex() {
  const mtime = fs.existsSync(indexAbs) ? fs.statSync(indexAbs).mtimeMs : 0;
  if (indexCache.mtime !== mtime) {
    const raw = mtime ? fs.readFileSync(indexAbs) : Buffer.from("{}");
    indexCache = { mtime, raw, gzip: zlib.gzipSync(raw) };
  }
  return indexCache;
}

function searchIndex(query, limit) {
  const { raw } = readIndex();
  const payload = JSON.parse(raw.toString("utf8"));
  const needle = query.trim().toLowerCase();
  if (!needle) return { total: payload.entries.length, hits: [] };
  const hits = [];
  for (const entry of payload.entries) {
    if (entry[0].toLowerCase().includes(needle)) {
      hits.push(entry);
      if (hits.length >= limit) break;
    }
  }
  return { total: hits.length, hits };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw httpError(413, "请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "请求体不是合法 JSON");
  }
}

const send = (res, status, body, headers = {}) => {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": isBuffer ? "application/octet-stream" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const route = url.pathname;

  // 事件流不需要令牌以外的额外处理，但同样要求令牌
  if (req.headers["x-archive-token"] !== TOKEN) {
    return send(res, 401, { error: "访问令牌无效" });
  }

  if (route === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  try {
    if (route === "/status" && req.method === "GET") {
      const { raw } = readIndex();
      const payload = JSON.parse(raw.toString("utf8"));
      return send(res, 200, {
        root: config.root,
        watching: state.watching,
        lastScan: state.lastScan ?? payload.generated ?? null,
        lastError: state.lastError,
        totals: payload.totals ?? null,
        port: PORT,
        sevenZip: fs.existsSync(SEVEN_ZIP),
      });
    }

    if (route === "/index" && req.method === "GET") {
      const { raw, gzip } = readIndex();
      if (String(req.headers["accept-encoding"] ?? "").includes("gzip"))
        return send(res, 200, gzip, {
          "content-type": "application/json; charset=utf-8",
          "content-encoding": "gzip",
        });
      return send(res, 200, raw, { "content-type": "application/json; charset=utf-8" });
    }

    if (route === "/search" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 2000);
      return send(res, 200, searchIndex(q, limit));
    }

    if (route === "/plan" && req.method === "POST") {
      const body = await readBody(req);
      return send(res, 200, buildPlan(body));
    }

    if (route === "/apply" && req.method === "POST") {
      const body = await readBody(req);
      if (body.confirm !== true) throw httpError(400, "写操作需要 confirm: true");
      const plan = await applyPlan(body);
      return send(res, 200, { ok: true, plan });
    }

    if (route === "/reveal" && req.method === "POST") {
      const body = await readBody(req);
      const abs = realInside(resolveInside(body.path));
      if (!fs.existsSync(abs)) throw httpError(404, "路径不存在");
      reveal(abs);
      return send(res, 200, { ok: true, action: "reveal", path: body.path });
    }

    if (route === "/open" && req.method === "POST") {
      const body = await readBody(req);
      const abs = realInside(resolveInside(body.path));
      if (!fs.existsSync(abs)) throw httpError(404, "路径不存在");
      openWith(abs);
      return send(res, 200, { ok: true, action: "open", path: body.path });
    }

    if (route === "/refresh" && req.method === "POST") {
      const result = await regenerate({ quiet: true });
      state.lastScan = result.generated;
      state.lastError = null;
      broadcast({ type: "rescan", generated: result.generated, totals: result.totals });
      return send(res, 200, { ok: true, generated: result.generated, totals: result.totals });
    }

    return send(res, 404, { error: `未知接口：${route}` });
  } catch (error) {
    return send(res, error.status ?? 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`归档服务已启动：http://127.0.0.1:${PORT}`);
  console.log(`归档根目录：${config.root}`);
  console.log(`访问令牌：已写入 ${path.relative(projectRoot, TOKEN_FILE)}`);
  try {
    const result = await regenerate({ quiet: true });
    state.lastScan = result.generated;
    console.log(
      `快照就绪：${result.records.length} 条精选档案，` +
        `${result.totals.files} 个文件 / ${result.totals.dirs} 个目录`,
    );
  } catch (error) {
    state.lastError = error.message;
    console.error(`首次生成快照失败：${error.message}`);
  }
  startWatcher();
  console.log(state.watching ? "已开始监视归档变动（自动更新快照）" : "监视未启用");
});
