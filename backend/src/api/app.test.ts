import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { RagDatabase } from "../infrastructure/mongo.js";
import type { OllamaClient } from "../infrastructure/ollama.js";
import type { FileStorage } from "../services/ingestion.js";

process.env.AUTH_MODE = "cognito";
process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
process.env.COGNITO_CLIENT_ID = "test-client";
process.env.VECTOR_SEARCH_MODE = "mongodb";

const { buildApp } = await import("./app.js");

const ownedId = "550e8400-e29b-41d4-a716-446655440000";
const otherId = "550e8400-e29b-41d4-a716-446655440001";
const now = new Date("2026-11-15T00:00:00.000Z");
const ownedDocument = {
  documentId: ownedId,
  ownerId: "user-a",
  filename: "prospectus.pdf",
  mediaType: "application/pdf",
  extension: ".pdf",
  storagePath: "/tmp/prospectus.pdf",
  status: "ready" as const,
  createdAt: now,
  updatedAt: now,
};

let app: FastifyInstance;
let listOwner: string | undefined;
let documentOwner: string | undefined;
let createdDocument:
  | {
      documentId: string;
      ownerId?: string;
      filename: string;
      extension: string;
      documentType?: "generic" | "drhp";
      storagePath: string;
      status: string;
    }
  | undefined;
let presignedUpload:
  | {
      documentId: string;
      extension: string;
      contentType: string;
    }
  | undefined;
let storedFeedback:
  | {
      ownerId: string;
      documentId: string;
      questionHash: string;
      rating: "helpful" | "not_helpful";
    }
  | undefined;
const searchedDocumentIds: string[][] = [];
const deletionOrder: string[] = [];
let removedStoragePath: string | undefined;
let storageDeleteError: Error | undefined;

before(async () => {
  const database = {
    listDocuments: async (ownerId: string) => {
      listOwner = ownerId;
      return ownerId === "user-a" ? [ownedDocument] : [];
    },
    getDocumentForOwner: async (documentId: string, ownerId: string) => {
      documentOwner = ownerId;
      return ownerId === "user-a" && documentId === ownedId
        ? ownedDocument
        : null;
    },
    listDocumentIds: async (ownerId: string) =>
      ownerId === "user-a" ? [ownedId] : [],
    deleteDocument: async (documentId: string, ownerId: string) => {
      deletionOrder.push("mongodb");
      return ownerId === "user-a" && documentId === ownedId
        ? ownedDocument
        : null;
    },
    createFeedback: async (feedback: typeof storedFeedback) => {
      storedFeedback = feedback;
    },
    createDocumentAndJob: async (document: typeof createdDocument) => {
      createdDocument = document;
    },
    getDocument: async () => null,
    updateDocument: async () => {},
    ping: async () => {},
    searchChunks: async (
      _embedding: number[],
      _topK: number,
      documentIds?: string[],
    ) => {
      searchedDocumentIds.push(documentIds ?? []);
      return [];
    },
    searchChunksExact: async (
      _embedding: number[],
      _topK: number,
      _maxChunks: number,
      documentIds?: string[],
    ) => {
      searchedDocumentIds.push(documentIds ?? []);
      return [];
    },
    searchChunksLexical: async (
      _query: string,
      _topK: number,
      documentIds?: string[],
    ) => {
      searchedDocumentIds.push(documentIds ?? []);
      return [];
    },
    scoreChunks: async () => [],
    getInsight: async () => null,
    upsertInsight: async () => {},
    findChunksByDocument: async () => [],
  } as unknown as RagDatabase;
  const ollama = {
    embed: async (texts: string[]) => texts.map(() => [1, 0]),
  } as unknown as OllamaClient;
  const storage = {
    remove: async (storagePath: string) => {
      deletionOrder.push("storage");
      if (storageDeleteError) throw storageDeleteError;
      removedStoragePath = storagePath;
    },
  } as unknown as FileStorage;
  app = buildApp({
    database,
    model: ollama,
    storage,
    presignedUploads: {
      create: async (input) => {
        presignedUpload = input;
        return {
          storagePath: `documents/${input.documentId}${input.extension}`,
          uploadUrl: "https://uploads.example.com",
          fields: {
            key: `documents/${input.documentId}${input.extension}`,
            "Content-Type": input.contentType,
          },
        };
      },
    },
    authenticate: async (token) => {
      if (token !== "valid-token") throw new Error("Invalid test token");
      return "user-a";
    },
  });
  await app.ready();
});

after(async () => {
  await app.close();
});

test("Cognito-protected routes reject missing and invalid access tokens", async () => {
  const missing = await app.inject({
    method: "GET",
    url: "/api/v1/documents",
  });
  const invalid = await app.inject({
    method: "GET",
    url: "/api/v1/documents",
    headers: { authorization: "Bearer invalid-token" },
  });

  assert.equal(missing.statusCode, 401);
  assert.equal(invalid.statusCode, 401);
});

