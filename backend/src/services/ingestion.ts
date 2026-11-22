import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/config.js";
import { AppError } from "../shared/errors.js";
import type { DocumentType } from "../contracts/contracts.js";
import { type DocumentRecord, type JobRecord, RagDatabase, type ChunkRecord } from "../infrastructure/mongo.js";
import { parseDocument, splitIntoChunks } from "../documents/parsers.js";
import {
  chunkDrhpPages,
  detectPdfDocumentType,
  parseDrhpPdf,
} from "../documents/drhp.js";
import { GroundedModelClient } from "../infrastructure/ollama.js";
import type { DrhpInsightsService } from "./insights.js";

export interface DocumentStorage {
  save(documentId: string, extension: string, data: Buffer): Promise<string>;
  remove(storagePath: string): Promise<void>;
}

export type TemporaryDocument = {
  path: string;
  cleanup(): Promise<void>;
};

export class FileStorage implements DocumentStorage {
  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async save(documentId: string, extension: string, data: Buffer): Promise<string> {
    await this.initialize();
    const filePath = path.join(this.directory, `${documentId}${extension}`);
    await writeFile(filePath, data, { flag: "wx" });
    return filePath;
  }

  async remove(filePath: string): Promise<void> {
    await rm(filePath, { force: true });
  }
}

export class IngestionService {
  constructor(
    private readonly database: RagDatabase,
    private readonly model: Pick<GroundedModelClient, "embed">,
    private readonly storage: DocumentStorage,
    private readonly insights?: Pick<DrhpInsightsService, "precomputeAll">,
  ) {}

