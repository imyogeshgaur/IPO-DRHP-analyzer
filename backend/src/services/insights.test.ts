import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import type {
  DocumentChunkSummary,
  DocumentInsightRecord,
} from "../infrastructure/mongo.js";
import { DrhpInsightsService, numberAppearsInText } from "./insights.js";

const docId = "550e8400-e29b-41d4-a716-446655440010";

function createMockDb(chunks: DocumentChunkSummary[]) {
  const insightStore = new Map<string, DocumentInsightRecord>();
  return {
    insightStore,
    getDocument: async () => ({
      documentId: docId,
      ownerId: "user-a",
      filename: "Acme_Corp_DRHP.pdf",
      mediaType: "application/pdf",
      extension: ".pdf",
      documentType: "drhp" as const,
      storagePath: "documents/acme.pdf",
      status: "ready" as const,
      createdAt: new Date("2026-11-22T00:00:00.000Z"),
      updatedAt: new Date("2026-11-22T00:00:00.000Z"),
    }),
    getInsight: async (documentId: string, section: string) =>
      insightStore.get(`${documentId}:${section}`) ?? null,
    upsertInsight: async (record: DocumentInsightRecord) => {
      insightStore.set(`${record.documentId}:${record.section}`, record);
    },
    findChunksByDocument: async (
      _documentId: string,
      options: { sectionRegex?: string; textRegex?: string; limit?: number } = {},
    ) => {
      let filtered = chunks;
      if (options.sectionRegex) {
        const re = new RegExp(options.sectionRegex, "i");
        filtered = filtered.filter((c) => c.section && re.test(c.section));
      }
      if (options.textRegex) {
        const re = new RegExp(options.textRegex, "i");
        filtered = filtered.filter((c) => re.test(c.text));
      }
      return options.limit ? filtered.slice(0, options.limit) : filtered;
    },
    searchChunks: async () => [],
    searchChunksExact: async () => [],
    searchChunksLexical: async () => [],
  };
}

test("numberAppearsInText supports Indian formatting, decimals, and Crore/Million scaling", () => {
  assert.equal(
    numberAppearsInText(1234.5, "Revenue from operations: 12,345.00 million"),
    true,
  );
  assert.equal(
    numberAppearsInText(6652.5, "Total income was ₹6,652.52 Crore in FY25"),
    true,
  );
  assert.equal(
    numberAppearsInText(99999, "Revenue from operations: 1,250.00 Crore"),
    false,
  );
});

