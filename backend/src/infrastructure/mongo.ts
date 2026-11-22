import {
  MongoClient,
  type Collection,
  type Db,
  type Document,
  type Filter,
} from "mongodb";
import type {
  DocumentInsightResponse,
  DocumentStatus,
  DocumentType,
  InsightSection,
} from "../contracts/contracts.js";
import { AppError } from "../shared/errors.js";

export type DocumentRecord = {
  documentId: string;
  ownerId?: string;
  filename: string;
  mediaType: string;
  extension: string;
  documentType?: DocumentType;
  storagePath: string;
  status: DocumentStatus;
  createdAt: Date;
  updatedAt: Date;
  error?: { code: string; message: string };
};

export type ChunkRecord = {
  chunkId: string;
  documentId: string;
  filename: string;
  text: string;
  embedding: number[];
  embeddingModel: string;
  chunkIndex?: number;
  section?: string;
  pdfPageIndex?: number;
  printedPageNumber?: string;
};

export type JobRecord = {
  jobId: string;
  documentId: string;
  status: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  leaseUntil?: Date;
};

export type FeedbackRecord = {
  feedbackId: string;
  ownerId: string;
  documentId: string;
  questionHash: string;
  rating: "helpful" | "not_helpful";
  createdAt: Date;
};

export type DocumentInsightRecord = {
  documentId: string;
  section: InsightSection;
  payload: DocumentInsightResponse;
  updatedAt: Date;
};

export type DocumentChunkSummary = Omit<ChunkRecord, "embedding">;

export type SearchResult = Omit<ChunkRecord, "embedding"> & { score: number };
export type LexicalSearchResult = Omit<ChunkRecord, "embedding"> & {
  textScore: number;
};

