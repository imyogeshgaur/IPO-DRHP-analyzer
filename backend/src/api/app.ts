import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  documentFeedbackRequestSchema,
  documentFeedbackResponseSchema,
  documentInsightResponseSchema,
  createUploadUrlRequestSchema,
  getDocumentResponseSchema,
  insightSectionSchema,
  listDocumentsResponseSchema,
  queryRequestSchema,
  queryResponseSchema,
  refreshInsightRequestSchema,
  uploadDocumentResponseSchema,
  uploadUrlResponseSchema,
  documentTypeSchema,
  type DocumentInsightResponse,
  type ErrorResponse,
  type DocumentFeedbackResponse,
  type GetDocumentResponse,
  type ListDocumentsResponse,
  type QueryResponse,
  type UploadDocumentResponse,
  type UploadUrlResponse,
} from "../contracts/contracts.js";
import { config } from "../config/config.js";
import { AppError } from "../shared/errors.js";
import {
  type DocumentStorage,
  IngestionService,
} from "../services/ingestion.js";
import { DrhpInsightsService } from "../services/insights.js";
import {
  RagDatabase,
  type DocumentRecord,
} from "../infrastructure/mongo.js";
import { GroundedModelClient } from "../infrastructure/ollama.js";
import { QueryService, queryFailureResponse } from "../services/query.js";
import { supportedExtensions } from "../documents/parsers.js";
import {
  createCognitoAuthenticator,
  type AccessTokenAuthenticator,
} from "../auth/cognito.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
  }
}

export type AppDependencies = {
  database: RagDatabase;
  model?: GroundedModelClient;
  storage: DocumentStorage;
  presignedUploads?: PresignedUploadCreator;
  authenticate?: AccessTokenAuthenticator;
};

