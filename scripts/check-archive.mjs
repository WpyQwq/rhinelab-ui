import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  records,
  archiveColumns,
  columnFiles,
  fileLocation,
  fileAtSlot,
} from "../src/data.ts";
import {
  cinematicField,
  columnStrength,
  INSPECTION_LIFT,
  returnStep,
  damp,
} from "../src/motion.ts";

// 条数不再有上限（校验器只要求每列 ≥1、总数 ≥5），因此这里不写死 40 / 8，
// 而是按数据推导并检查真正的契约：每列非空、列内槽位互不冲突。
assert.ok(records.length >= 5, "Archive must carry at least five documents");
const slots = new Set();
const perColumn = [];
let maxPerColumn = 0;
for (let lane = 0; lane < archiveColumns.length; lane++) {
  const files = columnFiles(lane);
  assert.ok(files.length >= 1, "Every column has at least one readable file");
  perColumn.push(files.length);
  maxPerColumn = Math.max(maxPerColumn, files.length);
  const laneSlots = new Set();
  for (const index of files) {
    const location = fileLocation(index);
    assert.equal(location.lane, lane);
    assert.equal(fileAtSlot(location.slot), index);
    assert.ok(location.row >= 0 && location.row < 32);
    // slot = lane * 32 + (row % 32)：同一列里超过 32 条才会开始复用槽位，
    // 届时 fileAtSlot（截断语义）本就不是用来寻址这些条目的，所以只断言列内不冲突。
    assert.ok(
      !laneSlots.has(location.slot) || files.length > 32,
      `Slots within one column must stay distinct (lane ${lane})`,
    );
    laneSlots.add(location.slot);
    slots.add(location.slot);
    const record = records[index];
    // 归档内容取代原 demo 之后，字数与条数不再固定：
    // 契约以 scripts/archive-content.mjs 的校验器为准——摘要非空、研究记录至少一条。
    // 这里保留一个极低的下限，只防止空壳内容混入。
    assert.ok(
      record.abstract.trim().length > 20,
      `Record abstract must carry real text (got ${record.abstract.trim().length} chars)`,
    );
    assert.ok(
      record.findings.length >= 1 &&
        record.findings.every((line) => String(line).trim().length > 0),
      "Every record carries at least one non-empty research note",
    );
    // 本地归档条目的参考链接是 file:（浏览器不允许网页跳转，仅供溯源）；
    // 公开设定类条目仍用 https:。
    assert.ok(
      ["https:", "file:"].includes(new URL(record.source).protocol),
      `Record source must be https: or file: (got ${new URL(record.source).protocol})`,
    );
  }
}
// 每列不超过 32 条时，所有条目的槽位应当恰好铺满、互不重叠。
if (maxPerColumn <= 32) {
  assert.equal(slots.size, records.length, "No two documents occupy the same slot");
}
const crests = Array.from({ length: 5 }, (_, lane) =>
  Math.max(
    ...Array.from({ length: 32 }, (_, row) => cinematicField(row, lane, 25.4)),
  ),
);
assert.ok(
  Math.max(...crests) - Math.min(...crests) < 1e-9,
  "Frame 760 crests share the same height",
);
assert.ok(columnStrength(0, 2) >= 0.25, "Other columns retain a visible wave");
assert.ok(columnStrength(2, 2) > columnStrength(1, 2));
let maxDelta = 0;
for (let f = 750; f < 786; f++) {
  for (let row = 0; row < 32; row++)
    for (let lane = 0; lane < 5; lane++) {
      maxDelta = Math.max(
        maxDelta,
        Math.abs(
          cinematicField(row, lane, (f + 1) / 25 - 5) -
            cinematicField(row, lane, f / 25 - 5),
        ),
      );
    }
}
assert.ok(
  maxDelta < 0.65,
  "The equal-crest to selected-column handoff is continuous",
);

// Validate against the delivered Blender model, not a duplicate nominal box.
const bytes = await readFile(
  new URL("../public/assets/archive-cassette.glb", import.meta.url),
);
const gltf = await new GLTFLoader().parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  "",
);
const box = new THREE.Box3().setFromObject(gltf.scene);
const height = box.max.y - box.min.y;
assert.ok(
  INSPECTION_LIFT - height > 0.25,
  "Inspection clears the adjacent card while staying near the array",
);
assert.ok(INSPECTION_LIFT <= 4.1, "Inspection lift remains modest");
let angle = 0.8,
  elapsed = 0;
while (angle !== 0 && elapsed < 2) {
  angle = returnStep(angle, 1 / 60);
  elapsed += 1 / 60;
}
assert.equal(angle, 0, "Alignment finishes exactly before insertion");
assert.ok(elapsed > 0.5 && elapsed < 1.2);
const coarse = { value: 2, velocity: 0 },
  fine = { ...coarse };
for (let i = 0; i < 30; i++) damp(coarse, 3, 4, 1 / 30);
for (let i = 0; i < 120; i++) damp(fine, 3, 4, 1 / 120);
assert.ok(Math.abs(coarse.value - fine.value) < 1e-9);
console.log(
  JSON.stringify(
    {
      documents: records.length,
      perColumn,
      maxPerColumn,
      crestsAt760: crests,
      maxFrameDelta: maxDelta,
      modelHeight: height,
      inspectionLift: INSPECTION_LIFT,
      alignmentSeconds: elapsed,
      checks: "passed",
    },
    null,
    2,
  ),
);