export class RagDatabase {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    readonly vectorIndex: string,
  ) {}

  static async connect(
    uri: string,
    databaseName: string,
    vectorIndex: string,
  ): Promise<RagDatabase> {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(databaseName);
    const database = new RagDatabase(client, db, vectorIndex);
    try {
      await database.ensureIndexes();
    } catch (error) {
      await client.close();
      throw error;
    }
    return database;
  }

  private get documents(): Collection<DocumentRecord> {
    return this.db.collection<DocumentRecord>("documents");
  }

  private get chunks(): Collection<ChunkRecord> {
    return this.db.collection<ChunkRecord>("chunks");
  }

  private get jobs(): Collection<JobRecord> {
    return this.db.collection<JobRecord>("ingestion_jobs");
  }

  private get feedback(): Collection<FeedbackRecord> {
    return this.db.collection<FeedbackRecord>("document_feedback");
  }

  private get insights(): Collection<DocumentInsightRecord> {
    return this.db.collection<DocumentInsightRecord>("document_insights");
  }

  private async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.documents.createIndex({ documentId: 1 }, { unique: true }),
      this.documents.createIndex({ storagePath: 1 }, { unique: true }),
      this.documents.createIndex({ ownerId: 1, createdAt: -1 }),
      this.chunks.createIndex({ documentId: 1 }),
      this.chunks.createIndex({ documentId: 1, chunkIndex: 1 }),
      this.chunks.createIndex({ chunkId: 1 }, { unique: true }),
      this.chunks.createIndex({ text: "text" }),
      this.jobs.createIndex({ jobId: 1 }, { unique: true }),
      this.jobs.createIndex({ documentId: 1 }, { unique: true }),
      this.jobs.createIndex({ status: 1, createdAt: 1 }),
      this.feedback.createIndex({ feedbackId: 1 }, { unique: true }),
      this.feedback.createIndex({ ownerId: 1, documentId: 1, createdAt: -1 }),
      this.insights.createIndex(
        { documentId: 1, section: 1 },
        { unique: true },
      ),
    ]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ping(): Promise<void> {
    await this.db.command({ ping: 1 });
  }

  async createDocumentAndJob(
    document: DocumentRecord,
    job: JobRecord,
  ): Promise<void> {
    await this.documents.insertOne(document);
    try {
      await this.jobs.insertOne(job);
    } catch (error) {
      await this.documents.deleteOne({ documentId: document.documentId });
      throw error;
    }
  }

  async getDocument(documentId: string): Promise<DocumentRecord | null> {
    return this.documents.findOne({ documentId });
  }

  async getDocumentByStoragePath(
    storagePath: string,
  ): Promise<DocumentRecord | null> {
    return this.documents.findOne({ storagePath });
  }

  async listDocuments(
    ownerId: string,
    limit: number,
  ): Promise<DocumentRecord[]> {
    return this.documents
      .find(ownerFilter(ownerId))
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async listDocumentIds(ownerId: string): Promise<string[]> {
    const documents = await this.documents
      .find(ownerFilter(ownerId), {
        projection: { _id: 0, documentId: 1 },
      })
      .toArray();
    return documents.map((document) => document.documentId);
  }

  async getDocumentForOwner(
    documentId: string,
    ownerId: string,
  ): Promise<DocumentRecord | null> {
    return this.documents.findOne({
      documentId,
      ...ownerFilter(ownerId),
    });
  }

  async getDocumentTypes(
    documentIds: string[],
  ): Promise<
    Array<
      Pick<
        DocumentRecord,
        "documentId" | "documentType" | "filename" | "extension"
      >
    >
  > {
    return this.documents
      .find(
        { documentId: { $in: documentIds } },
        {
          projection: {
            _id: 0,
            documentId: 1,
            documentType: 1,
            filename: 1,
            extension: 1,
          },
        },
      )
      .toArray();
  }

  async updateDocument(
    documentId: string,
    update: Partial<DocumentRecord>,
  ): Promise<void> {
    await this.documents.updateOne({ documentId }, { $set: update });
  }

  async deleteDocument(
    documentId: string,
    ownerId: string,
  ): Promise<DocumentRecord | null> {
    const document = await this.documents.findOneAndDelete({
      documentId,
      ...ownerFilter(ownerId),
    });
    if (document) {
      await Promise.all([
        this.chunks.deleteMany({ documentId }),
        this.jobs.deleteMany({ documentId }),
        this.feedback.deleteMany({ documentId }),
        this.insights.deleteMany({ documentId }),
      ]);
    }
    return document;
  }

  async createFeedback(feedback: FeedbackRecord): Promise<void> {
    await this.feedback.insertOne(feedback);
  }

  async getInsight(
    documentId: string,
    section: InsightSection,
  ): Promise<DocumentInsightRecord | null> {
    return this.insights.findOne({ documentId, section });
  }

  async upsertInsight(record: DocumentInsightRecord): Promise<void> {
    await this.insights.updateOne(
      { documentId: record.documentId, section: record.section },
      { $set: record },
      { upsert: true },
    );
  }

  async deleteInsightsForDocument(documentId: string): Promise<void> {
    await this.insights.deleteMany({ documentId });
  }

  async findChunksByDocument(
    documentId: string,
    options: {
      sectionRegex?: string;
      textRegex?: string;
      limit?: number;
    } = {},
  ): Promise<DocumentChunkSummary[]> {
    const filter: Filter<ChunkRecord> = { documentId };
    if (options.sectionRegex) {
      filter.section = { $regex: options.sectionRegex, $options: "i" };
    }
    if (options.textRegex) {
      filter.text = { $regex: options.textRegex, $options: "i" };
    }
    const cursor = this.chunks
      .find(filter, {
        projection: {
          _id: 0,
          embedding: 0,
        },
      })
      .sort({ chunkIndex: 1, pdfPageIndex: 1 });
    if (options.limit !== undefined) {
      cursor.limit(options.limit);
    }
    return cursor.toArray();
  }

  async claimNextJob(): Promise<JobRecord | null> {
    const now = new Date();
    return this.jobs.findOneAndUpdate(
      {
        $or: [
          { status: "queued" },
          { status: "processing", leaseUntil: { $lt: now } },
        ],
      },
      {
        $set: {
          status: "processing",
          updatedAt: now,
          leaseUntil: new Date(now.getTime() + 5 * 60_000),
        },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
  }

  async claimJobForDocument(
    documentId: string,
  ): Promise<JobRecord | null> {
    const now = new Date();
    return this.jobs.findOneAndUpdate(
      {
        documentId,
        $or: [
          { status: "queued" },
          { status: "processing", leaseUntil: { $lt: now } },
        ],
      },
      {
        $set: {
          status: "processing",
          updatedAt: now,
          leaseUntil: new Date(now.getTime() + 5 * 60_000),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" },
    );
  }

  async retryJob(jobId: string): Promise<void> {
    await this.jobs.updateOne(
      { jobId, status: "processing" },
      {
        $set: { status: "queued", updatedAt: new Date() },
        $unset: { leaseUntil: "" },
      },
    );
  }

  async completeJob(jobId: string): Promise<void> {
    await this.jobs.updateOne(
      { jobId },
      {
        $set: { status: "completed", updatedAt: new Date() },
        $unset: { leaseUntil: "" },
      },
    );
  }

  async renewJobLease(jobId: string): Promise<void> {
    await this.jobs.updateOne(
      { jobId, status: "processing" },
      {
        $set: {
          updatedAt: new Date(),
          leaseUntil: new Date(Date.now() + 5 * 60_000),
        },
      },
    );
  }

  async failJob(jobId: string): Promise<void> {
    await this.jobs.updateOne(
      { jobId },
      {
        $set: { status: "failed", updatedAt: new Date() },
        $unset: { leaseUntil: "" },
      },
    );
  }

  async replaceChunks(documentId: string, chunks: ChunkRecord[]): Promise<void> {
    const newChunkIds = chunks.map((chunk) => chunk.chunkId);
    try {
      if (chunks.length > 0) await this.chunks.insertMany(chunks);
    } catch (error) {
      if (newChunkIds.length > 0) {
        await this.chunks.deleteMany({
          documentId,
          chunkId: { $in: newChunkIds },
        });
      }
      throw error;
    }
    await this.chunks.deleteMany({
      documentId,
      ...(newChunkIds.length > 0 ? { chunkId: { $nin: newChunkIds } } : {}),
    });
    await this.insights.deleteMany({ documentId });
  }

  async searchChunks(
    embedding: number[],
    topK: number,
    documentIds?: string[],
  ): Promise<SearchResult[]> {
    const filter: Document = {};
    if (documentIds) filter.documentId = { $in: documentIds };

    return this.chunks
      .aggregate<SearchResult>([
        {
          $vectorSearch: {
            index: this.vectorIndex,
            path: "embedding",
            queryVector: embedding,
            numCandidates: Math.max(topK * 10, 100),
            limit: topK,
            ...(documentIds ? { filter } : {}),
          },
        },
        {
          $project: {
            _id: 0,
            chunkId: 1,
            documentId: 1,
            filename: 1,
            text: 1,
            embeddingModel: 1,
            chunkIndex: 1,
            section: 1,
            pdfPageIndex: 1,
            printedPageNumber: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ])
      .toArray();
  }

  async searchChunksLexical(
    query: string,
    topK: number,
    documentIds?: string[],
  ): Promise<LexicalSearchResult[]> {
    const filter: Document = { $text: { $search: query } };
    if (documentIds) filter.documentId = { $in: documentIds };

    return this.chunks
      .aggregate<LexicalSearchResult>([
        { $match: filter },
        { $addFields: { textScore: { $meta: "textScore" } } },
        { $sort: { textScore: -1 } },
        { $limit: topK },
        {
          $project: {
            _id: 0,
            chunkId: 1,
            documentId: 1,
            filename: 1,
            text: 1,
            embeddingModel: 1,
            chunkIndex: 1,
            section: 1,
            pdfPageIndex: 1,
            printedPageNumber: 1,
            textScore: 1,
          },
        },
      ])
      .toArray();
  }

  async scoreChunks(
    chunkIds: string[],
    queryEmbedding: number[],
  ): Promise<SearchResult[]> {
    if (chunkIds.length === 0) return [];
    const chunks = await this.chunks
      .find({ chunkId: { $in: chunkIds } })
      .toArray();
    return chunks.map((chunk) =>
      searchResultFromChunk(
        chunk,
        cosineSearchScore(queryEmbedding, chunk.embedding),
      ),
    );
  }

  async searchChunksExact(
    embedding: number[],
    topK: number,
    maxChunks: number,
    documentIds?: string[],
  ): Promise<SearchResult[]> {
    const filter: Document = {};
    if (documentIds) filter.documentId = { $in: documentIds };

    const chunks = await this.chunks
      .find(filter)
      .limit(maxChunks + 1)
      .toArray();

    if (chunks.length > maxChunks) {
      throw new AppError(
        "EXACT_SEARCH_LIMIT",
        `Development exact search is limited to ${maxChunks} chunks; configure MongoDB vector search for larger collections`,
        503,
      );
    }

    return chunks
      .map((chunk) =>
        searchResultFromChunk(
          chunk,
          cosineSearchScore(embedding, chunk.embedding),
        ),
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
  }
}

function ownerFilter(ownerId: string): Filter<DocumentRecord> {
  if (ownerId === "local") {
    return {
      $or: [{ ownerId }, { ownerId: { $exists: false } }],
    };
  }
  return { ownerId };
}

function searchResultFromChunk(
  chunk: ChunkRecord,
  score: number,
): SearchResult {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    filename: chunk.filename,
    text: chunk.text,
    embeddingModel: chunk.embeddingModel,
    ...(chunk.chunkIndex !== undefined
      ? { chunkIndex: chunk.chunkIndex }
      : {}),
    ...(chunk.section ? { section: chunk.section } : {}),
    ...(chunk.pdfPageIndex !== undefined
      ? { pdfPageIndex: chunk.pdfPageIndex }
      : {}),
    ...(chunk.printedPageNumber
      ? { printedPageNumber: chunk.printedPageNumber }
      : {}),
    score,
  };
}

export function cosineSearchScore(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new AppError(
      "EMBEDDING_DIMENSION_MISMATCH",
      "Query and stored embeddings have different dimensions",
      502,
    );
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) {
      throw new AppError(
        "INVALID_EMBEDDING",
        "An embedding contains a missing dimension",
        502,
      );
    }
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  const cosine =
    dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
  return (Math.max(-1, Math.min(1, cosine)) + 1) / 2;
}
