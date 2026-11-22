import { z } from "zod";

export const documentTypeSchema = z.enum(["generic", "drhp"]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

export const documentStatusSchema = z.enum([
  "queued",
  "processing",
  "ready",
  "failed",
]);

export const createUploadUrlRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    documentType: documentTypeSchema.optional(),
  })
  .strict();

export const uploadUrlResponseSchema = z
  .object({
    documentId: z.string().uuid(),
    uploadUrl: z.string().url(),
    fields: z.record(z.string(), z.string()),
    status: z.literal("queued"),
    createdAt: z.string().datetime(),
  })
  .strict();

export const uploadDocumentResponseSchema = z.object({
  documentId: z.string().uuid(),
  status: z.literal("queued"),
  createdAt: z.string().datetime(),
});

export const getDocumentResponseSchema = z.object({
  documentId: z.string().uuid(),
  filename: z.string(),
  mediaType: z.string(),
  status: documentStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export const listDocumentsResponseSchema = z.object({
  documents: z.array(getDocumentResponseSchema),
});

export const documentFeedbackRequestSchema = z
  .object({
    rating: z.enum(["helpful", "not_helpful"]),
    question: z.string().min(1).max(8_000).refine((value) => value.trim().length > 0),
  })
  .strict();

export const documentFeedbackResponseSchema = z.object({
  feedbackId: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export const queryRequestSchema = z.object({
  question: z.string().min(1).max(8_000).refine((value) => value.trim().length > 0),
  documentIds: z.array(z.string().uuid()).max(100).optional(),
  topK: z.number().int().min(1).max(10).optional(),
  ground_truth: z.string().max(8_000).optional(),
}).strict();

export const citationSchema = z.object({
  chunkId: z.string(),
  page: z.number().int().positive().optional(),
  text: z.string(),
  score: z.number(),
}).strict();

export const queryResponseSchema = z.object({
  question: z.string(),
  answer: z.string(),
  citations: z.array(citationSchema),
  ground_truth: z.string().nullable(),
}).strict();

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export const insightSectionSchema = z.enum([
  "overview",
  "financials",
  "risks",
  "ipo",
]);
export type InsightSection = z.infer<typeof insightSectionSchema>;

export const insightStatusSchema = z.enum(["ready", "partial", "unavailable"]);
export type InsightStatus = z.infer<typeof insightStatusSchema>;

export const citedTextItemSchema = z
  .object({
    text: z.string().min(1),
    page: z.number().int().positive().optional(),
  })
  .strict();

export const kpiMetricSchema = z
  .object({
    label: z.string().min(1),
    value: z.string().min(1),
    delta: z.string().optional(),
    trend: z.enum(["up", "down", "flat"]).optional(),
    page: z.number().int().positive().optional(),
  })
  .strict();

export const financialSeriesPointSchema = z
  .object({
    period: z.string().min(1),
    revenue: z.number().finite().optional(),
    ebitda: z.number().finite().optional(),
    pat: z.number().finite().optional(),
    ebitdaMarginPct: z.number().finite().optional(),
    patMarginPct: z.number().finite().optional(),
    page: z.number().int().positive().optional(),
  })
  .strict();

export const financialsInsightDataSchema = z
  .object({
    currency: z.string().min(1),
    unit: z.string().min(1),
    basis: z.string().optional(),
    summary: z.string(),
    kpis: z.array(kpiMetricSchema),
    series: z.array(financialSeriesPointSchema),
    highlights: z.array(citedTextItemSchema),
  })
  .strict();

export const riskCategorySchema = z.enum([
  "Operational",
  "Financial",
  "Regulatory",
  "Litigation",
  "Market",
  "Technology",
  "Governance",
]);
export type RiskCategory = z.infer<typeof riskCategorySchema>;

export const riskSeveritySchema = z.enum(["high", "medium", "low"]);
export type RiskSeverity = z.infer<typeof riskSeveritySchema>;

export const riskItemSchema = z
  .object({
    title: z.string().min(1),
    category: riskCategorySchema,
    severity: riskSeveritySchema,
    impact: z.string().min(1),
    page: z.number().int().positive(),
    snippet: z.string().optional(),
  })
  .strict();

export const risksInsightDataSchema = z
  .object({
    summary: z.string(),
    severityCounts: z
      .object({
        high: z.number().int().min(0),
        medium: z.number().int().min(0),
        low: z.number().int().min(0),
      })
      .strict(),
    categoryCounts: z.array(
      z
        .object({
          category: riskCategorySchema,
          count: z.number().int().min(0),
        })
        .strict(),
    ),
    items: z.array(riskItemSchema),
  })
  .strict();

export const overviewInsightDataSchema = z
  .object({
    companyName: z.string().min(1),
    sector: z.string().optional(),
    summary: z.string(),
    keyMetrics: z.array(kpiMetricSchema),
    businessHighlights: z.array(citedTextItemSchema),
    strengths: z.array(citedTextItemSchema),
  })
  .strict();

export const useOfProceedsItemSchema = z
  .object({
    purpose: z.string().min(1),
    amount: z.number().finite().nonnegative().optional(),
    amountLabel: z.string().optional(),
    percentage: z.number().finite().min(0).max(100).optional(),
    page: z.number().int().positive().optional(),
  })
  .strict();

export const ipoInsightDataSchema = z
  .object({
    summary: z.string(),
    currency: z.string().optional(),
    unit: z.string().optional(),
    issueSize: z.string().optional(),
    freshIssueAmount: z.string().optional(),
    ofsAmount: z.string().optional(),
    freshIssuePct: z.number().finite().min(0).max(100).optional(),
    ofsPct: z.number().finite().min(0).max(100).optional(),
    priceBand: z.string().optional(),
    faceValue: z.string().optional(),
    lotSize: z.string().optional(),
    listingExchanges: z.array(z.string()),
    useOfProceeds: z.array(useOfProceedsItemSchema),
  })
  .strict();

const baseInsightResponseFields = {
  documentId: z.string().uuid(),
  status: insightStatusSchema,
  generatedAt: z.string().datetime(),
  citations: z.array(citationSchema),
  notice: z.string().optional(),
};

export const documentInsightResponseSchema = z.discriminatedUnion("section", [
  z
    .object({
      ...baseInsightResponseFields,
      section: z.literal("financials"),
      data: financialsInsightDataSchema,
    })
    .strict(),
  z
    .object({
      ...baseInsightResponseFields,
      section: z.literal("risks"),
      data: risksInsightDataSchema,
    })
    .strict(),
  z
    .object({
      ...baseInsightResponseFields,
      section: z.literal("overview"),
      data: overviewInsightDataSchema,
    })
    .strict(),
  z
    .object({
      ...baseInsightResponseFields,
      section: z.literal("ipo"),
      data: ipoInsightDataSchema,
    })
    .strict(),
]);

export const refreshInsightRequestSchema = z
  .object({
    section: insightSectionSchema,
  })
  .strict();

export type DocumentStatus = z.infer<typeof documentStatusSchema>;
export type CreateUploadUrlRequest = z.infer<
  typeof createUploadUrlRequestSchema
>;
export type UploadUrlResponse = z.infer<typeof uploadUrlResponseSchema>;
export type UploadDocumentResponse = z.infer<
  typeof uploadDocumentResponseSchema
>;
export type GetDocumentResponse = z.infer<typeof getDocumentResponseSchema>;
export type ListDocumentsResponse = z.infer<
  typeof listDocumentsResponseSchema
>;
export type DocumentFeedbackRequest = z.infer<
  typeof documentFeedbackRequestSchema
>;
export type DocumentFeedbackResponse = z.infer<
  typeof documentFeedbackResponseSchema
>;
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type QueryResponse = z.infer<typeof queryResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type KpiMetric = z.infer<typeof kpiMetricSchema>;
export type CitedTextItem = z.infer<typeof citedTextItemSchema>;
export type FinancialSeriesPoint = z.infer<typeof financialSeriesPointSchema>;
export type FinancialsInsightData = z.infer<typeof financialsInsightDataSchema>;
export type RiskItem = z.infer<typeof riskItemSchema>;
export type RisksInsightData = z.infer<typeof risksInsightDataSchema>;
export type OverviewInsightData = z.infer<typeof overviewInsightDataSchema>;
export type UseOfProceedsItem = z.infer<typeof useOfProceedsItemSchema>;
export type IpoInsightData = z.infer<typeof ipoInsightDataSchema>;
export type DocumentInsightResponse = z.infer<
  typeof documentInsightResponseSchema
>;
export type RefreshInsightRequest = z.infer<typeof refreshInsightRequestSchema>;
