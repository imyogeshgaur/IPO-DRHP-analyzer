import assert from "node:assert/strict";
import test from "node:test";
import {
  documentFeedbackRequestSchema,
  documentFeedbackResponseSchema,
  documentTypeSchema,
  getDocumentResponseSchema,
  listDocumentsResponseSchema,
  queryRequestSchema,
  queryResponseSchema,
  uploadDocumentResponseSchema,
} from "./contracts.js";

test("mobile upload and query contract shapes remain validated", () => {
  assert.equal(documentTypeSchema.safeParse("generic").success, true);
  assert.equal(documentTypeSchema.safeParse("drhp").success, true);
  assert.equal(documentTypeSchema.safeParse("unknown").success, false);

  assert.equal(
    uploadDocumentResponseSchema.safeParse({
      documentId: "550e8400-e29b-41d4-a716-446655440000",
      status: "queued",
      createdAt: "2026-11-15T00:00:00.000Z",
    }).success,
    true,
  );

  assert.equal(
    queryRequestSchema.safeParse({
      question: "What is the revenue?",
      documentIds: ["550e8400-e29b-41d4-a716-446655440000"],
      topK: 5,
      ground_truth: "Revenue is not stated.",
    }).success,
    true,
  );

  assert.equal(
    queryResponseSchema.safeParse({
      question: "What is the annual revenue?",
      answer: "Revenue was reported in the annual report. [1]",
      citations: [
        {
          chunkId: "chunk-1",
          page: 56,
          text: "Revenue: 42 million.",
          score: 0.91,
        },
      ],
      ground_truth: null,
    }).success,
    true,
  );

  assert.equal(
    queryResponseSchema.safeParse({
      question: "What is the annual revenue?",
      answer: "Revenue was reported.",
      citations: [
        {
          documentId: "550e8400-e29b-41d4-a716-446655440000",
          filename: "annual-report.pdf",
          chunkId: "chunk-1",
          text: "Revenue: 42 million.",
          score: 0.91,
        },
      ],
      requestId: "req-1",
      ground_truth: null,
    }).success,
    false,
  );

  assert.equal(
    queryResponseSchema.safeParse({
      question: "What is the annual revenue?",
      answer: "Revenue was reported.",
      citations: [
        {
          chunkId: "chunk-1",
          page: 0,
          text: "Revenue: 42 million.",
          score: 0.91,
        },
      ],
      ground_truth: null,
    }).success,
    false,
  );

  assert.equal(
    queryRequestSchema.safeParse({ question: " " }).success,
    false,
  );
});

test("document response supports a stable status and optional extraction error", () => {
  assert.equal(
    documentFeedbackRequestSchema.safeParse({
      rating: "helpful",
      question: "Was the IPO price band disclosed?",
    }).success,
    true,
  );
  assert.equal(
    documentFeedbackRequestSchema.safeParse({
      rating: "unknown",
      question: "Was the IPO price band disclosed?",
    }).success,
    false,
  );
  assert.equal(
    documentFeedbackResponseSchema.safeParse({
      feedbackId: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: "2026-11-15T00:00:00.000Z",
    }).success,
    true,
  );

  assert.equal(
    getDocumentResponseSchema.safeParse({
      documentId: "550e8400-e29b-41d4-a716-446655440000",
      filename: "manual.pdf",
      mediaType: "application/pdf",
      status: "failed",
      createdAt: "2026-11-15T00:00:00.000Z",
      updatedAt: "2026-11-15T00:01:00.000Z",
      error: { code: "EMPTY_DOCUMENT", message: "No text found" },
    }).success,
    true,
  );

  assert.equal(
    listDocumentsResponseSchema.safeParse({
      documents: [
        {
          documentId: "550e8400-e29b-41d4-a716-446655440000",
          filename: "prospectus.pdf",
          mediaType: "application/pdf",
          status: "ready",
          createdAt: "2026-11-15T00:00:00.000Z",
          updatedAt: "2026-11-15T00:01:00.000Z",
        },
      ],
    }).success,
    true,
  );
});
