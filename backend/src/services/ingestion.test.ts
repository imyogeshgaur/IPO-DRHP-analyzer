import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocumentRecord, RagDatabase } from "../infrastructure/mongo.js";
import type { GroundedModelClient } from "../infrastructure/ollama.js";
import { AppError } from "../shared/errors.js";
import { IngestionService } from "./ingestion.js";

const documentId = "550e8400-e29b-41d4-a716-446655440000";
const document: DocumentRecord = {
  documentId,
  ownerId: "user-a",
  filename: "prospectus.pdf",
  mediaType: "application/pdf",
  extension: ".pdf",
  storagePath: `documents/${documentId}.pdf`,
  status: "queued",
  createdAt: new Date("2026-11-22T00:00:00.000Z"),
  updatedAt: new Date("2026-11-22T00:00:00.000Z"),
};

function createService(database: object): IngestionService {
  return new IngestionService(
    database as RagDatabase,
    { embed: async () => [] } as Pick<GroundedModelClient, "embed">,
    {
      save: async () => document.storagePath,
      remove: async () => {},
    },
  );
}

test("duplicate S3 notifications do not reload an already-claimed document", async () => {
  let loadCount = 0;
  const service = createService({
    claimJobForDocument: async () => null,
  });

  await service.processQueuedDocument(documentId, async () => {
    loadCount += 1;
    return { path: "/tmp/document.pdf", cleanup: async () => {} };
  });

  assert.equal(loadCount, 0);
});

test("transient ingestion failures requeue the job for SQS retry", async () => {
  const documentStatuses: string[] = [];
  let retryCount = 0;
  let failedCount = 0;
  const service = createService({
    claimJobForDocument: async () => ({
      jobId: "job-1",
      documentId,
      status: "processing",
      attempts: 1,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }),
    getDocument: async () => document,
    updateDocument: async (_id: string, update: Partial<DocumentRecord>) => {
      if (update.status) documentStatuses.push(update.status);
    },
    retryJob: async () => {
      retryCount += 1;
    },
    failJob: async () => {
      failedCount += 1;
    },
  });

  await assert.rejects(
    service.processQueuedDocument(documentId, async () => {
      throw new Error("temporary S3 read failure");
    }),
    /temporary S3 read failure/,
  );

  assert.deepEqual(documentStatuses, ["processing", "queued"]);
  assert.equal(retryCount, 1);
  assert.equal(failedCount, 0);
});

test("permanent document errors fail without consuming SQS retries", async () => {
  const documentStatuses: string[] = [];
  let retryCount = 0;
  let failedCount = 0;
  const service = createService({
    claimJobForDocument: async () => ({
      jobId: "job-1",
      documentId,
      status: "processing",
      attempts: 1,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }),
    getDocument: async () => document,
    updateDocument: async (_id: string, update: Partial<DocumentRecord>) => {
      if (update.status) documentStatuses.push(update.status);
    },
    retryJob: async () => {
      retryCount += 1;
    },
    failJob: async () => {
      failedCount += 1;
    },
  });

  await service.processQueuedDocument(documentId, async () => {
    throw new AppError(
      "DRHP_PAGE_LIMIT_EXCEEDED",
      "Too many pages",
      413,
    );
  });

  assert.deepEqual(documentStatuses, ["processing", "failed"]);
  assert.equal(retryCount, 0);
  assert.equal(failedCount, 1);
});

test("the final SQS attempt marks the document failed before returning the error", async () => {
  const documentStatuses: string[] = [];
  let failedCount = 0;
  const service = createService({
    claimJobForDocument: async () => ({
      jobId: "job-1",
      documentId,
      status: "processing",
      attempts: 3,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }),
    getDocument: async () => document,
    updateDocument: async (_id: string, update: Partial<DocumentRecord>) => {
      if (update.status) documentStatuses.push(update.status);
    },
    retryJob: async () => {},
    failJob: async () => {
      failedCount += 1;
    },
  });

  await assert.rejects(
    service.processQueuedDocument(documentId, async () => {
      throw new Error("permanent S3 read failure");
    }),
    /permanent S3 read failure/,
  );

  assert.deepEqual(documentStatuses, ["processing", "failed"]);
  assert.equal(failedCount, 1);
});
