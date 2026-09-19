# 全量归档阵列（2026-09-12）⚠️ 已回退，仅存档

> **本文档描述的方案已于 2026-09-12 当天整体回退**，用户判定"索引完全改坏"。文中提到的
> `src/archive-array.ts` / `scripts/check-array.mjs` / `npm run check:array` / `loadArchiveDataset` /
> `searchDataset` / `laneCenter` / `rowPeriod` / `ROW_SNAP_DISTANCE` **都已不存在**，不要再按本文实现。
> 当前机制见 [`../AGENTS.md`](../AGENTS.md) 顶部「索引与阵列：当前机制（权威）」。保留本文只为记录当时的
> 设计与失败原因（列外条目错位、检索列表被 `00_索引` 元数据文件淹没）。

把三维档案阵列从**写死的 5 列 × 8 条（40 条精选档案）**改造为**全量归档驱动**：列 = 归档顶层内容分类，列内是该分类下的真实归档条目。条目简介由索引自动派生。

使用与安全边界见 [`../docs/LOCAL-ARCHIVE.md`](../docs/LOCAL-ARCHIVE.md)。

## 架构：两个数据集，一套寻址接口

| 数据集 | 来源 | 规模 | 作用 |
| --- | --- | ---: | --- |
| `curated` | `content/archives.json`（生成物，手写内容在 `content/curated.mjs`） | 5 列 / 40 条 | ① 模块加载时即刻可用，保证 `main.ts` 顶层的同步访问不炸 ② 归档索引不可用时降级 |
| `archive` | `public/archive-index.json`（生成物） | 7 列 / **32 张盘**（盘内 49,965 条） | `start()` 里由 `loadArchiveDataset()` 换上，阵列与检索的正式数据源 |

`data.ts` 的 `columnFiles` / `fileLocation` / `fileAtSlot` / `indexAtCell` 对两个数据集是同一套接口，因此阵列、循环、拖拽、收藏都不需要知道当前用的是哪一份。

## 为什么必须做性能改造

优化前后的实测（真实 49,997 条索引）：

| 指标 | 旧实现 | 新实现 |
| --- | ---: | ---: |
| 2000 次寻址 | **38,365 ms** | **0.33 ms** |
| 单次寻址 | ~19 ms | ~0.0002 ms |
| 一百万个格子反查 | — | 23 ms |
| 建表（一次性） | — | 72 ms |
| 全量数据集载入 | — | 181–231 ms |

旧实现每次调用都 `.map().filter()` 扫全量再用 `.indexOf()` 定位。真实后果不是"每帧卡"，而是**输入路径**卡：hover 每次进新格一次全扫（约 19 ms）、滚轮每步两次、**一次拖动最多 64 次（约 1.2 秒）**。

> 记录一条判断失误：我曾据基准推算出"旧写法每帧 19 秒"，这是错的。渲染循环 `scene.update` 里根本不调用 `columnFiles` / `fileAtCell`（每帧 0 次），开销全在输入路径。

## 关键设计决策

### 1. 全局行周期（这是全量化最容易错的一点）

行坐标靠"减去周期整数倍"做归一化（rebase），而位移必须保持内容不变 —— 也就是必须是该列**取模周期的整数倍**。各列长度不同（2340 / 14797 / 20675 …）时**不存在公共周期**。

解法：引入**全局行周期 = 最长一列的条数**（`data.ts` 的 `rowPeriod()`）。`indexAtCell` 先用全局周期定位槽位、再落到该列自身长度上：

```
slot = wrap(row - ROW_BASE, rowPeriod)
item = members[slot % members.length]
```

于是任何全局周期整数倍的平移都不改变结果，rebase 成立。`curated` 下各列都是 8，与原行为逐位一致。

`scripts/check-array.mjs` 专门断言了这条不变性（±1 个周期与 +3 个周期）。

### 2. `fileAtSlot` 与 `indexAtCell` 语义不同，不能合并

- `fileAtSlot` —— **截断**（越界夹到首尾）。只服务 boot 与 `?time=`/`review=1` 逐帧对照的固定 160 布局，必须与原片一致。
- `indexAtCell` —— **循环取模**。服务交互阵列的无限循环。

