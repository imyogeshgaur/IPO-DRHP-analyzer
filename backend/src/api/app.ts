import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import path from "node:path";
import {
  getDocumentResponseSchema,
  queryRequestSchema,
  queryResponseSchema,
  uploadDocumentResponseSchema,
  documentTypeSchema,
  type ErrorResponse,
  type GetDocumentResponse,
  type QueryResponse,
  type UploadDocumentResponse,
} from "../contracts/contracts.js";
import { config } from "../config/config.js";
import { AppError } from "../shared/errors.js";
import { FileStorage, IngestionService } from "../services/ingestion.js";
import { RagDatabase } from "../infrastructure/mongo.js";
import { OllamaClient } from "../infrastructure/ollama.js";
import { QueryService, queryFailureResponse } from "../services/query.js";
import { supportedExtensions } from "../documents/parsers.js";

export type AppDependencies = {
  database: RagDatabase;
  ollama: OllamaClient;
  storage: FileStorage;
};

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });
  const ingestion = new IngestionService(
    dependencies.database,
    dependencies.ollama,
    dependencies.storage,
  );
  const queries = new QueryService(
    dependencies.database,
    dependencies.ollama,
    (event, fields) => app.log.info(fields, event),
  );

  app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!config.apiKey || request.url === "/health" || request.url === "/ready") {
      return;
    }
    if (request.headers.authorization !== `Bearer ${config.apiKey}`) {
      await reply.code(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "A valid bearer token is required",
          requestId: request.id,
        },
      } satisfies ErrorResponse);
    }
  });

  app.get("/health", async () => ({ status: "ok" as const }));
  app.get("/ready", async (_request, reply) => {
    try {
      await dependencies.database.ping();
      const [probeEmbedding] = await dependencies.ollama.embed([
        "readiness probe",
      ]);
      if (!probeEmbedding) {
        throw new AppError(
          "INVALID_EMBEDDING_RESPONSE",
          "Ollama returned no readiness embedding",
          503,
        );
      }
      if (config.vectorSearchMode === "mongodb") {
        await dependencies.database.searchChunks(probeEmbedding, 1);
      }
      return { status: "ready" as const };
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send({ status: "not_ready" as const });
    }
  });

  app.post<{ Reply: UploadDocumentResponse }>(
    "/api/v1/documents",
    async (request, reply) => {
      const file = await request.file();
      if (!file) {
        throw new AppError("FILE_REQUIRED", "A file upload is required", 400);
      }
      if (file.fieldname !== "file") {
        throw new AppError(
          "INVALID_FILE_FIELD",
          'The uploaded file must use the "file" field',
          400,
        );
      }
      const filename = path.basename(file.filename).slice(0, 255);
      const extension = path.extname(filename).toLowerCase();
      if (!supportedExtensions().includes(extension)) {
        throw new AppError(
          "UNSUPPORTED_FILE_TYPE",
          `Unsupported file extension. Supported extensions: ${supportedExtensions().join(", ")}`,
          415,
        );
      }

      const requestedDocumentType = request.headers["x-document-type"];
      const parsedDocumentType =
        requestedDocumentType === undefined
          ? undefined
          : documentTypeSchema.safeParse(requestedDocumentType);
      if (parsedDocumentType && !parsedDocumentType.success) {
        throw new AppError(
          "INVALID_DOCUMENT_TYPE",
          'The "x-document-type" header must be "generic" or "drhp"',
          400,
        );
      }
      if (
        parsedDocumentType?.success &&
        parsedDocumentType.data === "drhp" &&
        extension !== ".pdf"
      ) {
        throw new AppError(
          "UNSUPPORTED_DOCUMENT_TYPE",
          "DRHP-specific processing is currently supported for PDF files only",
          415,
        );
      }

      const data = await file.toBuffer();
      const document = await ingestion.enqueue(
        filename,
        extension,
        data,
        parsedDocumentType?.data,
      );
      const response = {
        documentId: document.documentId,
        status: "queued",
        createdAt: document.createdAt.toISOString(),
      } satisfies UploadDocumentResponse;
      uploadDocumentResponseSchema.parse(response);
      return reply.code(202).send(response);
    },
  );

  app.get<{ Params: { documentId: string }; Reply: GetDocumentResponse | ErrorResponse }>(
    "/api/v1/documents/:documentId",
    async (request, reply) => {
      const documentId = validateDocumentId(request.params.documentId);
      const document = await dependencies.database.getDocument(documentId);
      if (!document) {
        return reply.code(404).send({
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "Document not found",
            requestId: request.id,
          },
        });
      }

      const response: GetDocumentResponse = {
        documentId: document.documentId,
        filename: document.filename,
        mediaType: document.mediaType,
        status: document.status,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
        ...(document.error ? { error: document.error } : {}),
      };
      getDocumentResponseSchema.parse(response);
      return response;
    },
  );

  app.delete<{ Params: { documentId: string } }>(
    "/api/v1/documents/:documentId",
    async (request, reply) => {
      const documentId = validateDocumentId(request.params.documentId);
      const document = await dependencies.database.deleteDocument(documentId);
      if (!document) {
        return reply.code(404).send({
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "Document not found",
            requestId: request.id,
          },
        });
      }
      await dependencies.storage.remove(document.storagePath);
      return reply.code(204).send();
    },
  );

  app.post<{ Body: unknown; Reply: QueryResponse | ErrorResponse }>(
    "/api/v1/query",
    async (request, reply) => {
      const parsedRequest = queryRequestSchema.safeParse(request.body);
      if (!parsedRequest.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: parsedRequest.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
            requestId: request.id,
          },
        });
      }
      if (
        parsedRequest.data.ground_truth !== undefined &&
        !config.evaluationMode
      ) {
        return reply.code(400).send({
          error: {
            code: "EVALUATION_MODE_DISABLED",
            message: "ground_truth is accepted only when evaluation mode is enabled",
            requestId: request.id,
          },
        });
      }
      try {
        const response = await queries.query(parsedRequest.data);
        queryResponseSchema.parse(response);
        return response;
      } catch (error) {
        app.log.error(
          { err: error, requestId: request.id },
          "Query processing failed",
        );
        const statusCode =
          error instanceof AppError ? error.statusCode : 500;
        const failureResponse: QueryResponse = queryFailureResponse(
          parsedRequest.data,
        );
        return reply.code(statusCode).send(failureResponse);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
        },
      } satisfies ErrorResponse);
    }

    const errorStatusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const statusCode =
      errorStatusCode >= 400 && errorStatusCode < 500
        ? errorStatusCode
        : 500;
    app.log.error(error);
    return reply.code(statusCode).send({
      error: {
        code:
          statusCode === 413
            ? "UPLOAD_TOO_LARGE"
            : statusCode === 500
              ? "INTERNAL_ERROR"
              : "BAD_REQUEST",
        message:
          statusCode === 413
            ? "The uploaded file exceeds the configured size limit"
            : statusCode === 500
              ? "An unexpected error occurred"
              : "The request could not be processed",
        requestId: request.id,
      },
    } satisfies ErrorResponse);
  });

  return app;
}

function validateDocumentId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError("INVALID_DOCUMENT_ID", "Document ID must be a UUID", 400);
  }
  return value;
}
