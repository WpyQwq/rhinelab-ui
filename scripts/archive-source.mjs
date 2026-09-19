// 依据 archive.config.json 扫描真实归档，生成三份快照：
//   content/archives.json        阵列用的四十条精选档案（简介来自 content/curated.mjs）
//   public/archive-index.json    全量检索索引（供前端检索面板使用）
//   public/archives/*.txt        每条档案的可下载摘要
//
// 只读归档，不修改任何归档文件。服务与 watch 模式都调用这里的 regenerate()。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { curated, categories, columns } from "../content/curated.mjs";
import { validateContent, archiveText } from "./archive-content.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

export async function loadConfig() {
  const raw = await fsp.readFile(path.join(projectRoot, "archive.config.json"), "utf8");
  const config = JSON.parse(raw);
  if (typeof config.root !== "string" || !config.root.trim())
    throw new Error("archive.config.json：root 必须是非空字符串");
  return { ...config, root: path.resolve(config.root) };
}

const formatSize = (bytes) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

const formatDay = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 递归扫描归档，返回条目数组与统计。
// 条目为紧凑数组：[相对路径(/分隔), 'f'|'d', 字节数, mtime 毫秒]
export function scanArchive(root, exclude = []) {
  const skip = new Set(exclude.map((name) => path.resolve(root, name)));
  const entries = [];
  const totals = { files: 0, dirs: 0, bytes: 0 };

  const walk = (absDir, relDir) => {
    let items;
    try {
      items = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const abs = path.join(absDir, item.name);
      const rel = relDir ? `${relDir}/${item.name}` : item.name;
      let stat;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        // 只记录链接本身，不跟随，避免越出归档根目录。
        entries.push([rel, "l", 0, Math.round(stat.mtimeMs)]);
        totals.files += 1;
        continue;
      }
      if (stat.isDirectory()) {
        entries.push([rel, "d", 0, Math.round(stat.mtimeMs)]);
        totals.dirs += 1;
        if (!skip.has(abs)) walk(abs, rel);
      } else {
        entries.push([rel, "f", stat.size, Math.round(stat.mtimeMs)]);
        totals.files += 1;
        totals.bytes += stat.size;
      }
    }
  };

  walk(root, "");
  return { entries, totals };
}

// 取某个归档条目的实时统计，并顺带收集其内部文件的 mtime 范围。
function statEntry(root, relPath) {
  const abs = path.join(root, relPath);
  const result = { exists: false, bytes: 0, files: 0, min: Infinity, max: 0 };
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return result;
  }
  result.exists = true;
  if (stat.isFile()) {
    result.bytes = stat.size;
    result.files = 1;
    result.min = result.max = stat.mtimeMs;
    return result;
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
        result.files += 1;
        result.bytes += s.size;
        if (s.mtimeMs < result.min) result.min = s.mtimeMs;
        if (s.mtimeMs > result.max) result.max = s.mtimeMs;
      }
    }
  };
  walk(abs);
  return result;
}

function fill(text, stats) {
  const range =
    stats.min === Infinity
      ? "无文件"
      : formatDay(stats.min) === formatDay(stats.max)
        ? formatDay(stats.min)
        : `${formatDay(stats.min)} ~ ${formatDay(stats.max)}`;
  return String(text)
    .replaceAll("{size}", formatSize(stats.bytes))
    .replaceAll("{files}", String(stats.files))
    .replaceAll("{date}", range);
}

export async function exportDownloads(records) {
  const downloadDir = path.join(projectRoot, "public", "archives");
  await fsp.mkdir(downloadDir, { recursive: true });
  for (const record of records) {
    await fsp.writeFile(
      path.join(downloadDir, `RHINE-LAB-${record.id}.txt`),
      archiveText(record),
      "utf8",
    );
  }
}

export async function regenerate({ quiet = false } = {}) {
  const config = await loadConfig();
  const log = (message) => {
    if (!quiet) console.log(message);
  };

  const archivesJson = path.join(projectRoot, "content", "archives.json");

  // 归档不在本机时（例如异地构建）沿用既有快照，只重新导出下载文件，
  // 以免 build 因缺少本地归档而整个失败。
  if (!fs.existsSync(config.root)) {
    const existing = JSON.parse(await fsp.readFile(archivesJson, "utf8"));
    validateContent(existing);
    await exportDownloads(existing.records);
    log(
      `归档根目录不可用（${config.root}），沿用既有 ${existing.records.length} 条档案快照。`,
    );
    return {
      records: existing.records,
      totals: null,
      generated: new Date().toISOString(),
      fallback: true,
    };
  }

  // 1) 四十条精选档案：用真实统计填充占位符
  const missing = [];
  const records = curated.map((entry) => {
    const stats = statEntry(config.root, entry.path);
    if (!stats.exists) missing.push(`${entry.id} ${entry.path}`);
    const source = pathToFileURL(path.join(config.root, entry.path)).href;
    return {
      id: entry.id,
      title: entry.title,
      en: entry.en,
      category: entry.category,
      department: entry.department,
      date: entry.date,
      lead: entry.lead,
      clearance: entry.clearance,
      abstract: fill(entry.abstract, stats),
      findings: entry.findings.map((line) => fill(line, stats)),
      source,
      // 供前端与操作面板使用的真实路径信息（校验器允许附加字段）
      path: entry.path,
      stats: {
        bytes: stats.bytes,
        files: stats.files,
        modified: stats.max ? new Date(stats.max).toISOString() : null,
      },
    };
  });

  if (missing.length)
    throw new Error(
      `以下精选条目在归档中不存在，已中止以免写出错误数据：\n- ${missing.join("\n- ")}`,
    );

  const content = { categories, columns, records };
  validateContent(content); // 校验不过就不写盘

  // 2) 全量检索索引
  const { entries, totals } = scanArchive(config.root, config.exclude);

  const payload = {
    generated: new Date().toISOString(),
    root: config.root,
    totals,
    fields: ["path", "kind", "size", "mtime"],
    entries,
  };

  const archivesJsonOut = path.join(projectRoot, "content", "archives.json");
  const indexJson = path.join(projectRoot, config.indexFile ?? "public/archive-index.json");
  await fsp.mkdir(path.dirname(indexJson), { recursive: true });
  await fsp.writeFile(archivesJsonOut, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  await fsp.writeFile(indexJson, JSON.stringify(payload), "utf8");

  // 3) 可下载摘要
  await exportDownloads(records);

  log(
    `归档快照已更新：${records.length} 条精选档案，` +
      `${totals.files} 个文件 / ${totals.dirs} 个目录 / ${formatSize(totals.bytes)}`,
  );
  return { records, totals, generated: payload.generated };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    await regenerate();
  } catch (error) {
    console.error(`生成归档快照失败：${error.message}`);
    process.exitCode = 1;
  }
}
