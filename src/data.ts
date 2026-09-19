import content from "../content/archives.json" with { type: "json" };

export interface ArchiveRecord {
  id: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
  /** 相对归档根目录的真实路径，由 scripts/archive-source.mjs 写入；用于在资源管理器中定位。 */
  path?: string;
  stats?: { bytes: number; files: number; modified: string | null };
}

export const records: ArchiveRecord[] = content.records;
export const categories = ["全部档案", ...content.categories];
export const archiveColumns = content.columns;

export function columnFiles(lane: number) {
  return records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.category === archiveColumns[lane])
    .map(({ index }) => index);
}
export function fileLocation(index: number) {
  const lane = archiveColumns.indexOf(records[index].category);
  const row = 12 + columnFiles(lane).indexOf(index);
  // slot 是 32 行窗口内的归一化坐标。列内超过 20 条时 row 会超过 32，
  // 若直接相加会串到下一列的行上，所以这里取模。
  // 交互路径用的是 {lane,row}，行空间无上限；slot 只服务 boot 的固定 160 布局。
  return { lane, row, slot: lane * 32 + (row % 32) };
}
export function fileAtSlot(slot: number) {
  const files = columnFiles(Math.floor(slot / 32));
  return files[Math.max(0, Math.min(files.length - 1, (slot % 32) - 12))];
}
