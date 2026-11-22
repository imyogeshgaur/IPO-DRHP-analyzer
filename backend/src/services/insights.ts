import { z } from "zod";
import { config } from "../config/config.js";
import {
  documentInsightResponseSchema,
  riskCategorySchema,
  type Citation,
  type CitedTextItem,
  type DocumentInsightResponse,
  type FinancialSeriesPoint,
  type FinancialsInsightData,
  type InsightSection,
  type IpoInsightData,
  type KpiMetric,
  type OverviewInsightData,
  type RiskCategory,
  type RiskItem,
  type RiskSeverity,
  type RisksInsightData,
  type UseOfProceedsItem,
} from "../contracts/contracts.js";
import type {
  DocumentChunkSummary,
  DocumentInsightRecord,
  RagDatabase,
  SearchResult,
} from "../infrastructure/mongo.js";
import type { GroundedModelClient } from "../infrastructure/ollama.js";

type InsightsDatabase = Pick<
  RagDatabase,
  | "getDocument"
  | "getInsight"
  | "upsertInsight"
  | "findChunksByDocument"
  | "searchChunks"
  | "searchChunksExact"
  | "searchChunksLexical"
>;

type InsightsModel = Pick<
  GroundedModelClient,
  "embed" | "extractStructuredJson"
>;

type InsightsLog = (event: string, fields: Record<string, unknown>) => void;

type EvidenceChunk = DocumentChunkSummary & {
  page?: number;
  relevanceScore: number;
};

const ALL_SECTIONS: InsightSection[] = [
  "overview",
  "financials",
  "risks",
  "ipo",
];

const nullishString = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === null || value === undefined) return undefined;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

const nullishNumber = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }
    const cleaned = value
      .trim()
      .replace(/^\(([\d,.\s]+)\)$/, "-$1")
      .replace(/[₹$,%\s]/g, "")
      .replace(/,/g, "");
    if (!cleaned || !/^-?\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  });

const nullishPage = nullishNumber.transform((value) =>
  value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : undefined,
);

const rawKpiSchema = z.object({
  label: nullishString,
  value: nullishString,
  delta: nullishString,
  trend: nullishString,
  page: nullishPage,
});

const rawCitedTextSchema = z.object({
  text: nullishString,
  page: nullishPage,
});

const rawFinancialsSchema = z.object({
  currency: nullishString,
  unit: nullishString,
  basis: nullishString,
  summary: nullishString,
  kpis: z.array(rawKpiSchema).optional().default([]),
  series: z
    .array(
      z.object({
        period: nullishString,
        revenue: nullishNumber,
        ebitda: nullishNumber,
        pat: nullishNumber,
        ebitdaMarginPct: nullishNumber,
        patMarginPct: nullishNumber,
        page: nullishPage,
      }),
    )
    .optional()
    .default([]),
  highlights: z.array(rawCitedTextSchema).optional().default([]),
});

const rawRisksSchema = z.object({
  summary: nullishString,
  items: z
    .array(
      z.object({
        title: nullishString,
        category: nullishString,
        severity: nullishString,
        impact: nullishString,
        page: nullishPage,
        snippet: nullishString,
      }),
    )
    .optional()
    .default([]),
});

const rawOverviewSchema = z.object({
  companyName: nullishString,
  sector: nullishString,
  summary: nullishString,
  keyMetrics: z.array(rawKpiSchema).optional().default([]),
  businessHighlights: z.array(rawCitedTextSchema).optional().default([]),
  strengths: z.array(rawCitedTextSchema).optional().default([]),
});

const rawIpoSchema = z.object({
  summary: nullishString,
  currency: nullishString,
  unit: nullishString,
  issueSize: nullishString,
  freshIssueAmount: nullishString,
  ofsAmount: nullishString,
  freshIssuePct: nullishNumber,
  ofsPct: nullishNumber,
  priceBand: nullishString,
  faceValue: nullishString,
  lotSize: nullishString,
  listingExchanges: z.array(z.string()).optional().default([]),
  useOfProceeds: z
    .array(
      z.object({
        purpose: nullishString,
        amount: nullishNumber,
        amountLabel: nullishString,
        percentage: nullishNumber,
        page: nullishPage,
      }),
    )
    .optional()
    .default([]),
});

export class DrhpInsightsService {
  constructor(
    private readonly database: InsightsDatabase,
    private readonly model: InsightsModel,
    private readonly log?: InsightsLog,
  ) {}

  async getOrGenerateSection(
    documentId: string,
    section: InsightSection,
    options: { forceRefresh?: boolean } = {},
  ): Promise<DocumentInsightResponse> {
    if (!options.forceRefresh) {
      const cached = await this.database.getInsight(documentId, section);
      if (cached) {
        const parsed = documentInsightResponseSchema.safeParse(cached.payload);
        if (parsed.success) {
          return parsed.data;
        }
      }
    }

    const generated = await this.generateSection(documentId, section);
    const validated = documentInsightResponseSchema.parse(generated);
    const record: DocumentInsightRecord = {
      documentId,
      section,
      payload: validated,
      updatedAt: new Date(),
    };
    await this.database.upsertInsight(record);
    return validated;
  }

