import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  MONGODB_URI: z.string().url().default("mongodb://127.0.0.1:27017"),
  MONGODB_DATABASE: z.string().min(1).default("rag"),
  MONGODB_VECTOR_INDEX: z.string().min(1).default("rag_vector_index"),
  VECTOR_SEARCH_MODE: z.enum(["mongodb", "exact_dev"]).default("mongodb"),
  MAX_EXACT_SEARCH_CHUNKS: z.coerce.number().int().positive().default(5000),
  MAX_RETRIEVAL_CANDIDATES: z.coerce.number().int().min(1).max(100).default(40),
  DRHP_RETRIEVAL_CANDIDATES: z.coerce.number().int().min(15).max(20).default(18),
  DRHP_CONTEXT_CHUNKS: z.coerce.number().int().min(4).max(6).default(6),
  CITATION_RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).optional(),
  MIN_RELEVANCE_SCORE: z.coerce.number().min(0).max(1).optional(),
  EVALUATION_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  OLLAMA_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_CHAT_MODEL: z.string().min(1).default("gemma4:12b-mlx"),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
  UPLOAD_DIRECTORY: z.string().min(1).default("./data/uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  API_KEY: z.string().optional(),
});

const parsedConfig = configSchema.safeParse(process.env);

if (!parsedConfig.success) {
  throw new Error(`Invalid configuration: ${parsedConfig.error.message}`);
}

export const config = {
  port: parsedConfig.data.PORT,
  host: parsedConfig.data.HOST,
  mongoUri: parsedConfig.data.MONGODB_URI,
  mongoDatabase: parsedConfig.data.MONGODB_DATABASE,
  vectorIndex: parsedConfig.data.MONGODB_VECTOR_INDEX,
  vectorSearchMode: parsedConfig.data.VECTOR_SEARCH_MODE,
  maxExactSearchChunks: parsedConfig.data.MAX_EXACT_SEARCH_CHUNKS,
  maxRetrievalCandidates: parsedConfig.data.MAX_RETRIEVAL_CANDIDATES,
  drhpRetrievalCandidates: parsedConfig.data.DRHP_RETRIEVAL_CANDIDATES,
  drhpContextChunks: parsedConfig.data.DRHP_CONTEXT_CHUNKS,
  citationRelevanceThreshold:
    parsedConfig.data.CITATION_RELEVANCE_THRESHOLD ??
    parsedConfig.data.MIN_RELEVANCE_SCORE ??
    0.65,
  evaluationMode: parsedConfig.data.EVALUATION_MODE,
  ollamaUrl: parsedConfig.data.OLLAMA_URL.replace(/\/+$/, ""),
  chatModel: parsedConfig.data.OLLAMA_CHAT_MODEL,
  embeddingModel: parsedConfig.data.OLLAMA_EMBEDDING_MODEL,
  uploadDirectory: parsedConfig.data.UPLOAD_DIRECTORY,
  maxUploadBytes: parsedConfig.data.MAX_UPLOAD_BYTES,
  workerPollIntervalMs: parsedConfig.data.WORKER_POLL_INTERVAL_MS,
  apiKey: parsedConfig.data.API_KEY,
};