test("document listing is scoped to the verified Cognito subject", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/documents",
    headers: { authorization: "Bearer valid-token" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(listOwner, "user-a");
  assert.deepEqual(
    response.json().documents.map(
      (document: { documentId: string }) => document.documentId,
    ),
    [ownedId],
  );
});

test("presigned upload requests create an owner-scoped document reservation", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/documents/upload-url",
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
    },
    payload: {
      fileName: "prospectus.pdf",
      documentType: "drhp",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().status, "queued");
  assert.equal(response.json().uploadUrl, "https://uploads.example.com");
  assert.equal(presignedUpload?.extension, ".pdf");
  assert.equal(presignedUpload?.contentType, "application/pdf");
  assert.equal(createdDocument?.ownerId, "user-a");
  assert.equal(createdDocument?.filename, "prospectus.pdf");
  assert.equal(createdDocument?.documentType, "drhp");
  assert.equal(createdDocument?.status, "queued");
});

test("presigned DRHP uploads reject non-PDF files", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/documents/upload-url",
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
    },
    payload: {
      fileName: "prospectus.docx",
      documentType: "drhp",
    },
  });

  assert.equal(response.statusCode, 415);
  assert.equal(response.json().error.code, "UNSUPPORTED_DOCUMENT_TYPE");
});

test("document reads and queries cannot access another user's uploads", async () => {
  const readResponse = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${otherId}`,
    headers: { authorization: "Bearer valid-token" },
  });
  const queryResponse = await app.inject({
    method: "POST",
    url: "/api/v1/query",
    headers: { authorization: "Bearer valid-token" },
    payload: {
      question: "Summarize this document",
      documentIds: [otherId],
    },
  });

  assert.equal(readResponse.statusCode, 404);
  assert.equal(documentOwner, "user-a");
  assert.equal(queryResponse.statusCode, 404);
});

test("deleting an owned DRHP removes its stored file before MongoDB records", async () => {
  deletionOrder.length = 0;
  removedStoragePath = undefined;

  const response = await app.inject({
    method: "DELETE",
    url: `/api/v1/documents/${ownedId}`,
    headers: { authorization: "Bearer valid-token" },
  });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(deletionOrder, ["storage", "mongodb"]);
  assert.equal(removedStoragePath, ownedDocument.storagePath);
});

test("deleting another user's DRHP does not remove its file", async () => {
  deletionOrder.length = 0;
  removedStoragePath = undefined;

  const response = await app.inject({
    method: "DELETE",
    url: `/api/v1/documents/${otherId}`,
    headers: { authorization: "Bearer valid-token" },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(deletionOrder, []);
  assert.equal(removedStoragePath, undefined);
});

test("a storage cleanup failure preserves the MongoDB records for retry", async () => {
  deletionOrder.length = 0;
  storageDeleteError = new Error("S3 unavailable");

  const response = await app.inject({
    method: "DELETE",
    url: `/api/v1/documents/${ownedId}`,
    headers: { authorization: "Bearer valid-token" },
  });

  storageDeleteError = undefined;
  assert.equal(response.statusCode, 500);
  assert.deepEqual(deletionOrder, ["storage"]);
});

test("queries without document IDs are restricted to the authenticated user's library", async () => {
  searchedDocumentIds.length = 0;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/query",
    headers: { authorization: "Bearer valid-token" },
    payload: { question: "Summarize this document" },
  });

  assert.equal(response.statusCode, 200);
  assert.ok(searchedDocumentIds.length > 0);
  assert.ok(searchedDocumentIds.every((ids) => ids.length === 1 && ids[0] === ownedId));
});

test("feedback is persisted only for a document owned by the authenticated user", async () => {
  const allowed = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${ownedId}/feedback`,
    headers: { authorization: "Bearer valid-token" },
    payload: {
      rating: "helpful",
      question: "What is the IPO size?",
    },
  });
  const forbidden = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${otherId}/feedback`,
    headers: { authorization: "Bearer valid-token" },
    payload: {
      rating: "not_helpful",
      question: "What is the IPO size?",
    },
  });

  assert.equal(allowed.statusCode, 202);
  assert.equal(forbidden.statusCode, 404);
  assert.equal(storedFeedback?.ownerId, "user-a");
  assert.equal(storedFeedback?.documentId, ownedId);
  assert.equal(storedFeedback?.rating, "helpful");
  assert.notEqual(storedFeedback?.questionHash, "What is the IPO size?");
});

test("insights endpoint validates section, enforces ownership, and returns structured payload", async () => {
  const invalidSection = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${ownedId}/insights?section=invalid`,
    headers: { authorization: "Bearer valid-token" },
  });
  const forbidden = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${otherId}/insights?section=financials`,
    headers: { authorization: "Bearer valid-token" },
  });
  const valid = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${ownedId}/insights?section=financials`,
    headers: { authorization: "Bearer valid-token" },
  });

  assert.equal(invalidSection.statusCode, 400);
  assert.equal(forbidden.statusCode, 404);
  assert.equal(valid.statusCode, 200);
  const body = valid.json() as { section: string; status: string };
  assert.equal(body.section, "financials");
  assert.equal(body.status, "unavailable");
});