中途我把 `fileAtSlot` 误写成取模，等价性检查立刻报出 110 处差异（每列 12 行 × 9 列边距）。已改回截断。

### 3. 展示字段惰性物化 + 有界缓存

五万条记录若都生成摘要文本，仅数据就约 35 MB。`data.ts` 用 `Proxy` 惰性物化：只给真正被读到的条目算文本（首读一条含派生摘要约 **0.008 ms**）。缓存上限 1024，防止日后有人全量遍历时几十 MB 常驻。

### 4. 检索在紧凑索引上，绝不遍历 `records`

`renderResults` 曾经 `records.map().filter()` —— 全量下会物化五万条。现在走 `searchDataset()`：只比对路径字符串（小写路径惰性建一次），命中后由调用方按需读那几条。实测路径检索 **9 ms**。

`scene.ts` 对 `records` 的引用数现在是 **0**；`main.ts` 只剩 4 处 `records.length`（O(1)）与一处位于 curated 分支的 `forEach`。

### 5. 收藏改按路径键

编号是数组下标，归档新增文件会整体位移，按编号存会让旧收藏指到别的档案。改为 `recordKey()`（优先归档相对路径，退化为编号），`indexOfKey()` 用惰性 Map 反查。

### 6. 刻度条窗口化

`#file-ticks` 原先每条档案一个按钮；20,675 条会渲染两万个 DOM 节点。改为固定 8 个按钮的滑动窗口（`TICK_WINDOW`），随选中位置移动、按循环语义环绕。

### 7. 列数参数化

| 位置 | 改动 |
| --- | --- |
| `archive-loop.ts` | 新增 `configureLoop(columnCount)`；`LOOP_COLUMNS` / `POOL_LANES` 改为 live binding。前五项恒为真实列（列数不足时回绕），保证固定 160 布局永远成立 |
| `archive-visibility.ts:36-37,42` | `+2` / `(lane-2)` → `laneCenter()` |
| `scene.ts` | 四处 lane 原点改用 `laneCenter()`；rebase 周期 `(lane-2)/5` → `/(列数)`、`(row-12)/8` → `/rowPeriod()`；`laneFocus` 与 `selectedSlot` 初值随列数；`Math.floor(selectedSlot/32)` → `ROW_STRIDE` |
| `motion.ts` | `archiveWave` / `cinematicField` 增加 `laneOrigin` 可选参数（默认 2，保持签名兼容，也不把数据层拖进纯数学模块） |
| `main.ts` | `COLUMN 03 / 05` 的 /05 改为动态；`columnMemory` 改为可重建；新增 `applyColumnChrome()` |

`scene.ts:1596` 的 `fixed` 路径（boot + 逐帧对照）**保持不变**：仍是 `Array.from({length:160})` 的 5 列 × 32 行，因为它是原片对照基准。正常入场走的是动态路径（`responsiveOpening` 令 `fixed=false`），所以 boot → archive 之间不会跳变，只是入场画面从 5 列变成 7 列。

### 8. 远距离跳转直接落位

`selectionCell` 的 `nearestOccurrence` 会把目标行放到离当前位置最近的同现点，最大距离是**列长的一半**——最长列 20,675 条，即最远 10,337 行。照阻尼飞过去镜头会横穿整列。

`scene.ts` 因此加了 `ROW_SNAP_DISTANCE = 64`（可视窗口 32 行的两倍）：行距超过它就认定是跳转而非移动，`shoulder` 与 `rail` 直接赋值、速度清零。

- 只作用于**行轴**。列轴最远只有半个列数（`nearestOccurrence` 对 7 列最多 3 列），原动画保留，不介入。
- 拖动、惯性、抽取期间由它们接管轨道，条件里显式排除，不干扰已确认的交互。
- 正常导航不会误触发：方向键与滚轮的连按滞后远小于 64 行（`check-array` 断言相邻移动的行距恒为 1）。

阈值两侧都由 `npm run check:array` 用真实数据钉住：相邻移动距离必须为 1，半列之外的跳转距离必须大于 64。

## 刻意没有改的东西