  async enqueue(
    filename: string,
    extension: string,
    data: Buffer,
    documentType?: DocumentType,
    ownerId = "local",
  ): Promise<DocumentRecord> {
    const documentId = randomUUID();
    const storagePath = await this.storage.save(documentId, extension, data);
    const now = new Date();
    const document: DocumentRecord = {
      documentId,
      ownerId,
      filename,
      mediaType: "application/octet-stream",
      extension,
      ...(documentType ? { documentType } : {}),
      storagePath,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    const job: JobRecord = {
      jobId: randomUUID(),
      documentId,
      status: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.database.createDocumentAndJob(document, job);
    } catch (error) {
      await this.storage.remove(storagePath);
      throw error;
    }
    return document;
  }

  async processNext(): Promise<boolean> {
    const job = await this.database.claimNextJob();
    if (!job) return false;
    const document = await this.database.getDocument(job.documentId);
    if (!document) {
      await this.database.failJob(job.jobId);
      return true;
    }

    await this.processClaimedJob(
      job,
      document,
      async () => ({ path: document.storagePath, cleanup: async () => {} }),
      false,
    );
    return true;
  }

  async processQueuedDocument(
    documentId: string,
    loadSource: (document: DocumentRecord) => Promise<TemporaryDocument>,
  ): Promise<void> {
    const job = await this.database.claimJobForDocument(documentId);
    if (!job) return;

    const document = await this.database.getDocument(documentId);
    if (!document) {
      await this.database.failJob(job.jobId);
      return;
    }

    await this.processClaimedJob(job, document, () => loadSource(document), true);
  }

  private async processClaimedJob(
    job: JobRecord,
    document: DocumentRecord,
    loadSource: () => Promise<TemporaryDocument>,
    retryOnFailure: boolean,
  ): Promise<void> {
    const startedAt = Date.now();
    const leaseHeartbeat = setInterval(() => {
      void this.database.renewJobLease(job.jobId).catch((error: unknown) => {
        console.error(
          `Could not renew ingestion lease ${job.jobId}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
    }, 60_000);
    leaseHeartbeat.unref();

    try {
      await this.database.updateDocument(document.documentId, {
        status: "processing",
        updatedAt: new Date(),
      });
      const sourceLoadStartedAt = Date.now();
      const source = await loadSource();
      console.info(
        JSON.stringify({
          event: "ingestion.stage.completed",
          documentId: document.documentId,
          stage: "source_load",
          durationMs: Date.now() - sourceLoadStartedAt,
        }),
      );
      try {
        await this.ingestDocument(job, document, source.path);
      } finally {
        await cleanupTemporaryDocument(source);
      }
    } catch (error) {
      const code = error instanceof AppError ? error.code : "INGESTION_FAILED";
      const message = error instanceof Error ? error.message : "Unknown ingestion error";
      const permanentClientError =
        error instanceof AppError &&
        error.statusCode >= 400 &&
        error.statusCode < 500;
      if (retryOnFailure && job.attempts < 3 && !permanentClientError) {
        await this.database.updateDocument(document.documentId, {
          status: "queued",
          updatedAt: new Date(),
        });
        await this.database.retryJob(job.jobId);
      } else {
        await this.database.updateDocument(document.documentId, {
          status: "failed",
          updatedAt: new Date(),
          error: { code, message },
        });
        await this.database.failJob(job.jobId);
      }

      console.error(`Ingestion job ${job.jobId} failed: ${message}`);
      if (retryOnFailure && !permanentClientError) throw error;
    } finally {
      clearInterval(leaseHeartbeat);
      console.info(
        JSON.stringify({
          event: "ingestion.document.finished",
          documentId: document.documentId,
          durationMs: Date.now() - startedAt,
        }),
      );
    }
  }

  private async ingestDocument(
    job: JobRecord,
    document: DocumentRecord,
    filePath: string,
  ): Promise<void> {
    const parseStartedAt = Date.now();
    let documentType: DocumentType = document.documentType ?? "generic";
    if (!document.documentType && document.extension === ".pdf") {
      documentType = await detectPdfDocumentType(filePath);
    }
    const parsed =
      documentType === "drhp" && document.extension === ".pdf"
        ? await parseDrhpPdf(filePath)
        : await parseDocument(filePath, document.extension);
    await this.database.updateDocument(document.documentId, {
      documentType,
    });
    const parts: Array<{
      text: string;
      section?: string;
      chunkIndex?: number;
      pdfPageIndex?: number;
      printedPageNumber?: string;
    }> =
      "pages" in parsed
        ? chunkDrhpPages(parsed.pages)
        : splitIntoChunks(parsed.text);
    console.info(
      JSON.stringify({
        event: "ingestion.stage.completed",
        documentId: document.documentId,
        stage: "parse_and_chunk",
        durationMs: Date.now() - parseStartedAt,
        pageCount: "pages" in parsed ? parsed.pages.length : undefined,
        chunkCount: parts.length,
      }),
    );
    if (parts.length === 0) {
      throw new AppError(
        "EMPTY_DOCUMENT",
        "No readable text could be extracted from the document",
        422,
      );
    }
    const chunks: ChunkRecord[] = [];

    const embeddingStartedAt = Date.now();
    for (let start = 0; start < parts.length; start += 32) {
      const batch = parts.slice(start, start + 32);
      const embeddings = await this.model.embed(batch.map((part) => part.text));
      batch.forEach((part, index) => {
        const embedding = embeddings[index];
        if (!embedding) {
          throw new AppError(
            "EMBEDDING_COUNT_MISMATCH",
            "Embedding count did not match chunk count",
            502,
          );
        }
        chunks.push({
          chunkId: randomUUID(),
          documentId: document.documentId,
          filename: document.filename,
          text: part.text,
          embedding,
          embeddingModel: config.embeddingModel,
          ...(part.chunkIndex !== undefined
            ? { chunkIndex: part.chunkIndex }
            : {}),
          ...(part.section ? { section: part.section } : {}),
          ...(part.pdfPageIndex !== undefined
            ? { pdfPageIndex: part.pdfPageIndex }
            : {}),
          ...(part.printedPageNumber
            ? { printedPageNumber: part.printedPageNumber }
            : {}),
        });
      });
    }
    console.info(
      JSON.stringify({
        event: "ingestion.stage.completed",
        documentId: document.documentId,
        stage: "embedding",
        durationMs: Date.now() - embeddingStartedAt,
        chunkCount: chunks.length,
        inputCharacters: parts.reduce((total, part) => total + part.text.length, 0),
      }),
    );

    const persistenceStartedAt = Date.now();
    await this.database.replaceChunks(document.documentId, chunks);
    if (documentType === "drhp" && this.insights) {
      const insightsStartedAt = Date.now();
      await this.insights.precomputeAll(document.documentId);
      console.info(
        JSON.stringify({
          event: "ingestion.stage.completed",
          documentId: document.documentId,
          stage: "structured_insights",
          durationMs: Date.now() - insightsStartedAt,
        }),
      );
    }
    await this.database.updateDocument(document.documentId, {
      mediaType: parsed.mediaType,
      documentType,
      status: "ready",
      updatedAt: new Date(),
    });
    await this.database.completeJob(job.jobId);
    console.info(
      JSON.stringify({
        event: "ingestion.stage.completed",
        documentId: document.documentId,
        stage: "database_persistence",
        durationMs: Date.now() - persistenceStartedAt,
        chunkCount: chunks.length,
      }),
    );
  }
}

async function cleanupTemporaryDocument(
  source: TemporaryDocument,
): Promise<void> {
  try {
    await source.cleanup();
  } catch (error) {
    console.error(
      `Could not remove temporary document ${source.path}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}
