# 本地归档接入验证（2026-09-12）

本轮把 `E:\归档`（约 90 GB / 45,055 个文件 / 4,937 个目录）接入本项目：四十条精选档案改为由真实归档生成，新增 **LOCAL ARCHIVE** 面板做全量检索与安全写操作。

实现说明见 [`../docs/LOCAL-ARCHIVE.md`](../docs/LOCAL-ARCHIVE.md)，数据维护见 [`../content/README.md`](../content/README.md)。

## 新增与改动

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `archive.config.json` | 新增 | 归档根目录、端口、索引与日志位置 |
| `content/curated.mjs` | 新增 | 四十条档案的手写部分与对应的真实 `path` |
| `scripts/archive-source.mjs` | 新增 | 扫描归档，生成 `archives.json`、`archive-index.json`、40 个 TXT |
| `scripts/archive-service.mjs` | 新增 | 回环服务：令牌、路径围栏、检索、读写操作、目录监视 |
| `scripts/archive-dev.mjs` | 新增 | 一条命令同时启动服务与 Vite |
| `src/archive-service.ts` | 新增 | 浏览器端客户端，含静态快照降级 |
| `src/archive-panel.ts` | 新增 | 检索与归档操作面板 |
| `src/archive-panel.css` | 新增 | 面板样式，全部走 `--theme-*` 变量 |
| `scripts/archive-content.mjs` | 改动 | `source` 接受 `file:`；TXT 模板改为归档口径 |
| `src/main.ts` | 改动 | 导航新增 LOCAL ARCHIVE 按钮、点击分支、面板实例化；详情页 EXPORT 下载改为 SHOW IN FOLDER 定位 |
| `src/data.ts` | 改动 | `ArchiveRecord` 增加可选的 `path` 与 `stats`（生成物写入的真实归档信息） |
| `src/style.css`、`src/responsive.css` | 改动 | `.export-button` 改为双语按钮并加宽；新增被截断的 `.detail-path` |
| `vite.config.ts` | 改动 | `server`/`preview` 增加 `/archive-api` 代理并注入令牌 |
| `package.json` | 改动 | 新增 `dev:archive`、`archive:snapshot`、`archive:serve`；钩子改跑 `archive-source.mjs` |
| `.gitignore` | 改动 | 忽略 `.archive-token` |
| `content/README.md` | 改动 | 说明 `archives.json` 现在是生成物；`path` 的两个用途 |
| `docs/LOCAL-ARCHIVE.md`、`verification/ARCHIVE-INTEGRATION.md` | 新增 | 用法、安全边界与实测记录 |

**没有改动的**：`src/scene.ts`、`src/archive-loop.ts` 与阵列数学。五列、每列八份、`X-0NN` 稳定编号的约束原样保留，`archive-content.mjs` 的三条硬校验（五分类 / 四十条 / 每类八条）未放宽。

## 证据

### 1. 数据校验与构建

```
$ npm run check:content
ℹ tests 18   ℹ pass 18   ℹ fail 0

$ npx tsc --noEmit
exit=0

$ npm run build
归档快照已更新：40 条精选档案，45055 个文件 / 4937 个目录 / 90.03 GB
dist/assets/index-KZVOVeb_.js   993.68 kB │ gzip: 301.66 kB
✓ built in 2.48s
Offline release 22cf358e6368842a: 818 files, 33.8 MiB.
build exit=0
```

`check:content` 的 18 项包含"下载 TXT 与 `archiveText` 逐字节一致（含 BOM）"，即 40 个 TXT 与 `archives.json` 同步；放宽 `source` 协议后，`rejects unsafe URL`（`javascript:`）与 `rejects invalid URL`（`example.com`）两项仍如期失败，说明放宽没有引入注入面。

### 2. 服务接口实测