- **校验器 `archive-content.mjs` 与 `check-content.mjs` 未放宽**。因为 `content/archives.json` 仍是 curated 数据集、仍是 5 列 × 8 条 × 40 条，校验契约依旧成立 —— 原计划要放宽，架构定下来后发现没必要。
- **`export-records.mjs` / `build-pwa.mjs` 未改**。TXT 导出仍只针对 40 条精选档案（40 个文件），不会线性膨胀。

## 盘的粒度：一个项目一张盘（2026-09-12 修正）

第一版把**每个文件**都做成一张盘（49,997 张），这是错的。用户指出正确模型是"**一个项目就是一个 3D 盘，在盘内的页面可以自由访问所有文件**"。错误版本有两个可见后果：

1. 检索列表一打开就列 `records` 的前 60 条，而索引按路径排序，头 60 条正好是 `00_索引` 下的 CSV / MD / TXT 元数据文件；
2. 这些条目 `laneOf < 0`（不在任何列里），选中时 `fileLocation` 退回 `{lane: 0, row: 12}`，**抽出的是第一列的第一张盘**——完全错位。

现在的规则：

- **盘 = 分类下的第 1 层目录**（项目单元）。文件不是盘，更深的目录也不是盘。
- 列外条目不再参与 `searchDataset`，也不会出现在检索列表里；未输入关键字时列的是各列的盘。
- 详情页新增 **04 盘内文件** 页签：列当前盘的直接子项（目录在前），可逐层进入并带面包屑，文件可【打开】【定位】。

列分布：`4 / 2 / 11 / 3 / 4 / 4 / 4 = 32 张盘`，`unlisted` 49,965（盘内文件与更深结构）。

**副作用**：`ROW_SNAP_DISTANCE = 64` 在盘模型下**休眠**——最长列 11 张盘，最近同现点最远 5 行。阈值保留以应对粒度变化；`check-array` 会报告 `snapEngaged`，并在列长超过阈值时自动改断言为"必须触发"。

## 证据

```
$ npm run check:array
{
  "entries": 49997,
  "columns": 7,
  "counts": [2340, 14797, 20675, 11901, 200, 15, 32],
  "unlisted": 37,
  "rowPeriod": 20675,
  "roundTripsChecked": 89,
  "searchMs": 9,
  "addressMsPerMillion": 23,
  "checks": "passed"
}

$ npx tsc --noEmit                    → exit 0
$ npm run check:content               → 18 pass / 0 fail
$ node scripts/check-archive.mjs      → checks: passed（40 条 / 每列 8 / 帧 760 波峰等高）
$ node scripts/check-loop.mjs         → checks: passed（poolSize 288 / referenceInstances 160）
$ npm run build                       → exit 0，离线包 818 files / 33.9 MiB
```

行为等价性（对既有 40 条，与旧实现逐位对比）：`fileLocation` / `fileAtSlot` / `columnFiles` 差异均为 **0**。

## 尚未验证与已知取舍

- **浏览器内的实际观感**：项目无 Playwright / Puppeteer，也没有无头 WebGL 环境。7 列下的构图、卡片观感、`archiveCandidates` / `archiveCulled` 的真实数值，都需要人工在 `npm run dev:archive` 下确认。剔除遥测可从
  `JSON.parse(document.querySelector('#three-scene').dataset.renderStats)` 读取。
  - 相机位置与 fov 是按 5 列调的，但交互阵列本就只显示约 5 列、靠 `columnCamera` 横向平移到达其余列，因此**预期**只是横向可视列数不变、需要平移才能看到边缘列，而非取景错误。这一点未经实机确认。
- **列极不均衡**：`03_代码与项目` 20,675 条 vs `06_下载与安装包` 15 条。列数已参数化，若要改成"大分区拆子列"只需换列规则。
- **行坐标量级**：rebase 前行可达 20,675，z 约 12,800 单位。相机相对矩阵下精度约 0.001（卡片尺寸约 5），预期无可见影响，但未实测。
- **旧收藏**：早先按 `X-0NN` 编号存的收藏不会解析到路径键，会从收藏列表消失（仍留在 localStorage）。按编号存的语义本就与全量归档冲突，取舍是明确的。

