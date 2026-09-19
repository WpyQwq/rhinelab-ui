// 本地归档面板：对 E:\归档 做全量检索，并直接执行归档写操作。
//
// 与主界面的四十条精选档案分开：精选档案走 content/archives.json 与三维阵列，
// 这里走 public/archive-index.json（服务在线时为 gzip 版本），互不干扰。
//
// 写操作一律"先预览、后执行"，并且只有本地归档服务在运行时才可用；
// 服务不在时面板明确降级为只读检索。

import "./archive-panel.css";
import { escapeHtml } from "./html";
import {
  applyOperation,
  fetchStatus,
  formatBytes,
  formatTime,
  invalidateArchiveIndex,
  loadArchiveIndex,
  openEntry,
  planOperation,
  refreshSnapshot,
  revealEntry,
  searchArchive,
  subscribeRescan,
  topLevelNames,
  type ArchiveEntry,
  type ArchiveIndex,
  type ArchiveOp,
  type ArchivePlan,
  type ArchiveRequest,
  type ArchiveStatus,
} from "./archive-service";

const OP_LABELS: Record<ArchiveOp, string> = {
  move: "移动到",
  copy: "复制到",
  extract: "解压到",
  mkdir: "新建分类目录",
};

const KIND_LABEL: Record<string, string> = { f: "FILE", d: "DIR", l: "LINK" };

const MAX_ROWS = 200;

export class LocalArchivePanel {
  private readonly root: HTMLElement;
  private readonly notify: (message: string) => void;

  private index: ArchiveIndex | null = null;
  private topLevel: string[] = [];
  private viaService = false;
  private status: ArchiveStatus | null = null;
  private loading = false;
  private loaded = false;

  private query = "";
  private source: ArchiveEntry | null = null;
  private plan: ArchivePlan | null = null;
  private busy = false;
  private unsubscribe: (() => void) | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(stage: HTMLElement, notify: (message: string) => void) {
    this.notify = notify;
    stage.insertAdjacentHTML("beforeend", this.markup());
    this.root = stage.querySelector<HTMLElement>("#local-archive")!;
    this.bind();
  }

  get opened(): boolean {
    return !this.root.hidden;
  }

  toggle() {
    if (this.opened) this.close();
    else this.open();
  }

  open() {
    this.root.hidden = false;
    this.root.dataset.visible = "true";
    void this.prepare();
    const input = this.root.querySelector<HTMLInputElement>("#la-query");
    requestAnimationFrame(() => input?.focus());
  }