test("DrhpInsightsService extracts verified financial series, computes margins, drops unverified numbers, and caches results", async () => {
  const chunks: DocumentChunkSummary[] = [
    {
      chunkId: "fin-1",
      documentId: docId,
      filename: "Acme_Corp_DRHP.pdf",
      text: "Summary of Restated Consolidated Statement of Profit and Loss (in ₹ Crores). FY23 Revenue from operations 4,200.50, EBITDA 630.08, Profit for the year 310.20. FY24 Revenue from operations 5,400.00, EBITDA 918.00, Profit for the year 486.00. FY25 Revenue from operations 6,850.00, EBITDA 1,233.00, Profit for the year 712.40.",
      embeddingModel: "test",
      chunkIndex: 10,
      section: "Summary of Restated Consolidated Financial Information",
      pdfPageIndex: 54,
    },
  ];

  const db = createMockDb(chunks);
  let extractCalls = 0;
  const service = new DrhpInsightsService(db, {
    embed: async (texts) => texts.map(() => [0.1, 0.2]),
    extractStructuredJson: async <T,>(
      _systemPrompt: string,
      _userPrompt: unknown,
      schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    ): Promise<T> => {
      extractCalls += 1;
      return schema.parse({
        currency: "INR",
        unit: "Crores",
        basis: "Restated Consolidated",
        summary: "Revenue grew steadily from ₹4,200.5 Cr in FY23 to ₹6,850 Cr in FY25.",
        kpis: [
          { label: "FY25 Revenue", value: "₹6,850 Cr", delta: "+26.9% YoY", trend: "up", page: 55 },
          { label: "FY25 PAT", value: "₹712.4 Cr", delta: "+46.6% YoY", trend: "up", page: 55 },
        ],
        series: [
          { period: "FY23", revenue: 4200.5, ebitda: 630.08, pat: 310.2, page: 55 },
          { period: "FY24", revenue: 5400, ebitda: 918, pat: 486, page: 55 },
          { period: "FY25", revenue: 6850, ebitda: 1233, pat: 712.4, page: 55 },
          // Unverified hallucinated point should be dropped
          { period: "FY26", revenue: 999999, pat: 888888, page: 999 },
        ],
        highlights: [
          { text: "EBITDA expanded from ₹630.1 Cr in FY23 to ₹1,233 Cr in FY25.", page: 55 },
        ],
      });
    },
  });

  const first = await service.getOrGenerateSection(docId, "financials");
  assert.equal(first.section, "financials");
  assert.equal(first.status, "ready");
  assert.equal(first.data.series.length, 3);
  assert.equal(first.data.series[2]?.ebitdaMarginPct, 18);
  assert.equal(first.data.series[2]?.patMarginPct, 10.4);
  assert.equal(first.citations.length, 1);
  assert.equal(first.citations[0]?.page, 55);
  assert.equal(extractCalls, 1);

  // Second call hits MongoDB cache without re-invoking LLM
  const cached = await service.getOrGenerateSection(docId, "financials");
  assert.equal(cached.section, "financials");
  assert.equal(cached.data.series.length, 3);
  assert.equal(extractCalls, 1);
});

test("DrhpInsightsService samples diverse risk pages and computes deterministic severity/category counts", async () => {
  const chunks: DocumentChunkSummary[] = Array.from({ length: 10 }, (_, idx) => ({
    chunkId: `risk-${idx}`,
    documentId: docId,
    filename: "Acme_Corp_DRHP.pdf",
    text: `${idx + 1}. Risk factor on page ${30 + idx * 4}: Material adverse effect from operational, regulatory, financial, and litigation exposure across multiple business lines.`,
    embeddingModel: "test",
    chunkIndex: idx,
    section: "Risk Factors",
    pdfPageIndex: 29 + idx * 4,
  }));

  const db = createMockDb(chunks);
  let receivedPages: number[] = [];
  const service = new DrhpInsightsService(db, {
    embed: async (texts) => texts.map(() => [0.1, 0.2]),
    extractStructuredJson: async <T,>(
      _systemPrompt: string,
      userPrompt: unknown,
      schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    ): Promise<T> => {
      const payload = userPrompt as { excerpts: Array<{ page: number }> };
      receivedPages = payload.excerpts.map((e) => e.page);
      return schema.parse({
        summary: "Key risks span telecom licenses, supplier dependence, and ongoing tax disputes.",
        items: [
          {
            title: "Telecom spectrum & license renewal risk",
            category: "Regulatory",
            severity: "HIGH",
            impact: "Unified license due for renewal in 2033; loss would halt services.",
            page: 30,
          },
          {
            title: "High capital expenditure & debt servicing",
            category: "Financial",
            severity: "high",
            impact: "Substantial capex requirements may strain free cash flows.",
            page: 38,
          },
          {
            title: "Outstanding tax and regulatory litigation",
            category: "Legal dispute",
            severity: "Medium",
            impact: "Adverse rulings could result in material financial liabilities.",
            page: 46,
          },
        ],
      });
    },
  });

  const result = await service.getOrGenerateSection(docId, "risks");
  assert.equal(result.section, "risks");
  assert.equal(result.status, "ready");
  assert.ok(new Set(receivedPages).size >= 6, "should sample across multiple pages");
  assert.deepEqual(result.data.severityCounts, { high: 2, medium: 1, low: 0 });
  assert.equal(result.data.items.length, 3);
  assert.equal(result.data.items[2]?.category, "Litigation");
  assert.ok(result.citations.length >= 3);
});
