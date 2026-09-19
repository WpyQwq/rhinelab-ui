import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  loadContent,
  validateContent,
  archiveText,
} from "./archive-content.mjs";
import { escapeHtml } from "../src/html.ts";

const content = await loadContent();
test("all forty downloads match the shared content, including the UTF-8 BOM", async () => {
  for (const record of content.records) {
    assert.equal(
      (
        await readFile(
          new URL(
            `../public/archives/RHINE-LAB-${record.id}.txt`,
            import.meta.url,
          ),
          "utf8",
        )
      ).replace(/\r\n/g, "\n"),
      archiveText(record),
    );
  }
});

const invalidCases = [
  [
    "missing title",
    (c) => {
      delete c.records[0].title;
    },
    /records\[0\].title/,
  ],
  [
    "blank abstract",
    (c) => {
      c.records[0].abstract = "  ";
    },
    /abstract/,
  ],
  [
    "duplicate ID",
    (c) => {
      c.records[1].id = "X-001";
    },
    /重复编号/,
  ],
  [
    "reordered ID",
    (c) => {
      [c.records[0], c.records[1]] = [c.records[1], c.records[0]];
    },
    /X-001/,
  ],
  [
    "unknown category",
    (c) => {
      c.records[0].category = "未知";
    },
    /未知分类/,
  ],
  [
    "empty column",
    (c) => {
      // 把某一列的所有档案都挪到另一列 → 该列一条不剩，必须被拒。
      const victim = c.columns[0];
      const donor = c.columns[1];
      for (const record of c.records) if (record.category === victim) record.category = donor;
    },
    /至少要有一条档案/,
  ],
  [
    "too few records",
    (c) => {
      c.records.length = 4;
    },
    /至少需要每个分类一条档案/,
  ],
  [
    "null record",
    (c) => {
      c.records[0] = null;
    },
    /必须是档案对象/,
  ],
  [
    "empty findings",
    (c) => {
      c.records[0].findings = [];
    },
    /findings/,
  ],
  [
    "non-text findings",
    (c) => {
      c.records[0].findings = [42];
    },
    /findings/,
  ],
  [
    "unsafe URL",
    (c) => {
      c.records[0].source = "javascript:alert(1)";
    },
    /HTTPS/,
  ],
  [
    "invalid URL",
    (c) => {
      c.records[0].source = "example.com";
    },
    /HTTPS/,
  ],
  [
    "duplicate categories",
    (c) => {
      c.categories[1] = c.categories[0];
    },
    /不能重复/,
  ],
  [
    "reserved category",
    (c) => {
      c.categories[0] = "全部档案";
    },
    /全部档案/,
  ],
  [
    "mismatched columns",
    (c) => {
      c.columns[0] = "其他";
    },
    /相同的五个分类/,
  ],
];
for (const [name, mutate, error] of invalidCases) {
  test(`rejects ${name}`, () => {
    const invalid = structuredClone(content);
    mutate(invalid);
    assert.throws(() => validateContent(invalid), error);
  });
}
test("accepts independent filter and column order", () => {
  const edited = structuredClone(content);
  edited.categories.reverse();
  assert.equal(validateContent(edited), edited);
});
test("accepts unequal column counts instead of forcing eight each", () => {
  const edited = structuredClone(content);
  const want = [1, 12, 5, 2, 9]; // 合计 29，且每列都不同
  const pool = [...edited.records];
  edited.records = [];
  edited.columns.forEach((name, lane) => {
    for (let k = 0; k < want[lane]; k += 1) {
      const source = pool[lane * 3 + (k % 3)] ?? pool[0];
      edited.records.push({ ...source, category: name });
    }
  });
  edited.records.forEach((record, i) => {
    record.id = `X-${String(i + 1).padStart(3, "0")}`;
  });
  assert.equal(validateContent(edited), edited);
  assert.equal(edited.records.length, 29);
  edited.columns.forEach((name, lane) => {
    assert.equal(edited.records.filter((r) => r.category === name).length, want[lane]);
  });
});

test("pads archive ids to the total once it exceeds 999", () => {
  const edited = structuredClone(content);
  const base = edited.records[0];
  edited.records = Array.from({ length: 1200 }, (_, i) => ({
    ...structuredClone(base),
    category: edited.columns[i % edited.columns.length],
    id: `X-${String(i + 1).padStart(4, "0")}`,
  }));
  assert.equal(validateContent(edited), edited);
});

test("plain-text punctuation stays literal in HTML and downloadable text", () => {
  const title = `<玻璃> & "实验" 'A'`;
  const edited = structuredClone(content);
  edited.records[0].title = title;
  validateContent(edited);
  assert.equal(
    escapeHtml(title),
    "&lt;玻璃&gt; &amp; &quot;实验&quot; &#39;A&#39;",
  );
  assert.ok(archiveText(edited.records[0]).includes(title));
});