  async precomputeAll(documentId: string): Promise<void> {
    for (const section of ALL_SECTIONS) {
      try {
        await this.getOrGenerateSection(documentId, section, {
          forceRefresh: true,
        });
      } catch (error) {
        this.log?.("drhp.insights.precompute_failed", {
          documentId,
          section,
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
  }

  private async generateSection(
    documentId: string,
    section: InsightSection,
  ): Promise<DocumentInsightResponse> {
    const document = await this.database.getDocument(documentId);
    const evidence = await this.gatherEvidence(documentId, section);
    const generatedAt = new Date().toISOString();

    this.log?.("drhp.insights.evidence_selected", {
      documentId,
      section,
      chunkCount: evidence.length,
      pages: [...new Set(evidence.map((c) => c.page).filter(Boolean))],
    });

    if (evidence.length === 0) {
      return emptyInsightResponse(
        documentId,
        section,
        generatedAt,
        document?.filename,
      );
    }

    const evidencePayload = evidence.map((chunk) => ({
      page: chunk.page ?? null,
      section: chunk.section ?? null,
      text: chunk.text.slice(0, 2600),
    }));

    switch (section) {
      case "financials":
        return this.extractFinancials(
          documentId,
          evidence,
          evidencePayload,
          generatedAt,
        );
      case "risks":
        return this.extractRisks(
          documentId,
          evidence,
          evidencePayload,
          generatedAt,
        );
      case "overview":
        return this.extractOverview(
          documentId,
          document?.filename,
          evidence,
          evidencePayload,
          generatedAt,
        );
      case "ipo":
        return this.extractIpo(
          documentId,
          evidence,
          evidencePayload,
          generatedAt,
        );
    }
  }

  private async gatherEvidence(
    documentId: string,
    section: InsightSection,
  ): Promise<EvidenceChunk[]> {
    switch (section) {
      case "financials":
        return this.gatherFinancialEvidence(documentId);
      case "risks":
        return this.gatherRiskEvidence(documentId);
      case "overview":
        return this.gatherOverviewEvidence(documentId);
      case "ipo":
        return this.gatherIpoEvidence(documentId);
    }
  }

  private async gatherFinancialEvidence(
    documentId: string,
  ): Promise<EvidenceChunk[]> {
    const [sectionChunks, textMatchChunks, semanticChunks] = await Promise.all([
      this.database.findChunksByDocument(documentId, {
        sectionRegex:
          "financial|restated|profit and loss|balance sheet|basis for (?:issue|offer) price|key performance|other financial|management'?s discussion",
        limit: 80,
      }),
      this.database.findChunksByDocument(documentId, {
        textRegex:
          "revenue from operations|total income|profit for the (?:year|period)|restated consolidated|ebitda|basic earnings per",
        limit: 60,
      }),
      this.semanticAndLexicalSearch(documentId, [
        "Summary of restated consolidated statement of profit and loss revenue from operations EBITDA profit after tax FY2023 FY2024 FY2025",
        "Key performance indicators financial metrics revenue growth EBITDA margin net worth total borrowings",
      ]),
    ]);

    const merged = mergeUniqueChunks(
      [...sectionChunks, ...textMatchChunks],
      semanticChunks,
    );
    const scored = merged
      .filter((chunk) => !isTableOfContentsChunk(chunk.text))
      .map((chunk) => ({
        ...chunk,
        relevanceScore:
          chunk.relevanceScore + scoreFinancialChunk(chunk.text, chunk.section),
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    return selectDiverseChunks(scored, { maxChunks: 12, maxPerPage: 2 });
  }

  private async gatherRiskEvidence(
    documentId: string,
  ): Promise<EvidenceChunk[]> {
    const [sectionChunks, semanticChunks] = await Promise.all([
      this.database.findChunksByDocument(documentId, {
        sectionRegex: "risk factor|internal risk|external risk|general risk",
        limit: 120,
      }),
      this.semanticAndLexicalSearch(documentId, [
        "Internal risk factors operational dependency supplier concentration business risks",
        "Financial risks indebtedness losses litigation regulatory compliance government approvals competition",
      ]),
    ]);

    // Stride across the Risk Factors section so we cover early, mid, and late risk pages
    const nonTocSection = sectionChunks.filter(
      (chunk) =>
        !isTableOfContentsChunk(chunk.text) && chunk.text.trim().length > 80,
    );
    const strided = sampleStrided(nonTocSection, 18);

    const merged = mergeUniqueChunks(strided, semanticChunks);
    const scored = merged
      .filter((chunk) => !isTableOfContentsChunk(chunk.text))
      .map((chunk) => ({
        ...chunk,
        relevanceScore:
          chunk.relevanceScore + scoreRiskChunk(chunk.text, chunk.section),
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    return selectDiverseChunks(scored, { maxChunks: 14, maxPerPage: 1 });
  }

  private async gatherOverviewEvidence(
    documentId: string,
  ): Promise<EvidenceChunk[]> {
    const [sectionChunks, semanticChunks] = await Promise.all([
      this.database.findChunksByDocument(documentId, {
        sectionRegex:
          "our business|about our company|summary of the offer document|offer document summary|industry overview|introduction|our company",
        limit: 50,
      }),
      this.semanticAndLexicalSearch(documentId, [
        "Company overview primary business products services customers market position competitive strengths",
        "Operational metrics stores subscribers employees countries manufacturing facilities presence",
      ]),
    ]);

    const merged = mergeUniqueChunks(sectionChunks.slice(0, 24), semanticChunks);
    const scored = merged
      .filter((chunk) => !isTableOfContentsChunk(chunk.text))
      .map((chunk) => ({
        ...chunk,
        relevanceScore:
          chunk.relevanceScore + scoreOverviewChunk(chunk.text, chunk.section),
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    return selectDiverseChunks(scored, { maxChunks: 10, maxPerPage: 2 });
  }

  private async gatherIpoEvidence(
    documentId: string,
  ): Promise<EvidenceChunk[]> {
    const [sectionChunks, textMatchChunks, semanticChunks] = await Promise.all([
      this.database.findChunksByDocument(documentId, {
        sectionRegex:
          "the offer|the issue|summary of the offer|objects of the (?:offer|issue)|terms of the (?:offer|issue)|capital structure|general information",
        limit: 60,
      }),
      this.database.findChunksByDocument(documentId, {
        textRegex:
          "fresh issue|offer for sale|objects of the (?:offer|issue)|net proceeds|face value|price band|book running lead",
        limit: 50,
      }),
      this.semanticAndLexicalSearch(documentId, [
        "Summary of the offer total issue size fresh issue offer for sale face value price band equity shares BSE NSE",
        "Objects of the offer utilization of net proceeds capital expenditure repayment of borrowings general corporate purposes",
      ]),
    ]);

    const merged = mergeUniqueChunks(
      [...sectionChunks, ...textMatchChunks],
      semanticChunks,
    );
    const scored = merged
      .filter((chunk) => !isTableOfContentsChunk(chunk.text))
      .map((chunk) => ({
        ...chunk,
        relevanceScore:
          chunk.relevanceScore + scoreIpoChunk(chunk.text, chunk.section),
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    return selectDiverseChunks(scored, { maxChunks: 12, maxPerPage: 2 });
  }

  private async semanticAndLexicalSearch(
    documentId: string,
    queries: string[],
  ): Promise<SearchResult[]> {
    const embeddings = await this.model.embed(queries);
    const collected = new Map<string, SearchResult>();

    await Promise.all(
      queries.map(async (query, index) => {
        const embedding = embeddings[index];
        if (!embedding) return;
        const [vectorResults, lexicalResults] = await Promise.all([
          config.vectorSearchMode === "exact_dev"
            ? this.database.searchChunksExact(
                embedding,
                12,
                config.maxExactSearchChunks,
                [documentId],
              )
            : this.database.searchChunks(embedding, 12, [documentId]),
          this.database.searchChunksLexical(query, 10, [documentId]),
        ]);

        for (const result of vectorResults) {
          const existing = collected.get(result.chunkId);
          if (!existing || result.score > existing.score) {
            collected.set(result.chunkId, result);
          }
        }
        for (const result of lexicalResults) {
          if (!collected.has(result.chunkId)) {
            collected.set(result.chunkId, {
              ...result,
              score: Math.min(0.85, 0.45 + result.textScore * 0.05),
            });
          }
        }
      }),
    );

    return [...collected.values()];
  }

  private async extractFinancials(
    documentId: string,
    evidence: EvidenceChunk[],
    evidencePayload: Array<{ page: number | null; section: string | null; text: string }>,
    generatedAt: string,
  ): Promise<DocumentInsightResponse> {
    const raw = await this.model.extractStructuredJson(
      [
        "You are a financial analyst extracting structured DRHP financial metrics strictly from the supplied PDF excerpts.",
        "Return JSON only matching this shape:",
        '{"currency":"INR","unit":"Crores or Millions (use the exact unit stated in the tables)","basis":"Restated Consolidated or Standalone","summary":"2-3 sentence executive summary of financial trajectory","kpis":[{"label":"FY25 Revenue","value":"₹1,234 Mn (or exact unit from table)","delta":"+24.5% YoY","trend":"up|down|flat","page":123}],"series":[{"period":"FY23","revenue":1000,"ebitda":200,"pat":120,"ebitdaMarginPct":20.0,"patMarginPct":12.0,"page":123}],"highlights":[{"text":"concise financial takeaway","page":123}]}',
        "Rules:",
        "- Use ONLY numbers directly present in the excerpts. Keep ALL KPI values and series numbers in the EXACT unit stated in the financial tables (never write 'Cr' if the table unit is Millions, and never write 'Mn' if the table unit is Crores).",
        "- Order series chronologically (oldest FY first, e.g., FY22, FY23, FY24, FY25). Include annual FY periods (and interim stub only if clearly labeled e.g. 9M FY25). Max 5 periods.",
        "- Provide up to 4 concise KPI cards (e.g., Latest Revenue, Latest PAT/Net Profit, EBITDA or Margin, Net Worth or Borrowings).",
        "- Provide up to 4 highlights. Use negative numbers for losses (e.g. -150.2).",
        "- Set missing optional fields to null; NEVER fabricate numbers. Every page number must come from the supplied excerpts.",
      ].join("\n"),
      { excerpts: evidencePayload },
      rawFinancialsSchema,
      "DRHP financials insight",
    );

    const evidenceByPage = indexEvidenceByPage(evidence);
    const allEvidenceText = evidence.map((c) => c.text).join("\n");

    const verifiedSeries: FinancialSeriesPoint[] = [];
    for (const point of raw.series.slice(0, 6)) {
      if (!point.period) continue;
      const page = resolveValidPage(point.page, evidenceByPage);
      const pageText =
        (page ? evidenceByPage.get(page)?.map((c) => c.text).join("\n") : undefined) ??
        allEvidenceText;
      const revenue = verifyFinancialNumber(point.revenue, pageText, allEvidenceText);
      const ebitda = verifyFinancialNumber(point.ebitda, pageText, allEvidenceText);
      const pat = verifyFinancialNumber(point.pat, pageText, allEvidenceText);

      const ebitdaMarginPct =
        point.ebitdaMarginPct !== undefined &&
        Math.abs(point.ebitdaMarginPct) <= 200
          ? round1(point.ebitdaMarginPct)
          : revenue && revenue > 0 && ebitda !== undefined
            ? round1((ebitda / revenue) * 100)
            : undefined;
      const patMarginPct =
        point.patMarginPct !== undefined && Math.abs(point.patMarginPct) <= 200
          ? round1(point.patMarginPct)
          : revenue && revenue > 0 && pat !== undefined
            ? round1((pat / revenue) * 100)
            : undefined;

      if (
        revenue === undefined &&
        ebitda === undefined &&
        pat === undefined &&
        ebitdaMarginPct === undefined &&
        patMarginPct === undefined
      ) {
        continue;
      }

      verifiedSeries.push({
        period: point.period,
        ...(revenue !== undefined ? { revenue } : {}),
        ...(ebitda !== undefined ? { ebitda } : {}),
        ...(pat !== undefined ? { pat } : {}),
        ...(ebitdaMarginPct !== undefined ? { ebitdaMarginPct } : {}),
        ...(patMarginPct !== undefined ? { patMarginPct } : {}),
        ...(page !== undefined ? { page } : {}),
      });
    }

    const unit = raw.unit ?? "Crores";
    const kpis = normalizeKpis(raw.kpis, evidenceByPage, 4).map((kpi) => ({
      ...kpi,
      value: alignKpiUnit(kpi.value, unit),
    }));
    const highlights = normalizeCitedItems(raw.highlights, evidenceByPage, 5);
    const summary =
      raw.summary ??
      (verifiedSeries.length > 0 || kpis.length > 0
        ? "Key restated financial metrics extracted from the prospectus."
        : "Limited financial table data was found in the indexed pages.");

    const referencedPages = collectReferencedPages([
      ...kpis.map((k) => k.page),
      ...verifiedSeries.map((s) => s.page),
      ...highlights.map((h) => h.page),
    ]);
    const citations = buildCitations(evidence, referencedPages, 6);

    const hasRichData = verifiedSeries.length >= 2 || kpis.length >= 2;
    const hasSomeData =
      verifiedSeries.length > 0 || kpis.length > 0 || highlights.length > 0;
    const status = hasRichData
      ? "ready"
      : hasSomeData
        ? "partial"
        : "unavailable";

    const data: FinancialsInsightData = {
      currency: raw.currency ?? "INR",
      unit,
      ...(raw.basis ? { basis: raw.basis } : {}),
      summary,
      kpis,
      series: verifiedSeries,
      highlights,
    };

    return {
      documentId,
      section: "financials",
      status,
      generatedAt,
      citations,
      ...(status !== "ready"
        ? {
            notice:
              status === "partial"
                ? "Some multi-year financial figures were not explicitly reported in the retrieved tables."
                : "Detailed restated financial tables could not be extracted from this PDF.",
          }
        : {}),
      data,
    };
  }

  private async extractRisks(
    documentId: string,
    evidence: EvidenceChunk[],
    evidencePayload: Array<{ page: number | null; section: string | null; text: string }>,
    generatedAt: string,
  ): Promise<DocumentInsightResponse> {
    const raw = await this.model.extractStructuredJson(
      [
        "You are an IPO risk analyst extracting a diverse, structured set of material Risk Factors from the supplied DRHP excerpts.",
        "Return JSON only matching this shape:",
        '{"summary":"2 sentence overview of the company\'s risk profile","items":[{"title":"Short crisp risk headline (max 90 chars)","category":"Operational|Financial|Regulatory|Litigation|Market|Technology|Governance","severity":"high|medium|low","impact":"1-2 sentence explanation of why this risk matters, preserving key disclosed facts/numbers","page":30,"snippet":"short supporting quote"}]}',
        "Rules:",
        "- Extract 6 to 9 DISTINCT material risks spanning MULTIPLE pages and categories where supported by the excerpts.",
        "- Classify severity thoughtfully: high = core business/revenue/license/solvency threat; medium = operational, competitive, or compliance exposure; low = secondary or general market risk.",
        "- Use ONLY categories from: Operational, Financial, Regulatory, Litigation, Market, Technology, Governance.",
        "- Every risk item MUST cite an exact page number from the supplied excerpts. Do not invent risks not in the excerpts.",
      ].join("\n"),
      { excerpts: evidencePayload },
      rawRisksSchema,
      "DRHP risks insight",
    );

    const evidenceByPage = indexEvidenceByPage(evidence);
    const defaultPage = evidence.find((c) => c.page !== undefined)?.page ?? 1;
    const seenTitles = new Set<string>();
    const items: RiskItem[] = [];

    for (const item of raw.items.slice(0, 10)) {
      if (!item.title || !item.impact) continue;
      const titleKey = item.title.toLocaleLowerCase().trim();
      if (seenTitles.has(titleKey)) continue;
      seenTitles.add(titleKey);

      const page = resolveValidPage(item.page, evidenceByPage) ?? defaultPage;
      const category = normalizeRiskCategory(item.category);
      const severity = normalizeRiskSeverity(item.severity);
      items.push({
        title: item.title.slice(0, 120),
        category,
        severity,
        impact: item.impact.slice(0, 420),
        page,
        ...(item.snippet ? { snippet: item.snippet.slice(0, 220) } : {}),
      });
    }

    // Sort high -> medium -> low
    const severityOrder: Record<RiskSeverity, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const severityCounts = { high: 0, medium: 0, low: 0 };
    const categoryMap = new Map<RiskCategory, number>();
    for (const item of items) {
      severityCounts[item.severity] += 1;
      categoryMap.set(item.category, (categoryMap.get(item.category) ?? 0) + 1);
    }
    const categoryCounts = [...categoryMap.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    const citations = buildCitations(
      evidence,
      collectReferencedPages(items.map((i) => i.page)),
      8,
    );
    const status =
      items.length >= 3
        ? "ready"
        : items.length > 0
          ? "partial"
          : "unavailable";

    const data: RisksInsightData = {
      summary:
        raw.summary ??
        (items.length > 0
          ? `Identified ${items.length} material risk factors across ${categoryCounts.length} categories.`
          : "No material risk factors could be extracted from the indexed sections."),
      severityCounts,
      categoryCounts,
      items,
    };

    return {
      documentId,
      section: "risks",
      status,
      generatedAt,
      citations,
      ...(status === "unavailable"
        ? { notice: "No risk factor sections were found in this document." }
        : {}),
      data,
    };
  }

  private async extractOverview(
    documentId: string,
    filename: string | undefined,
    evidence: EvidenceChunk[],
    evidencePayload: Array<{ page: number | null; section: string | null; text: string }>,
    generatedAt: string,
  ): Promise<DocumentInsightResponse> {
    const raw = await this.model.extractStructuredJson(
      [
        "You are an equity research analyst summarizing a company's DRHP overview strictly from the supplied PDF excerpts.",
        "Return JSON only matching this shape:",
        '{"companyName":"Exact company name","sector":"Industry / Sector","summary":"2-3 sentence clear business overview","keyMetrics":[{"label":"Store Network / Subscribers / Scale","value":"2,500+ stores","delta":"optional context","trend":"up|down|flat","page":12}],"businessHighlights":[{"text":"concise business model or product highlight","page":12}],"strengths":[{"text":"concise competitive strength","page":14}]}',
        "Rules:",
        "- Include up to 4 factual keyMetrics (scale, customers, stores, geographies, employees, or revenue scale) strictly from the excerpts.",
        "- Include 3-5 businessHighlights and 3-5 competitive strengths, each with a valid page number from the excerpts.",
        "- Never invent figures or facts absent from the excerpts.",
      ].join("\n"),
      { excerpts: evidencePayload },
      rawOverviewSchema,
      "DRHP overview insight",
    );

    const evidenceByPage = indexEvidenceByPage(evidence);
    const keyMetrics = normalizeKpis(raw.keyMetrics, evidenceByPage, 4);
    const businessHighlights = normalizeCitedItems(
      raw.businessHighlights,
      evidenceByPage,
      5,
    );
    const strengths = normalizeCitedItems(raw.strengths, evidenceByPage, 5);
    const companyName =
      raw.companyName ?? cleanCompanyName(filename) ?? "Company Overview";
    const summary =
      raw.summary ??
      "Company overview extracted from the prospectus.";

    const citations = buildCitations(
      evidence,
      collectReferencedPages([
        ...keyMetrics.map((m) => m.page),
        ...businessHighlights.map((b) => b.page),
        ...strengths.map((s) => s.page),
      ]),
      6,
    );

    const hasContent =
      Boolean(raw.summary) ||
      keyMetrics.length > 0 ||
      businessHighlights.length > 0;
    const status =
      Boolean(raw.summary) &&
      (keyMetrics.length > 0 || businessHighlights.length >= 2)
        ? "ready"
        : hasContent
          ? "partial"
          : "unavailable";

    const data: OverviewInsightData = {
      companyName,
      ...(raw.sector ? { sector: raw.sector } : {}),
      summary,
      keyMetrics,
      businessHighlights,
      strengths,
    };

    return {
      documentId,
      section: "overview",
      status,
      generatedAt,
      citations,
      data,
    };
  }

  private async extractIpo(
    documentId: string,
    evidence: EvidenceChunk[],
    evidencePayload: Array<{ page: number | null; section: string | null; text: string }>,
    generatedAt: string,
  ): Promise<DocumentInsightResponse> {
    const raw = await this.model.extractStructuredJson(
      [
        "You are an IPO specialist extracting offer details and Use of Proceeds strictly from the supplied DRHP/RHP excerpts.",
        "Return JSON only matching this shape:",
        '{"summary":"2 sentence offer summary","currency":"INR","unit":"Crores or Millions","issueSize":"e.g. ₹2,150 Cr or null if blank in DRHP","freshIssueAmount":"e.g. ₹2,150 Cr or Up to X equity shares","ofsAmount":"e.g. Up to 13.2 Cr equity shares","freshIssuePct":45.0,"ofsPct":55.0,"priceBand":"e.g. ₹380 - ₹400 or null if not disclosed","faceValue":"e.g. ₹2 per Equity Share","lotSize":"optional or null","listingExchanges":["BSE","NSE"],"useOfProceeds":[{"purpose":"Short label of object","amount":650.0,"amountLabel":"₹650 Cr","percentage":30.2,"page":88}]}',
        "Rules:",
        "- In Draft RHPs (DRHPs), price band or total issue size in rupees may be blank ('[•]'). Return null for undisclosed fields rather than guessing.",
        "- Extract every disclosed Object of the Offer / Use of Proceeds line item with its disclosed amount and page number.",
        "- Only compute freshIssuePct and ofsPct if both rupee amounts (or both share counts) are clearly disclosed so they sum to ~100.",
        "- Every page number must come from the supplied excerpts.",
      ].join("\n"),
      { excerpts: evidencePayload },
      rawIpoSchema,
      "DRHP IPO insight",
    );

    const evidenceByPage = indexEvidenceByPage(evidence);
    const useOfProceeds: UseOfProceedsItem[] = [];
    for (const item of raw.useOfProceeds.slice(0, 8)) {
      if (!item.purpose) continue;
      const page = resolveValidPage(item.page, evidenceByPage);
      useOfProceeds.push({
        purpose: item.purpose.slice(0, 140),
        ...(item.amount !== undefined && item.amount >= 0
          ? { amount: item.amount }
          : {}),
        ...(item.amountLabel ? { amountLabel: item.amountLabel } : {}),
        ...(item.percentage !== undefined &&
        item.percentage >= 0 &&
        item.percentage <= 100
          ? { percentage: round1(item.percentage) }
          : {}),
        ...(page !== undefined ? { page } : {}),
      });
    }

    // Backfill useOfProceeds percentages if amounts are known but percentages omitted
    const totalAmount = useOfProceeds.reduce(
      (sum, item) => sum + (item.amount ?? 0),
      0,
    );
    if (totalAmount > 0) {
      for (const item of useOfProceeds) {
        if (item.percentage === undefined && item.amount !== undefined) {
          item.percentage = round1((item.amount / totalAmount) * 100);
        }
      }
    }

    let freshIssuePct =
      raw.freshIssuePct !== undefined &&
      raw.freshIssuePct >= 0 &&
      raw.freshIssuePct <= 100
        ? round1(raw.freshIssuePct)
        : undefined;
    let ofsPct =
      raw.ofsPct !== undefined && raw.ofsPct >= 0 && raw.ofsPct <= 100
        ? round1(raw.ofsPct)
        : undefined;
    if (
      freshIssuePct !== undefined &&
      ofsPct !== undefined &&
      Math.abs(freshIssuePct + ofsPct - 100) > 5
    ) {
      freshIssuePct = undefined;
      ofsPct = undefined;
    }

    const exchanges = [
      ...new Set(
        raw.listingExchanges
          .map((item) => item.trim())
          .filter((item) => item.length > 0 && item.length <= 40),
      ),
    ].slice(0, 4);

    const citations = buildCitations(
      evidence,
      collectReferencedPages(useOfProceeds.map((item) => item.page)),
      6,
    );

    const hasFields = Boolean(
      raw.issueSize ||
        raw.freshIssueAmount ||
        raw.ofsAmount ||
        raw.faceValue ||
        useOfProceeds.length > 0 ||
        exchanges.length > 0,
    );
    const status =
      hasFields && (useOfProceeds.length > 0 || Boolean(raw.freshIssueAmount))
        ? "ready"
        : hasFields || Boolean(raw.summary)
          ? "partial"
          : "unavailable";

    const data: IpoInsightData = {
      summary:
        raw.summary ??
        "IPO structure and objects of the offer extracted from the prospectus.",
      ...(raw.currency ? { currency: raw.currency } : {}),
      ...(raw.unit ? { unit: raw.unit } : {}),
      ...(cleanDisclosedValue(raw.issueSize)
        ? { issueSize: cleanDisclosedValue(raw.issueSize) }
        : {}),
      ...(cleanDisclosedValue(raw.freshIssueAmount)
        ? { freshIssueAmount: cleanDisclosedValue(raw.freshIssueAmount) }
        : {}),
      ...(cleanDisclosedValue(raw.ofsAmount)
        ? { ofsAmount: cleanDisclosedValue(raw.ofsAmount) }
        : {}),
      ...(freshIssuePct !== undefined ? { freshIssuePct } : {}),
      ...(ofsPct !== undefined ? { ofsPct } : {}),
      ...(cleanDisclosedValue(raw.priceBand)
        ? { priceBand: cleanDisclosedValue(raw.priceBand) }
        : {}),
      ...(cleanDisclosedValue(raw.faceValue)
        ? { faceValue: cleanDisclosedValue(raw.faceValue) }
        : {}),
      ...(cleanDisclosedValue(raw.lotSize)
        ? { lotSize: cleanDisclosedValue(raw.lotSize) }
        : {}),
      listingExchanges: exchanges,
      useOfProceeds,
    };

    return {
      documentId,
      section: "ipo",
      status,
      generatedAt,
      citations,
      data,
    };
  }
}

function mergeUniqueChunks(
  directChunks: DocumentChunkSummary[],
  semanticChunks: SearchResult[],
): EvidenceChunk[] {
  const map = new Map<string, EvidenceChunk>();
  for (const chunk of semanticChunks) {
    map.set(chunk.chunkId, {
      ...chunk,
      ...(chunk.pdfPageIndex !== undefined
        ? { page: chunk.pdfPageIndex + 1 }
        : {}),
      relevanceScore: chunk.score * 2,
    });
  }
  for (const chunk of directChunks) {
    const existing = map.get(chunk.chunkId);
    if (existing) {
      existing.relevanceScore += 0.6;
    } else {
      map.set(chunk.chunkId, {
        ...chunk,
        ...(chunk.pdfPageIndex !== undefined
          ? { page: chunk.pdfPageIndex + 1 }
          : {}),
        relevanceScore: 0.75,
      });
    }
  }
  return [...map.values()];
}

function selectDiverseChunks(
  ranked: EvidenceChunk[],
  options: { maxChunks: number; maxPerPage: number },
): EvidenceChunk[] {
  const selected: EvidenceChunk[] = [];
  const countByPage = new Map<number, number>();
  const deferred: EvidenceChunk[] = [];

  for (const chunk of ranked) {
    if (selected.length >= options.maxChunks) break;
    const page = chunk.page;
    if (page !== undefined) {
      const count = countByPage.get(page) ?? 0;
      if (count >= options.maxPerPage) {
        deferred.push(chunk);
        continue;
      }
      countByPage.set(page, count + 1);
    }
    selected.push(chunk);
  }

  for (const chunk of deferred) {
    if (selected.length >= options.maxChunks) break;
    selected.push(chunk);
  }

  return selected;
}

function sampleStrided<T>(items: T[], target: number): T[] {
  if (items.length <= target) return items;
  const sampled: T[] = [];
  const step = (items.length - 1) / (target - 1);
  for (let i = 0; i < target; i += 1) {
    const item = items[Math.round(i * step)];
    if (item) sampled.push(item);
  }
  return sampled;
}

function isTableOfContentsChunk(text: string): boolean {
  const dotted = (text.match(/[.·…]{5,}\s*\d{1,4}/g) ?? []).length;
  return dotted >= 3 || /^\s*table\s+of\s+contents\b/i.test(text);
}

function scoreFinancialChunk(text: string, section?: string): number {
  let score = 0;
  const lower = text.toLocaleLowerCase();
  const sec = (section ?? "").toLocaleLowerCase();

  if (
    /summary of (?:restated|financial)|restated consolidated|key performance|basis for (?:issue|offer) price/.test(
      sec,
    )
  ) {
    score += 2.2;
  } else if (/financial information|management'?s discussion/.test(sec)) {
    score += 1.0;
  }

  if (/revenue from operations/.test(lower)) score += 1.8;
  if (/profit\s+(?:\(loss\)\s+)?(?:for the|after tax|before tax)/.test(lower)) {
    score += 1.6;
  }
  if (/ebitda/.test(lower)) score += 1.4;
  if (/total income|total revenue|net worth|total borrowings/.test(lower)) {
    score += 1.0;
  }
  if (/in\s*(?:₹|rs\.?|inr)?\s*(?:crore|million|lakh)/i.test(text)) {
    score += 1.0;
  }

  const fiscalYearMentions = (
    text.match(/\b(?:FY\s*20\d{2}|202[1-6]|March\s+31,?\s*202[1-6])\b/gi) ?? []
  ).length;
  score += Math.min(fiscalYearMentions, 6) * 0.35;

  const numericTokens = (text.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? []).length;
  score += Math.min(numericTokens, 40) * 0.04;

  // Penalize audit boilerplate / notes without numbers
  if (numericTokens < 6) score -= 1.2;
  if (/independent auditor'?s|chartered accountants/i.test(lower)) score -= 0.8;

  return score;
}

function scoreRiskChunk(text: string, section?: string): number {
  let score = 0;
  const lower = text.toLocaleLowerCase();
  const sec = (section ?? "").toLocaleLowerCase();

  if (/risk factor|internal risk|external risk/.test(sec)) score += 1.6;
  if (/\b\d+\.\s+[A-Z]/.test(text)) score += 0.9; // Numbered risk headings
  if (
    /adversely affect|material adverse effect|litigation|regulatory|license|indebtedness|competition|depend(?:s|ency)|cybersecurity|promoter/.test(
      lower,
    )
  ) {
    score += 0.8;
  }
  if (text.length < 300) score -= 0.7;
  return score;
}

function scoreOverviewChunk(text: string, section?: string): number {
  let score = 0;
  const lower = text.toLocaleLowerCase();
  const sec = (section ?? "").toLocaleLowerCase();

  if (/summary of the offer document|offer document summary|our business/.test(sec)) {
    score += 1.8;
  }
  if (/overview|competitive strengths|business model|products|customers|stores|subscribers/.test(lower)) {
    score += 1.0;
  }
  return score;
}

function scoreIpoChunk(text: string, section?: string): number {
  let score = 0;
  const lower = text.toLocaleLowerCase();
  const sec = (section ?? "").toLocaleLowerCase();

  if (/objects of the (?:offer|issue)|the offer|summary of the offer/.test(sec)) {
    score += 2.0;
  }
  if (/fresh issue/.test(lower)) score += 1.4;
  if (/offer for sale/.test(lower)) score += 1.2;
  if (/net proceeds|objects of the (?:offer|issue)/.test(lower)) score += 1.5;
  if (/face value|price band|bse|nse/.test(lower)) score += 0.9;
  return score;
}

function indexEvidenceByPage(
  evidence: EvidenceChunk[],
): Map<number, EvidenceChunk[]> {
  const byPage = new Map<number, EvidenceChunk[]>();
  for (const chunk of evidence) {
    if (chunk.page === undefined) continue;
    const list = byPage.get(chunk.page) ?? [];
    list.push(chunk);
    byPage.set(chunk.page, list);
  }
  return byPage;
}

function resolveValidPage(
  page: number | undefined,
  byPage: Map<number, EvidenceChunk[]>,
): number | undefined {
  if (page === undefined) return undefined;
  return byPage.has(page) ? page : undefined;
}

function verifyFinancialNumber(
  value: number | undefined,
  pageText: string,
  allText: string,
): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (numberAppearsInText(value, pageText) || numberAppearsInText(value, allText)) {
    return round2(value);
  }
  return undefined;
}

export function numberAppearsInText(value: number, text: string): boolean {
  const abs = Math.abs(value);
  const tokens = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const parsedNumbers: number[] = [];
  for (const token of tokens) {
    const parsed = Number(token.replace(/,/g, ""));
    if (Number.isFinite(parsed)) parsedNumbers.push(parsed);
  }

  // Allow direct match, minor rounding tolerance (1%), or 10x Crore<->Million conversion
  const scales = [1, 10, 0.1];
  for (const scale of scales) {
    const target = abs * scale;
    const tolerance = Math.max(0.15, target * 0.012);
    if (parsedNumbers.some((candidate) => Math.abs(candidate - target) <= tolerance)) {
      return true;
    }
  }
  return false;
}

function normalizeKpis(
  rawKpis: Array<z.infer<typeof rawKpiSchema>>,
  byPage: Map<number, EvidenceChunk[]>,
  limit: number,
): KpiMetric[] {
  const result: KpiMetric[] = [];
  for (const item of rawKpis.slice(0, limit)) {
    if (!item.label || !item.value) continue;
    const cleanedValue = cleanDisclosedValue(item.value);
    if (!cleanedValue) continue;
    const cleanedDelta = cleanDisclosedValue(item.delta);
    const page = resolveValidPage(item.page, byPage);
    const trend = normalizeTrend(item.trend, cleanedDelta);
    result.push({
      label: item.label.slice(0, 60),
      value: cleanedValue.slice(0, 60),
      ...(cleanedDelta ? { delta: cleanedDelta.slice(0, 48) } : {}),
      ...(trend ? { trend } : {}),
      ...(page !== undefined ? { page } : {}),
    });
  }
  return result;
}

function normalizeCitedItems(
  rawItems: Array<z.infer<typeof rawCitedTextSchema>>,
  byPage: Map<number, EvidenceChunk[]>,
  limit: number,
): CitedTextItem[] {
  const result: CitedTextItem[] = [];
  for (const item of rawItems.slice(0, limit)) {
    if (!item.text) continue;
    const page = resolveValidPage(item.page, byPage);
    result.push({
      text: item.text.slice(0, 320),
      ...(page !== undefined ? { page } : {}),
    });
  }
  return result;
}

function normalizeTrend(
  rawTrend: string | undefined,
  delta: string | undefined,
): "up" | "down" | "flat" | undefined {
  const lower = rawTrend?.toLocaleLowerCase();
  if (lower === "up" || lower === "positive" || lower === "growth") return "up";
  if (lower === "down" || lower === "negative" || lower === "decline") {
    return "down";
  }
  if (lower === "flat" || lower === "neutral") return "flat";
  if (delta) {
    if (delta.trim().startsWith("+")) return "up";
    if (delta.trim().startsWith("-")) return "down";
  }
  return undefined;
}

function normalizeRiskCategory(raw: string | undefined): RiskCategory {
  const candidate = (raw ?? "").trim();
  const parsed = riskCategorySchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const lower = candidate.toLocaleLowerCase();
  if (/financ|debt|loss|liquid|credit|capital|cash|margin/.test(lower)) {
    return "Financial";
  }
  if (/regulat|license|tax|govern|statut|compli|policy|spectrum/.test(lower)) {
    return "Regulatory";
  }
  if (/litigat|legal|dispute|court|lawsuit|arbitrat/.test(lower)) {
    return "Litigation";
  }
  if (/market|compet|macro|demand|econom|industry|pric/.test(lower)) {
    return "Market";
  }
  if (/tech|cyber|it\b|data|digital|infra|system/.test(lower)) {
    return "Technology";
  }
  if (/govern|promoter|board|related party|management|conflict/.test(lower)) {
    return "Governance";
  }
  return "Operational";
}

function normalizeRiskSeverity(raw: string | undefined): RiskSeverity {
  const lower = (raw ?? "").toLocaleLowerCase().trim();
  if (lower.startsWith("high") || lower === "critical" || lower === "severe") {
    return "high";
  }
  if (lower.startsWith("low") || lower === "minor") return "low";
  return "medium";
}

function alignKpiUnit(value: string, unit: string): string {
  const lowerUnit = unit.toLocaleLowerCase();
  if (lowerUnit.includes("million") && /\b(?:cr|crores?)\b/i.test(value)) {
    return value.replace(/\b(?:cr|crores?)\b/gi, "Mn");
  }
  if (lowerUnit.includes("crore") && /\b(?:mn|millions?)\b/i.test(value)) {
    return value.replace(/\b(?:mn|millions?)\b/gi, "Cr");
  }
  return value;
}

function cleanDisclosedValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    /^(?:n\/?a|null|none|unknown|not disclosed|not applicable|\[•\]|\[●\]|-+)$/i.test(
      trimmed,
    )
  ) {
    return undefined;
  }
  return trimmed;
}

function cleanCompanyName(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b(?:drhp|rhp|prospectus|final)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function collectReferencedPages(pages: Array<number | undefined>): number[] {
  return [...new Set(pages.filter((p): p is number => p !== undefined))].sort(
    (a, b) => a - b,
  );
}

function buildCitations(
  evidence: EvidenceChunk[],
  referencedPages: number[],
  limit: number,
): Citation[] {
  const preferredPages = new Set(referencedPages);
  const picked: EvidenceChunk[] = [];
  const seenPages = new Set<number>();

  for (const chunk of evidence) {
    if (picked.length >= limit) break;
    if (chunk.page === undefined) continue;
    if (preferredPages.size > 0 && !preferredPages.has(chunk.page)) continue;
    if (seenPages.has(chunk.page)) continue;
    seenPages.add(chunk.page);
    picked.push(chunk);
  }

  for (const chunk of evidence) {
    if (picked.length >= limit) break;
    if (chunk.page === undefined || seenPages.has(chunk.page)) continue;
    seenPages.add(chunk.page);
    picked.push(chunk);
  }

  return picked
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      ...(chunk.page !== undefined ? { page: chunk.page } : {}),
      text: chunk.text.slice(0, 420),
      score: Math.min(1, Math.max(0, round2(chunk.relevanceScore / 5))),
    }));
}

function emptyInsightResponse(
  documentId: string,
  section: InsightSection,
  generatedAt: string,
  filename?: string,
): DocumentInsightResponse {
  const base = {
    documentId,
    status: "unavailable" as const,
    generatedAt,
    citations: [],
    notice: "No indexed pages were found for this section.",
  };

  switch (section) {
    case "financials":
      return {
        ...base,
        section: "financials",
        data: {
          currency: "INR",
          unit: "Crores",
          summary: "Financial data could not be extracted from this document.",
          kpis: [],
          series: [],
          highlights: [],
        },
      };
    case "risks":
      return {
        ...base,
        section: "risks",
        data: {
          summary: "Risk factors could not be extracted from this document.",
          severityCounts: { high: 0, medium: 0, low: 0 },
          categoryCounts: [],
          items: [],
        },
      };
    case "overview":
      return {
        ...base,
        section: "overview",
        data: {
          companyName: cleanCompanyName(filename) ?? "Company Overview",
          summary: "Overview data could not be extracted from this document.",
          keyMetrics: [],
          businessHighlights: [],
          strengths: [],
        },
      };
    case "ipo":
      return {
        ...base,
        section: "ipo",
        data: {
          summary: "IPO offer details could not be extracted from this document.",
          listingExchanges: [],
          useOfProceeds: [],
        },
      };
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
