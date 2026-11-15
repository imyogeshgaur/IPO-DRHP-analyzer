import { z } from "zod";

export const documentTypeSchema = z.enum(["generic", "drhp"]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

export const documentStatusSchema = z.enum([
  "queued",
  "processing",
  "ready",
  "failed",
]);

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

export type DocumentStatus = z.infer<typeof documentStatusSchema>;
export type UploadDocumentResponse = z.infer<
  typeof uploadDocumentResponseSchema
>;
export type GetDocumentResponse = z.infer<typeof getDocumentResponseSchema>;
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type QueryResponse = z.infer<typeof queryResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