export type PresignedUploadCreator = {
  create(input: {
    documentId: string;
    extension: string;
    contentType: string;
  }): Promise<{
    storagePath: string;
    uploadUrl: string;
    fields: Record<string, string>;
  }>;
};

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });
  app.decorateRequest("userId", null);
  const insights = dependencies.model
    ? new DrhpInsightsService(
        dependencies.database,
        dependencies.model,
        (event, fields) => app.log.info(fields, event),
      )
    : undefined;
  const ingestion = dependencies.model
    ? new IngestionService(
        dependencies.database,
        dependencies.model,
        dependencies.storage,
        insights,
      )
    : undefined;
  const queries = dependencies.model
    ? new QueryService(
        dependencies.database,
        dependencies.model,
        (event, fields) => app.log.info(fields, event),
      )
    : undefined;
  const authenticate =
    dependencies.authenticate ?? configuredAuthenticator();
  const presignedUploads = dependencies.presignedUploads;

  if (config.uploadMode === "local") {
    if (!ingestion) {
      throw new Error("Ollama is required when UPLOAD_MODE=local");
    }
    app.register(multipart, {
      limits: { fileSize: config.maxUploadBytes, files: 1 },
    });
  }
  if (config.uploadMode === "s3" && !dependencies.presignedUploads) {
    throw new Error("A presigned upload service is required when UPLOAD_MODE=s3");
  }

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health" || request.url === "/ready") {
      return;
    }
    const authorization = request.headers.authorization;
    if (config.authMode === "local") {
      if (config.apiKey && authorization !== `Bearer ${config.apiKey}`) {
        await reply.code(401).send({
          error: {
            code: "UNAUTHORIZED",
            message: "A valid bearer token is required",
            requestId: request.id,
          },
        } satisfies ErrorResponse);
        return;
      }
      request.userId = "local";
      return;
    }

    const accessToken = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!accessToken || !authenticate) {
      await reply.code(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "A valid Cognito access token is required",
          requestId: request.id,
        },
      } satisfies ErrorResponse);
      return;
    }
    try {
      request.userId = await authenticate(accessToken);
    } catch {
      app.log.warn({ requestId: request.id }, "Access token rejected");
      await reply.code(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "A valid Cognito access token is required",
          requestId: request.id,
        },
      } satisfies ErrorResponse);
    }
  });

  app.get("/health", async () => ({ status: "ok" as const }));
  app.get("/ready", async (_request, reply) => {
    try {
      await dependencies.database.ping();
      if (!dependencies.model) {
        throw new AppError(
          "QUERY_NOT_CONFIGURED",
          "Query processing is not configured",
          503,
        );
      }
      const [probeEmbedding] = await dependencies.model.embed([
        "readiness probe",
      ]);
      if (!probeEmbedding) {
        throw new AppError(
          "INVALID_EMBEDDING_RESPONSE",
          "The model provider returned no readiness embedding",
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

  if (config.uploadMode === "local") {
    const localIngestion = ingestion;
    if (!localIngestion) {
      throw new Error("Ollama is required when UPLOAD_MODE=local");
    }
    app.post<{ Reply: UploadDocumentResponse }>(
      "/api/v1/documents",
      async (request, reply) => {
        const file = await request.file();
        if (!file) {
          throw new AppError(
            "FILE_REQUIRED",
            "A file upload is required",
            400,
          );
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
        const document = await localIngestion.enqueue(
          filename,
          extension,
          data,
          parsedDocumentType?.data,
          getAuthenticatedUserId(request),
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
  }

  if (presignedUploads) {
    app.post<{ Body: unknown; Reply: UploadUrlResponse | ErrorResponse }>(
      "/api/v1/documents/upload-url",
      async (request, reply) => {
        const parsedRequest = createUploadUrlRequestSchema.safeParse(
          request.body,
        );
        if (!parsedRequest.success) {
          return reply.code(400).send({
            error: {
              code: "INVALID_UPLOAD_REQUEST",
              message: parsedRequest.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; "),
              requestId: request.id,
            },
          });
        }

        const filename = path
          .basename(parsedRequest.data.fileName)
          .slice(0, 255);
        const extension = path.extname(filename).toLowerCase();
        if (!supportedExtensions().includes(extension)) {
          throw new AppError(
            "UNSUPPORTED_FILE_TYPE",
            `Unsupported file extension. Supported extensions: ${supportedExtensions().join(", ")}`,
            415,
          );
        }
        if (
          parsedRequest.data.documentType === "drhp" &&
          extension !== ".pdf"
        ) {
          throw new AppError(
            "UNSUPPORTED_DOCUMENT_TYPE",
            "DRHP-specific processing is currently supported for PDF files only",
            415,
          );
        }

        const documentId = randomUUID();
        const contentType =
          extension === ".pdf"
            ? "application/pdf"
            : "application/octet-stream";
        const upload = await presignedUploads.create({
          documentId,
          extension,
          contentType,
        });
        const now = new Date();
        const document: DocumentRecord = {
          documentId,
          ownerId: getAuthenticatedUserId(request),
          filename,
          mediaType: contentType,
          extension,
          ...(parsedRequest.data.documentType
            ? { documentType: parsedRequest.data.documentType }
            : {}),
          storagePath: upload.storagePath,
          status: "queued",
          createdAt: now,
          updatedAt: now,
        };
        const jobId = randomUUID();
        await dependencies.database.createDocumentAndJob(document, {
          jobId,
          documentId,
          status: "queued",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        });

        const response = {
          documentId,
          uploadUrl: upload.uploadUrl,
          fields: upload.fields,
          status: "queued",
          createdAt: now.toISOString(),
        } satisfies UploadUrlResponse;
        uploadUrlResponseSchema.parse(response);
        return reply.code(201).send(response);
      },
    );
  }

  app.get<{ Querystring: { limit?: string } }>(
    "/api/v1/documents",
    async (request, reply) => {
      const rawLimit = request.query.limit;
      const limit = rawLimit === undefined ? 50 : Number(rawLimit);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (rawLimit !== undefined && !/^\d+$/.test(rawLimit))
      ) {
        return reply.code(400).send({
          error: {
            code: "INVALID_LIMIT",
            message: "The limit must be an integer between 1 and 100",
            requestId: request.id,
          },
        } satisfies ErrorResponse);
      }

      const documents = await dependencies.database.listDocuments(
        getAuthenticatedUserId(request),
        limit,
      );
      const response: ListDocumentsResponse = {
        documents: documents.map(toGetDocumentResponse),
      };
      listDocumentsResponseSchema.parse(response);
      return response;
    },
  );

  app.get<{ Params: { documentId: string }; Reply: GetDocumentResponse | ErrorResponse }>(
    "/api/v1/documents/:documentId",
    async (request, reply) => {
      const documentId = validateDocumentId(request.params.documentId);
      const document = await dependencies.database.getDocumentForOwner(
        documentId,
        getAuthenticatedUserId(request),
      );
      if (!document) {
        return reply.code(404).send({
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "Document not found",
            requestId: request.id,
          },
        });
      }

      const response = toGetDocumentResponse(document);
      getDocumentResponseSchema.parse(response);
      return response;
    },
  );

  app.get<{
    Params: { documentId: string };
    Querystring: { section?: string };
    Reply: DocumentInsightResponse | ErrorResponse;
  }>("/api/v1/documents/:documentId/insights", async (request, reply) => {
    const documentId = validateDocumentId(request.params.documentId);
    const parsedSection = insightSectionSchema.safeParse(request.query.section);
    if (!parsedSection.success) {
      return reply.code(400).send({
        error: {
          code: "INVALID_INSIGHT_SECTION",
          message: 'The "section" query parameter must be one of overview, financials, risks, or ipo',
          requestId: request.id,
        },
      });
    }
    if (!insights) {
      throw new AppError(
        "INSIGHTS_NOT_CONFIGURED",
        "Structured insights processing is not configured",
        503,
      );
    }

    const document = await dependencies.database.getDocumentForOwner(
      documentId,
      getAuthenticatedUserId(request),
    );
    if (!document) {
      return reply.code(404).send({
        error: {
          code: "DOCUMENT_NOT_FOUND",
          message: "Document not found",
          requestId: request.id,
        },
      });
    }
    if (document.status !== "ready") {
      return reply.code(409).send({
        error: {
          code: "DOCUMENT_NOT_READY",
          message: "Document is still being analyzed",
          requestId: request.id,
        },
      });
    }

    const response = await insights.getOrGenerateSection(
      documentId,
      parsedSection.data,
    );
    documentInsightResponseSchema.parse(response);
    return response;
  });

  app.post<{
    Params: { documentId: string };
    Body: unknown;
    Reply: DocumentInsightResponse | ErrorResponse;
  }>(
    "/api/v1/documents/:documentId/insights/refresh",
    async (request, reply) => {
      const documentId = validateDocumentId(request.params.documentId);
      const parsedBody = refreshInsightRequestSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_INSIGHT_SECTION",
            message: parsedBody.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
            requestId: request.id,
          },
        });
      }
      if (!insights) {
        throw new AppError(
          "INSIGHTS_NOT_CONFIGURED",
          "Structured insights processing is not configured",
          503,
        );
      }

      const document = await dependencies.database.getDocumentForOwner(
        documentId,
        getAuthenticatedUserId(request),
      );
      if (!document) {
        return reply.code(404).send({
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "Document not found",
            requestId: request.id,
          },
        });
      }
      if (document.status !== "ready") {
        return reply.code(409).send({
          error: {
            code: "DOCUMENT_NOT_READY",
            message: "Document is still being analyzed",
            requestId: request.id,
          },
        });
      }

      const response = await insights.getOrGenerateSection(
        documentId,
        parsedBody.data.section,
        { forceRefresh: true },
      );
      documentInsightResponseSchema.parse(response);
      return response;
    },
  );

  app.post<{ Params: { documentId: string }; Body: unknown; Reply: DocumentFeedbackResponse | ErrorResponse }>(
    "/api/v1/documents/:documentId/feedback",
    async (request, reply) => {
      const documentId = validateDocumentId(request.params.documentId);
      const parsedFeedback = documentFeedbackRequestSchema.safeParse(
        request.body,
      );
      if (!parsedFeedback.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_FEEDBACK",
            message: parsedFeedback.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
            requestId: request.id,
          },
        });
      }

      const ownerId = getAuthenticatedUserId(request);
      const document = await dependencies.database.getDocumentForOwner(
        documentId,
        ownerId,
      );
      if (!document) {
        return reply.code(404).send({
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "Document not found",
            requestId: request.id,
          },
        });
      }

      const feedbackId = randomUUID();
      const createdAt = new Date();
      await dependencies.database.createFeedback({
        feedbackId,
        ownerId,
        documentId,
        questionHash: createHash("sha256")
          .update(parsedFeedback.data.question.trim())
          .digest("hex"),
        rating: parsedFeedback.data.rating,
        createdAt,
      });
      const response = {
        feedbackId,
        createdAt: createdAt.toISOString(),
      } satisfies DocumentFeedbackResponse;
      documentFeedbackResponseSchema.parse(response);
      return reply.code(202).send(response);
    },
  );

  app.delete<{ Params: { documentId: string } }>(
    "/api/v1/documents/:documentId",
    async (request, reply) => {
      const documentId = validateDocumentId(request.params.documentId);
      const ownerId = getAuthenticatedUserId(request);
      const document = await dependencies.database.getDocumentForOwner(
        documentId,
        ownerId,
      );
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
      const deleted = await dependencies.database.deleteDocument(
        documentId,
        ownerId,
      );
      if (!deleted) {
        return reply.code(404).send({
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "Document not found",
            requestId: request.id,
          },
        });
      }
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
      if (!queries) {
        throw new AppError(
          "QUERY_NOT_CONFIGURED",
          "Query processing is not configured",
          503,
        );
      }
      try {
        const ownerDocumentIds = await dependencies.database.listDocumentIds(
          getAuthenticatedUserId(request),
        );
        const allowedIds = new Set(ownerDocumentIds);
        if (
          parsedRequest.data.documentIds?.some(
            (documentId) => !allowedIds.has(documentId),
          )
        ) {
          return reply.code(404).send({
            error: {
              code: "DOCUMENT_NOT_FOUND",
              message: "One or more documents were not found",
              requestId: request.id,
            },
          });
        }
        const response = await queries.query({
          ...parsedRequest.data,
          documentIds: parsedRequest.data.documentIds ?? ownerDocumentIds,
        });
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

function configuredAuthenticator(): AccessTokenAuthenticator | undefined {
  if (config.authMode !== "cognito") return undefined;
  const { cognitoUserPoolId, cognitoClientId } = config;
  if (!cognitoUserPoolId || !cognitoClientId) {
    throw new Error(
      "Cognito user pool ID and app client ID are required in Cognito auth mode",
    );
  }
  return createCognitoAuthenticator(cognitoUserPoolId, cognitoClientId);
}

function getAuthenticatedUserId(request: {
  userId: string | null;
}): string {
  if (!request.userId) {
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }
  return request.userId;
}

function toGetDocumentResponse(
  document: DocumentRecord,
): GetDocumentResponse {
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
}

function validateDocumentId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError("INVALID_DOCUMENT_ID", "Document ID must be a UUID", 400);
  }
  return value;
}