| 用例 | 结果 |
| --- | --- |
| 无令牌 `GET /status` | `401`，正确拒绝 |
| `GET /status` | `{"root":"E:\\归档","watching":true,"totals":{"files":45055,"dirs":4937,...},"sevenZip":true}` |
| `POST /open {"path":"../Windows/system.ini"}` | `403`（越界拦截） |
| `POST /reveal {"path":"C:\\Windows\\win.ini"}` | `403`（绝对路径拦截） |
| `POST /open {"path":"不存在的目录/foo.txt"}` | `404` |
| `POST /plan {"op":"mkdir"}` → `apply` | `blocked=null`，目录创建成功 |
| `POST /plan {"op":"move"}` → `apply` | `files=1 bytes=18`，移动成功，源消失 |
| 目标已存在时 `plan move` | `blocked="目标已存在，请换一个名字"` |
| `plan move` 到 `D:\` | `403`（目标越界拦截） |
| `POST /plan {"op":"extract","from":"07_日志与排查/LOG.7z"}` → `apply` | 解出 4 个文件，与包内条目数一致 |
| `POST /apply` 缺少 `confirm` | `400`，且未创建任何目录 |
| `GET /index`（gzip） | 7,767,411 字节 → 698,629 字节（约 9 倍） |
| `POST /refresh` | 返回新的快照时间 |

操作日志按预期落盘：

```json
{"at":"2026-09-12T02:10:44.855Z","op":"mkdir","from":null,"to":"_测试_归档操作","result":"ok"}
{"at":"2026-09-12T02:10:44.872Z","op":"move","from":"_测试源文件.txt","to":"_测试_归档操作/测试源文件.txt","result":"ok"}
{"at":"2026-09-12T02:10:44.946Z","op":"extract","from":"07_日志与排查/LOG.7z","to":"_测试_归档操作/LOG_解压","result":"ok"}
```

测试产物已全部删除，归档中已无 `_测试_*` 条目。

### 3. 自动更新

在归档根新建 `_自动更新测试.txt`，**不调用任何刷新接口**，等待 8 秒后检索：

```
索引命中 1 条：_自动更新测试.txt
最近一次快照：09/12/2026 02:11:06
```

删除该文件后再次等待，快照随之更新为 `02:11:14`。递归监视器与防抖重生生效。

### 4. 开发链路

```
$ npm run dev
归档快照已更新：40 条精选档案，45055 个文件 / 4937 个目录 / 90.03 GB
VITE v7.3.6  ready in 426 ms
➜  Local:   http://127.0.0.1:5174/     （5173 已被占用）

GET http://127.0.0.1:5174/                         → 200, text/html
GET http://127.0.0.1:5174/archive-api/status       → 200, 返回真实 status（令牌由代理注入）
GET http://127.0.0.1:5174/archive-api/search?q=runs.7z → 命中 2 条，含 01_人工智能/01_训练产物/runs.7z
GET http://127.0.0.1:5174/archive-index.json       → 200（静态降级路径可用）
GET http://127.0.0.1:5174/src/archive-panel.ts     → 200, 57,329 字节（Vite 转译无错）
GET http://127.0.0.1:5174/src/archive-service.ts   → 200, 15,727 字节
```

### 5. 产物复核

```
dist/assets/index-KZVOVeb_.js : LOCAL ARCHIVE / local-archive / la-surface /
                               archive-index.json / archive-api / 正在检测归档服务  全部命中
