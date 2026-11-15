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
import { OllamaClient } from "../infrastructure/ollama.js";

export class FileStorage {
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
    private readonly ollama: OllamaClient,
    private readonly storage: FileStorage,
  ) {}

  async enqueue(
    filename: string,
    extension: string,
    data: Buffer,
    documentType?: DocumentType,
  ): Promise<DocumentRecord> {
    const documentId = randomUUID();
    const storagePath = await this.storage.save(documentId, extension, data);
    const now = new Date();
    const document: DocumentRecord = {
      documentId,
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
      let documentType: DocumentType = document.documentType ?? "generic";
      if (!document.documentType && document.extension === ".pdf") {
        documentType = await detectPdfDocumentType(document.storagePath);
      }
      const parsed =
        documentType === "drhp" && document.extension === ".pdf"
          ? await parseDrhpPdf(document.storagePath)
          : await parseDocument(document.storagePath, document.extension);
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
      if (parts.length === 0) {
        throw new AppError(
          "EMPTY_DOCUMENT",
          "No readable text could be extracted from the document",
          422,
        );
      }
      const chunks: ChunkRecord[] = [];

      for (let start = 0; start < parts.length; start += 32) {
        const batch = parts.slice(start, start + 32);
        const embeddings = await this.ollama.embed(batch.map((part) => part.text));
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

      await this.database.replaceChunks(document.documentId, chunks);
      await this.database.updateDocument(document.documentId, {
        mediaType: parsed.mediaType,
        documentType,
        status: "ready",
        updatedAt: new Date(),
      });
      await this.database.completeJob(job.jobId);
    } catch (error) {
      const code = error instanceof AppError ? error.code : "INGESTION_FAILED";
      const message = error instanceof Error ? error.message : "Unknown ingestion error";
      await this.database.updateDocument(document.documentId, {
        status: "failed",
        updatedAt: new Date(),
        error: { code, message },
      });
      await this.database.failJob(job.jobId);
      console.error(`Ingestion job ${job.jobId} failed: ${message}`);
    } finally {
      clearInterval(leaseHeartbeat);
    }

    return true;
  }
}