  /** 供主界面检索弹窗调用：打开面板并带入检索词。 */
  openWithQuery(query: string) {
    this.open();
    const input = this.root.querySelector<HTMLInputElement>("#la-query");
    if (input) input.value = query;
    this.query = query.trim().toLowerCase();
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.render(), 0);
  }

  close() {
    this.root.dataset.visible = "false";
    this.root.hidden = true;
    // 刻意保留服务端事件订阅：关闭面板期间归档仍可能变动，
    // 退订会让下次打开拿到过期索引（这正是"加了文件却搜不到"的成因）。
    this.source = null;
    this.plan = null;
    this.renderOps();
    this.notify("已退出本地归档");
  }

  // ---------- 数据 ----------
  private async prepare() {
    await this.checkStatus();
    // 服务在线时每次打开都重新取索引（maxAgeMs: 0 表示不信任缓存），
    // 因为归档可能刚被别的工具或智能体改过。离线时退回静态快照，只取一次。
    if (!this.loading && (this.status || !this.loaded)) {
      await this.loadIndex(this.status ? 0 : Number.POSITIVE_INFINITY);
    } else {
      this.render();
    }
    this.ensureSubscription();
  }

  private ensureSubscription() {
    if (!this.viaService || this.unsubscribe) return;
    this.unsubscribe = subscribeRescan(() => this.scheduleReload());
  }

  private async checkStatus() {
    this.status = await fetchStatus();
    this.renderStatus();
  }

  private async loadIndex(maxAgeMs: number) {
    this.loading = true;
    this.render();
    try {
      const { index, viaService } = await loadArchiveIndex({ maxAgeMs });
      this.index = index;
      this.viaService = viaService;
      this.topLevel = topLevelNames(index);
      this.loaded = true;
    } catch (error) {
      this.notify(`读取归档索引失败：${(error as Error).message}`);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private scheduleReload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(async () => {
      try {
        const { index, viaService } = await loadArchiveIndex({ maxAgeMs: 0 });
        this.index = index;
        this.viaService = viaService;
        this.topLevel = topLevelNames(index);
        this.loaded = true;
        this.render();
        this.notify("归档已变动，索引已自动更新");
      } catch {
        /* 忽略一次失败，等下一次事件 */
      }
    }, 1500);
  }

  // ---------- 检索 ----------
  private matches(needle: string, limit: number): ArchiveEntry[] {
    if (!this.index) return [];
    return searchArchive(this.index, needle, limit).hits;
  }

  private countMatches(needle: string): number {
    if (!this.index) return 0;
    return searchArchive(this.index, needle, 1).total;
  }

  // ---------- 渲染 ----------
  private markup(): string {
    return `
<section id="local-archive" class="local-archive" hidden aria-label="本地归档检索与归档操作">
  <div class="la-backdrop" data-la="close"></div>
  <section class="la-surface" role="dialog" aria-modal="true" aria-label="本地归档">
    <header class="la-top">
      <span>RHINE LAB / LOCAL ARCHIVE</span>
      <div class="la-status" id="la-status"><i></i><span>正在检测归档服务…</span></div>
      <button data-la="close" aria-label="关闭本地归档">CLOSE <span>×</span></button>
    </header>
    <h2>LOCAL ARCHIVE<small>本地归档 · 检索与归档操作</small></h2>
    <div class="la-search">
      <span class="nav-glyph" aria-hidden="true"></span>
      <input id="la-query" type="search" autocomplete="off" placeholder="检索路径或文件名：runs / .7z / 2026-02 / 吉他谱 …" aria-label="检索本地归档" />
      <span class="la-count" id="la-count"></span>
    </div>
    <div class="la-body">
      <div class="la-results" id="la-results"></div>
      <aside class="la-ops" id="la-ops"></aside>
    </div>
  </section>
</section>`;
  }

  private bind() {
    this.root.addEventListener("click", (event) => {
      const target = (event.target as Element).closest<HTMLElement>("[data-la]");
      if (!target) return;
      const action = target.dataset.la!;
      if (action === "close") return this.close();
      if (action === "open") return void this.doOpen(target.dataset.path!);
      if (action === "reveal") return void this.doReveal(target.dataset.path!);
      if (action === "pick") return this.pick(target.dataset.path!);
      if (action === "preview") return void this.doPreview();
      if (action === "apply") return void this.doApply();
      if (action === "reset") return this.resetOps();
      if (action === "refresh") return void this.doRefresh();
      if (action === "top") {
        this.fillDestination(target.dataset.top!);
        return;
      }
    });

    this.root.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.id === "la-query") {
        this.query = target.value.trim().toLowerCase();
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.render(), 110);
      } else if (target.id === "la-dest") {
        this.plan = null;
        this.renderOps();
      }
    });

    this.root.addEventListener("change", (event) => {
      const target = event.target as HTMLSelectElement;
      if (target.id === "la-op") {
        this.plan = null;
        this.renderOps();
      }
    });

    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.opened) {
        event.stopPropagation();
        this.close();
      }
    });
  }

  private renderStatus() {
    const node = this.root.querySelector<HTMLElement>("#la-status");
    if (!node) return;
    if (!this.status) {
      node.dataset.state = "offline";
      node.innerHTML =
        "<i></i><span>归档服务未运行 · 只读检索模式</span>" +
        '<code>npm run dev:archive</code>';
      return;
    }
    node.dataset.state = "online";
    const scan = this.status.lastScan
      ? new Date(this.status.lastScan).toLocaleTimeString()
      : "—";
    node.innerHTML =
      `<i></i><span>服务在线 · 127.0.0.1:${this.status.port} · ` +
      `${this.status.watching ? "监视中" : "未监视"} · 快照 ${escapeHtml(scan)}</span>` +
      `<button data-la="refresh" title="立即重新扫描归档">重新扫描 ↻</button>`;
  }

  private render() {
    const results = this.root.querySelector<HTMLElement>("#la-results");
    const count = this.root.querySelector<HTMLElement>("#la-count");
    if (!results || !count) return;

    if (this.loading || !this.loaded) {
      count.textContent = this.loading ? "正在载入索引…" : "";
      results.innerHTML = `<div class="la-empty"><strong>${
        this.loading ? "LOADING" : "NO INDEX"
      }</strong><span>${this.loading ? "正在读取归档索引" : "索引尚未载入"}</span></div>`;
      return;
    }

    const totals = this.index?.entries.length ?? 0;
    if (!this.query) {
      count.textContent = `共 ${totals.toLocaleString()} 条 · 输入关键字开始检索`;
      results.innerHTML = `<div class="la-empty"><strong>${totals.toLocaleString()}</strong>
        <span>个条目已索引${this.viaService ? "（服务端）" : "（静态快照）"}</span>
        <p>按文件名、扩展名或日期片段检索，例如 <code>.7z</code>、<code>2026-02</code>、<code>吉他谱</code>。<br />
        选中结果后可在右侧执行移动、复制、解压或新建分类目录。</p></div>`;
      return;
    }

    const total = this.countMatches(this.query);
    const hits = this.matches(this.query, MAX_ROWS);
    count.textContent = `${total.toLocaleString()} 条命中${
      total > hits.length ? ` · 显示前 ${hits.length} 条` : ""
    }`;

    if (!hits.length) {
      results.innerHTML = `<div class="la-empty"><strong>NO RESULT</strong><span>没有匹配的条目</span>
        <p>试试更短的关键字，或按扩展名检索。</p></div>`;
      return;
    }

    results.innerHTML = hits
      .map((entry) => {
        const cut = entry.path.lastIndexOf("/");
        const dir = cut < 0 ? "" : entry.path.slice(0, cut + 1);
        const name = cut < 0 ? entry.path : entry.path.slice(cut + 1);
        const selected = this.source?.path === entry.path ? " selected" : "";
        const serviceOnly = this.viaService ? "" : " disabled";
        return `<div class="la-row${selected}" data-kind="${entry.kind}">
  <div class="la-row-main">
    <span class="la-kind">${KIND_LABEL[entry.kind] ?? "?"}</span>
    <span class="la-name">${this.highlight(name)}<small>${escapeHtml(dir)}</small></span>
    <span class="la-meta"><b>${entry.kind === "d" ? "—" : formatBytes(entry.size)}</b><small>${formatTime(entry.mtime)}</small></span>
  </div>
  <div class="la-row-actions">
    <button data-la="open" data-path="${escapeHtml(entry.path)}"${serviceOnly}>打开</button>
    <button data-la="reveal" data-path="${escapeHtml(entry.path)}"${serviceOnly}>定位</button>
    <button data-la="pick" data-path="${escapeHtml(entry.path)}" class="primary">归档…</button>
  </div>
</div>`;
      })
      .join("");
  }

  private highlight(text: string): string {
    const lower = text.toLowerCase();
    const index = this.query ? lower.indexOf(this.query) : -1;
    if (index < 0) return escapeHtml(text);
    return (
      escapeHtml(text.slice(0, index)) +
      `<mark>${escapeHtml(text.slice(index, index + this.query.length))}</mark>` +
      escapeHtml(text.slice(index + this.query.length))
    );
  }

  private pick(path: string) {
    this.source =
      this.index?.entries.find((entry) => entry.path === path) ?? null;
    this.plan = null;
    this.render();
    this.renderOps();
  }

  private resetOps() {
    this.source = null;
    this.plan = null;
    this.renderOps();
    this.render();
  }

  private currentOp(): ArchiveOp {
    const select = this.root.querySelector<HTMLSelectElement>("#la-op");
    return (select?.value as ArchiveOp) ?? "move";
  }

  private destination(): string {
    return (
      this.root.querySelector<HTMLInputElement>("#la-dest")?.value.trim() ?? ""
    );
  }

  private fillDestination(value: string) {
    const input = this.root.querySelector<HTMLInputElement>("#la-dest");
    if (!input) return;
    const op = this.currentOp();
    const base = this.source ? this.source.path.split("/").pop()! : "";
    if (op === "move" || op === "copy") {
      input.value = base ? `${value}/${base}` : value;
    } else {
      input.value = value;
    }
    this.plan = null;
    this.renderOps();
  }

  private renderOps() {
    const ops = this.root.querySelector<HTMLElement>("#la-ops");
    if (!ops) return;
    const op = this.currentOp();
    const chips = this.topLevel
      .map(
        (name) =>
          `<button data-la="top" data-top="${escapeHtml(name)}">${escapeHtml(name)}</button>`,
      )
      .join("");

    const planBlock = this.plan ? this.planMarkup(this.plan) : "";
    const canApply =
      this.viaService && this.plan && !this.plan.blocked && !this.busy;

    ops.innerHTML = `
<div class="la-ops-head"><span>归档操作</span><button data-la="reset" class="ghost">清空</button></div>
${
  this.source
    ? `<div class="la-source">
        <span class="la-kind">${KIND_LABEL[this.source.kind] ?? "?"}</span>
        <div><strong>${escapeHtml(this.source.path.split("/").pop()!)}</strong>
        <small>${escapeHtml(this.source.path)}</small></div>
        <b>${this.source.kind === "d" ? "目录" : formatBytes(this.source.size)}</b>
      </div>`
    : `<p class="la-hint">在左侧检索并点击「归档…」选中一个条目，然后在这里执行操作。</p>`
}
<div class="la-field">
  <label for="la-op">操作</label>
  <select id="la-op"${this.viaService ? "" : " disabled"}>
    ${(Object.keys(OP_LABELS) as ArchiveOp[])
      .map(
        (key) =>
          `<option value="${key}"${key === op ? " selected" : ""}>${OP_LABELS[key]}</option>`,
      )
      .join("")}
  </select>
</div>
<div class="la-field">
  <label for="la-dest">${op === "mkdir" ? "新目录路径" : "目标路径"}</label>
  <input id="la-dest" type="text" autocomplete="off" spellcheck="false"
    placeholder="${op === "mkdir" ? "例如 08_新分类" : "例如 01_人工智能/01_训练产物/runs.7z"}"
    value="${escapeHtml(this.destination())}"${this.viaService ? "" : " disabled"} />
</div>
${
  chips
    ? `<div class="la-chips"><span>顶层分类</span><div>${chips}</div></div>`
    : ""
}
<div class="la-actions">
  <button data-la="preview" class="ghost"${this.viaService && !this.busy ? "" : " disabled"}>预览影响</button>
  <button data-la="apply" class="solid"${canApply ? "" : " disabled"}>${
    this.busy ? "执行中…" : "执行归档"
  }</button>
</div>
${
  this.viaService
    ? ""
    : `<p class="la-warn">写操作需要本地归档服务：在项目目录执行 <code>npm run dev:archive</code>，或单独执行 <code>npm run archive:serve</code>。</p>`
}
${planBlock}`;
  }

  private planMarkup(plan: ArchivePlan): string {
    const rows: string[] = [];
    if (plan.from) rows.push(`<div><span>源</span><b>${escapeHtml(plan.from)}</b></div>`);
    rows.push(`<div><span>目标</span><b>${escapeHtml(plan.to)}</b></div>`);
    if (plan.bytes) rows.push(`<div><span>体积</span><b>${formatBytes(plan.bytes)}</b></div>`);
    if (plan.files) rows.push(`<div><span>文件数</span><b>${plan.files}</b></div>`);
    if (plan.crossVolume) rows.push(`<div><span>跨盘</span><b>是</b></div>`);
    const state = plan.blocked
      ? `<p class="la-blocked">不可执行：${escapeHtml(plan.blocked)}</p>`
      : `<p class="la-ok">可以执行${plan.note ? ` · ${escapeHtml(plan.note)}` : ""}</p>`;
    return `<div class="la-plan"><div class="la-plan-head">影响预览</div>${rows.join("")}${state}</div>`;
  }

  // ---------- 操作 ----------
  private request(): ArchiveRequest {
    const op = this.currentOp();
    const dest = this.destination();
    if (op === "mkdir") return { op, folder: dest };
    return { op, from: this.source?.path, to: dest };
  }

  private validate(): string | null {
    const op = this.currentOp();
    const dest = this.destination();
    if (!this.viaService) return "本地归档服务未运行";
    if (!dest) return op === "mkdir" ? "请填写新目录路径" : "请填写目标路径";
    if (dest.startsWith("/") || /^[a-zA-Z]:/.test(dest))
      return "目标路径要写成相对归档根目录的形式，例如 01_人工智能/runs.7z";
    if (dest.includes("..")) return "目标路径不能包含 ..";
    if (op !== "mkdir" && !this.source) return "请先在左侧选中一个条目";
    if (op !== "mkdir" && this.source?.path === dest) return "目标与源相同";
    return null;
  }

  private async doPreview() {
    const invalid = this.validate();
    if (invalid) return this.notify(invalid);
    this.busy = true;
    this.renderOps();
    try {
      this.plan = await planOperation(this.request());
    } catch (error) {
      this.plan = null;
      this.notify(`预览失败：${(error as Error).message}`);
    } finally {
      this.busy = false;
      this.renderOps();
    }
  }

  private async doApply() {
    const invalid = this.validate();
    if (invalid) return this.notify(invalid);
    if (!this.plan) return this.notify("请先预览影响");
    if (this.plan.blocked) return this.notify(this.plan.blocked);
    this.busy = true;
    this.renderOps();
    try {
      await applyOperation(this.request());
      this.notify(`${OP_LABELS[this.plan.op]}成功：${this.plan.to}`);
      this.plan = null;
      this.source = null;
      invalidateArchiveIndex(); // 归档已变，丢弃共享缓存，避免主界面检索看到旧数据
      await this.loadIndex(0);
      this.renderOps();
    } catch (error) {
      this.notify(`归档失败：${(error as Error).message}`);
    } finally {
      this.busy = false;
      this.renderOps();
    }
  }

  private async doOpen(path: string) {
    if (!this.viaService) return this.notify("打开文件需要本地归档服务");
    try {
      await openEntry(path);
      this.notify(`已用系统默认程序打开：${path}`);
    } catch (error) {
      this.notify(`打开失败：${(error as Error).message}`);
    }
  }

  private async doReveal(path: string) {
    if (!this.viaService) return this.notify("定位需要本地归档服务");
    try {
      await revealEntry(path);
      this.notify(`已在资源管理器中定位：${path}`);
    } catch (error) {
      this.notify(`定位失败：${(error as Error).message}`);
    }
  }

  private async doRefresh() {
    if (!this.viaService) return this.notify("重新扫描需要本地归档服务");
    try {
      const result = await refreshSnapshot();
      invalidateArchiveIndex();
      await this.loadIndex(0);
      this.notify(`已重新扫描：${new Date(result.generated).toLocaleTimeString()}`);
    } catch (error) {
      this.notify(`重新扫描失败：${(error as Error).message}`);
    }
  }
}
