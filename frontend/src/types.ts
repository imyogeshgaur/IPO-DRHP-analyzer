export type DocumentStatus = "queued" | "processing" | "ready" | "failed";

export type DocumentRecord = {
  documentId: string;
  filename: string;
  mediaType: string;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
  error?: {
    code: string;
    message: string;
  };
};

export type Citation = {
  chunkId: string;
  page?: number;
  text: string;
  score: number;
};

export type QueryResponse = {
  question: string;
  answer: string;
  citations: Citation[];
  ground_truth: string | null;
};

export type InsightSection = "overview" | "financials" | "risks" | "ipo";
export type InsightStatus = "ready" | "partial" | "unavailable";

export type CitedTextItem = {
  text: string;
  page?: number;
};

export type KpiMetric = {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down" | "flat";
  page?: number;
};

export type FinancialSeriesPoint = {
  period: string;
  revenue?: number;
  ebitda?: number;
  pat?: number;
  ebitdaMarginPct?: number;
  patMarginPct?: number;
  page?: number;
};

export type FinancialsInsightData = {
  currency: string;
  unit: string;
  basis?: string;
  summary: string;
  kpis: KpiMetric[];
  series: FinancialSeriesPoint[];
  highlights: CitedTextItem[];
};

export type RiskCategory =
  | "Operational"
  | "Financial"
  | "Regulatory"
  | "Litigation"
  | "Market"
  | "Technology"
  | "Governance";

export type RiskSeverity = "high" | "medium" | "low";

export type RiskItem = {
  title: string;
  category: RiskCategory;
  severity: RiskSeverity;
  impact: string;
  page: number;
  snippet?: string;
};

export type RisksInsightData = {
  summary: string;
  severityCounts: {
    high: number;
    medium: number;
    low: number;
  };
  categoryCounts: Array<{
    category: RiskCategory;
    count: number;
  }>;
  items: RiskItem[];
};

export type OverviewInsightData = {
  companyName: string;
  sector?: string;
  summary: string;
  keyMetrics: KpiMetric[];
  businessHighlights: CitedTextItem[];
  strengths: CitedTextItem[];
};

export type UseOfProceedsItem = {
  purpose: string;
  amount?: number;
  amountLabel?: string;
  percentage?: number;
  page?: number;
};

export type IpoInsightData = {
  summary: string;
  currency?: string;
  unit?: string;
  issueSize?: string;
  freshIssueAmount?: string;
  ofsAmount?: string;
  freshIssuePct?: number;
  ofsPct?: number;
  priceBand?: string;
  faceValue?: string;
  lotSize?: string;
  listingExchanges: string[];
  useOfProceeds: UseOfProceedsItem[];
};

type BaseInsightResponse = {
  documentId: string;
  status: InsightStatus;
  generatedAt: string;
  citations: Citation[];
  notice?: string;
};

export type DocumentInsightResponse =
  | (BaseInsightResponse & {
      section: "financials";
      data: FinancialsInsightData;
    })
  | (BaseInsightResponse & {
      section: "risks";
      data: RisksInsightData;
    })
  | (BaseInsightResponse & {
      section: "overview";
      data: OverviewInsightData;
    })
  | (BaseInsightResponse & {
      section: "ipo";
      data: IpoInsightData;
    });
