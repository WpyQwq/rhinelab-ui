// 本地归档服务的浏览器端客户端。
//
// 开发与预览下 Vite 把 /archive-api 代理到 127.0.0.1 的归档服务，并在代理层注入
// 每次启动生成的访问令牌，所以浏览器里不需要也不应该持有令牌。
// 服务不可用时退回静态快照：检索仍可用，写操作与打开文件会明确报错。

export type EntryKind = "f" | "d" | "l";

export interface ArchiveEntry {
  path: string;
  kind: EntryKind;
  size: number;
  mtime: number;
}

export interface ArchiveTotals {
  files: number;
  dirs: number;
  bytes: number;
}

export interface ArchiveIndex {
  generated: string;
  root: string;
  totals: ArchiveTotals;
  entries: ArchiveEntry[];
}

export interface ArchiveStatus {
  root: string;
  watching: boolean;
  lastScan: string | null;
  lastError: string | null;
  totals: ArchiveTotals | null;
  port: number;
  sevenZip: boolean;
}

export type ArchiveOp = "move" | "copy" | "mkdir" | "extract";

export interface ArchivePlan {
  op: ArchiveOp;
  from: string | null;
  to: string;
  bytes: number;
  files: number;
  isDir?: boolean;
  targetExists?: boolean;
  crossVolume?: boolean;
  blocked?: string | null;
  note?: string | null;
}

export interface ArchiveRequest {
  op: ArchiveOp;
  from?: string;
  to?: string;
  folder?: string;
}

const API = "archive-api";

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeout = 8000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      headers,
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message =
        (payload as { error?: string } | null)?.error ??
        `服务返回 ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 服务不可用时返回 null，而不是抛错——面板据此降级到静态快照。 */
export async function fetchStatus(): Promise<ArchiveStatus | null> {
  try {
    return await request<ArchiveStatus>("/status", { method: "GET" }, 2500);
  } catch {
    return null;
  }
}

/**
 * 优先取服务端 gzip 的索引；服务不在时退回 public/archive-index.json。
 * 两种情况返回的条目结构一致。
 */
export async function fetchIndex(): Promise<{
  index: ArchiveIndex;
  viaService: boolean;
}> {
  try {
    const raw = await request<{
      generated: string;
      root: string;
      totals: ArchiveTotals;
      entries: [string, string, number, number][];
    }>("/index", { method: "GET" }, 20000);
    return {
      index: {
        generated: raw.generated,
        root: raw.root,
        totals: raw.totals,
        entries: raw.entries.map(([path, kind, size, mtime]) => ({
          path,
          kind: kind as EntryKind,
          size,
          mtime,
        })),
      },
      viaService: true,
    };
  } catch {
    const response = await fetch("archive-index.json", { cache: "no-cache" });
    if (!response.ok) throw new Error("无法读取归档索引快照");
    const raw = (await response.json()) as {
      generated: string;
      root: string;
      totals: ArchiveTotals;
      entries: [string, string, number, number][];
    };
    return {
      index: {
        generated: raw.generated,
        root: raw.root,
        totals: raw.totals,
        entries: raw.entries.map(([path, kind, size, mtime]) => ({
          path,
          kind: kind as EntryKind,
          size,
          mtime,
        })),
      },
      viaService: false,
    };
  }
}

export function planOperation(body: ArchiveRequest): Promise<ArchivePlan> {
  return request<ArchivePlan>("/plan", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function applyOperation(body: ArchiveRequest): Promise<unknown> {
  return request("/apply", {
    method: "POST",
    body: JSON.stringify({ ...body, confirm: true }),
  });
}

export function openEntry(path: string): Promise<unknown> {
  return request("/open", { method: "POST", body: JSON.stringify({ path }) });
}

export function revealEntry(path: string): Promise<unknown> {
  return request("/reveal", { method: "POST", body: JSON.stringify({ path }) });
}

export function refreshSnapshot(): Promise<{ generated: string }> {
  return request<{ generated: string }>("/refresh", { method: "POST" });
}

export function subscribeRescan(onRescan: (generated: string) => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  let source: EventSource;
  try {
    source = new EventSource(`${API}/events`);
  } catch {
    return () => {};
  }
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as { type?: string; generated?: string };
      if (data.type === "rescan" && data.generated) onRescan(data.generated);
    } catch {
      /* 忽略无法解析的事件 */
    }
  };
  return () => source.close();
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 共享索引缓存 ----------
// 面板与主界面检索弹窗共用同一份索引，避免各拉一次 7.4 MB。
// maxAgeMs 为 0 表示"总是重新取"，用于面板每次打开时确保看到最新归档。

export interface LoadedIndex {
  index: ArchiveIndex;
  viaService: boolean;
  loadedAt: number;
}

let cachedIndex: LoadedIndex | null = null;
const loweredPaths = new WeakMap<ArchiveIndex, string[]>();

export function invalidateArchiveIndex() {
  cachedIndex = null;
}

export async function loadArchiveIndex(
  options: { maxAgeMs?: number } = {},
): Promise<LoadedIndex> {
  const maxAge = options.maxAgeMs ?? 0;
  if (cachedIndex && Date.now() - cachedIndex.loadedAt <= maxAge) {
    return cachedIndex;
  }
  const result = await fetchIndex();
  cachedIndex = { ...result, loadedAt: Date.now() };
  return cachedIndex;
}

function pathsOf(index: ArchiveIndex): string[] {
  let list = loweredPaths.get(index);
  if (!list) {
    list = index.entries.map((entry) => entry.path.toLowerCase());
    loweredPaths.set(index, list);
  }
  return list;
}

/** 在索引中按相对路径的子串匹配，返回前 limit 条与命中总数。 */
export function searchArchive(
  index: ArchiveIndex,
  query: string,
  limit = 200,
): { hits: ArchiveEntry[]; total: number } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { hits: [], total: 0 };
  const lower = pathsOf(index);
  const hits: ArchiveEntry[] = [];
  let total = 0;
  for (let i = 0; i < lower.length; i += 1) {
    if (lower[i].includes(needle)) {
      total += 1;
      if (hits.length < limit) hits.push(index.entries[i]);
    }
  }
  return { hits, total };
}

/** 索引中的顶层目录名，用于归档操作的目标路径快捷选择。 */
export function topLevelNames(index: ArchiveIndex): string[] {
  return index.entries
    .filter((entry) => entry.kind === "d" && !entry.path.includes("/"))
    .map((entry) => entry.path)
    .sort();
}

