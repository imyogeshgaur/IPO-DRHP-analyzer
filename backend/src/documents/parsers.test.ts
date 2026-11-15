import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument, splitIntoChunks } from "./parsers.js";

test("CSV extraction keeps column labels with each financial row", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rag-parser-"));
  const filePath = path.join(directory, "financials.csv");

  try {
    await writeFile(filePath, "Metric,2025\nRevenue,1250000\nExpenses,800000\n");
    const parsed = await parseDocument(filePath, ".csv");

    assert.match(parsed.text, /Metric: Revenue \| 2025: 1250000/);
    assert.match(parsed.text, /Metric: Expenses \| 2025: 800000/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("chunking preserves headings and bounds oversized paragraphs", () => {
  const [headingChunk, ...longChunks] = splitIntoChunks(
    `## Revenue\n\n${"financial data ".repeat(200)}`,
    120,
    20,
  );

  assert.equal(headingChunk?.section, "Revenue");
  assert.ok(longChunks.length > 1);
  assert.ok(
    longChunks.every((chunk) => chunk.text.length <= 120 && chunk.section === "Revenue"),
  );
});