dist/assets/index-DeuQtmYI.css : .la-surface 命中
dist/archives/*.txt : 40 个
dist/archive-index.json : 7.41 MB（未进入 PWA 预缓存，818 files / 33.8 MiB 与改动前同量级）
```

### 6. 详情页 EXPORT 改为定位文件位置

按用户要求，详情页右下角的 EXPORT（下载 TXT）改为 **SHOW IN FOLDER / 文件位置**：直接用该档案的真实 `path` 调 `/reveal`，在资源管理器中打开其所在位置。

改动点：

- `src/main.ts:513` 的 `<a class="export-button" href="archives/…" download>` 换成 `<button data-action="reveal-archive">`；新增 `revealSelectedArchive()`，先 `fetchStatus()` 判断服务是否在线，离线时提示"需要本地归档服务：请运行 `npm run dev:archive`"，不静默失败。
- `src/data.ts` 的 `ArchiveRecord` 增加可选 `path` 与 `stats`。
- `.export-button` 加宽到 190px 并把 `<span>` 从箭头字号改回双语副标题（11px、`--theme-muted`）；紧凑/竖屏布局改为 132px。这处 `span` 样式只被该按钮使用，无外溢。
- 顺带修一处因接入本地数据而失效的地方：详情页脚注原本是 `<a href="${r.source}">设定参考 ↗</a>`，而 `source` 现在是 `file:` 链接，**浏览器不允许网页跳转 `file:`**。改为显示归档内相对路径文本（过长省略，完整值在 `title`），新增 `.detail-path`。

验证：

```
40 条档案全部带 path（40/40），示例 01_人工智能\01_训练产物\runs.7z
POST /reveal {"path":"01_人工智能\\01_训练产物\\runs.7z"}  → HTTP 200, action=reveal
npx tsc --noEmit  → exit=0
npm run build     → exit=0, dist/assets/index-BoST1KaL.js 994.12 kB
开发服务器 /src/main.ts 已含 reveal-archive / SHOW IN FOLDER / revealSelectedArchive / detail-path
产物：SHOW IN FOLDER、reveal-archive、需要本地归档服务、.detail-path 全部命中；"EXPORT <span>" 已无残留
```

`public/archives/*.txt` 仍会生成（`check:content` 依赖它们），只是详情页不再有下载入口。

### 7. 修复"归档新增了却搜不到"

用户报告：外部智能体往 `E:\归档` 导入了三个大包（7.26 GB + 6.63 GB + 6.71 GB），界面里搜不到。

**诊断过程**（先证伪，再改代码）：

| 检查 | 结果 |
| --- | --- |
| 文件是否在磁盘 | 三个包都在，`01_人工智能` 34.9 → 41.45 GB，`03_代码与项目` 7.12 → 20.69 GB |
| 快照是否过期 | 否。`NM2_原版...7z` mtime `14:34:11` → 快照生成 `14:34:25`，**14 秒后**自动重建 |
| 服务是否报错 | `/status` 的 `lastError` 为空 |
| 索引内容 | 完整复刻面板取数路径（`scripts/_diag-search.mjs`）：`dpskw` → 3 条、`NM2` → 1 条，服务路径与静态兜底都命中 |

结论：**索引、监视、检索逻辑全部正确，bug 在前端状态生命周期。**

**根因**：`LocalArchivePanel` 的索引只在「页面加载后第一次打开面板」时取一次，`loaded` 标志置真后永不复位；`close()` 还会 `unsubscribe()` 退掉服务端事件订阅，而重新订阅只发生在上面的 `loadIndex()` 里。因此**只要用户在文件加进来之前开过面板，之后重开既不重取也不重订阅，永远是旧数据**，除非整页刷新。这是实现缺陷，不是配置问题。

**修复**：

1. `src/archive-service.ts` 新增共享索引缓存 `loadArchiveIndex({ maxAgeMs })` 与 `searchArchive()` / `topLevelNames()` / `invalidateArchiveIndex()`。`maxAgeMs: 0` 表示不信任缓存、总是重取。
2. 面板**每次打开都重新取索引**（服务在线时 `maxAgeMs: 0`；离线时退回静态快照只取一次），`prepare()` 末尾调 `ensureSubscription()` 重新挂事件流，`close()` **不再退订**。写操作成功后 `invalidateArchiveIndex()` 丢弃共享缓存。
3. 顺带清掉面板自己维护的 `entries` / `lowerPaths` 两份派生数组，改由 `searchArchive()` 统一处理（小写路径用 `WeakMap` 按索引实例缓存）。

**主检索接入全量归档**（用户批准的第二项）：主检索弹窗（`/` 或 ARCHIVE INDEX）在四十条列表下方新增「LOCAL ARCHIVE / 本地归档」一栏，显示全量索引最多 5 条命中，每条可【定位】【打开】，点「全部 →」关闭弹窗并打开 LOCAL ARCHIVE 面板并带入检索词。两条路径共用同一份内存索引，不会重复下载 7.4 MB。`renderLocalHits()` 带请求令牌，快速输入时丢弃过期结果；`loadArchiveIndex({ maxAgeMs: 15_000 })` 让结果在 15 秒内保持新鲜。

布局：`.terminal-modal.has-local-hits .search-results` 由 387px 降到 240px，新增 `.local-hits` 140px，弹窗总高不变。

**验证**：

```
node scripts/_diag-search.mjs
  取数路径   : 服务 /archive-api/index
  条目数     : 49997
  'dpskw' -> 3 条   03_代码与项目/V2_dpskw-备份
  'NM2'   -> 1 条   01_人工智能/01_训练产物/NM2_原版_..._20260912_142722.7z
  静态兜底快照含 dpskw: 3 条，含 nm2: 1 条

npx tsc --noEmit  → exit=0
npm run build     → exit=0
```

**同期补的文档**：`00_索引\归档索引.md` 补登记 `NM2_原版`（另一智能体只写了 `V2_dpskw`）、更新分区体量与合计、新增「八、变更记录」逐笔列出整理后的导入（+20.12 GB）；`AGENTS.md` §3.2 从「主界面永远搜不到」改写为「三维阵列看不到、但主检索下方本地归档栏能搜到」，并加入"先查服务与快照时间，再怀疑代码"的排查顺序。

**遗留**：`scripts/_diag-search.mjs` 是一次性诊断脚本，验证后已删除。


## 尚未验证

- **浏览器内的实际呈现与交互**：项目未安装 Playwright / Puppeteer，`scripts/check-*.mjs` 均为纯 Node 逻辑测试，无法自动化驱动页面。面板与详情页按钮的布局、明暗配色、按钮手感，以及资源管理器窗口在用户多显示器环境下的落点，需要人工在 `npm run dev:archive` 下确认。
- **`/open` 的成功路径**：`/reveal` 的成功路径已用真实档案路径实测（弹出资源管理器并选中 `runs.7z`），`/open` 只验证了越界与不存在两种拦截，未实际唤起默认程序。
- **大目录解压的耗时**：仅用 `LOG.7z`（0.4 MB）验证了解压路径。对 `runs.7z`（26 GB）这类大包，`/plan` 只报包体大小，不会预估解压后的体积与耗时。
- **非默认浏览器 / 无文件关联时的打开行为**：取决于系统文件关联。

## 已知取舍

- `public/archive-index.json` 约 7.4 MB 会随构建进入 `dist`。它是快照而非源码，且不进离线预缓存；若要进一步瘦身，可去掉每个条目的 `mtime` 或改由服务端按需检索。
- 面板一次最多渲染 200 行命中，超出部分只计数不渲染，避免一次插入过多 DOM。
- 服务不可用时面板为只读，这是刻意降级而非缺陷。
- 归档内的 `.archive-token` 不存在：令牌写在**项目根目录**，不在归档内，避免污染归档。
