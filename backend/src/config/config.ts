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
  MODEL_PROVIDER: z.enum(["ollama", "bedrock"]).default("ollama"),
  BEDROCK_REGION: z.string().min(1).default("ap-south-1"),
  BEDROCK_CHAT_MODEL_ID: z
    .string()
    .min(1)
    .default("apac.amazon.nova-lite-v1:0"),
  BEDROCK_EMBEDDING_MODEL_ID: z
    .string()
    .min(1)
    .default("amazon.titan-embed-text-v2:0"),
  BEDROCK_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(256), z.literal(512), z.literal(1024)]))
    .default(1024),
  UPLOAD_DIRECTORY: z.string().min(1).default("./data/uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  UPLOAD_MODE: z.enum(["local", "s3"]).default("local"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  AUTH_MODE: z.enum(["local", "cognito"]).default("local"),
  COGNITO_USER_POOL_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  COGNITO_CLIENT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  API_KEY: z.string().optional(),
});

const parsedConfig = configSchema.safeParse(process.env);

if (!parsedConfig.success) {
  throw new Error(`Invalid configuration: ${parsedConfig.error.message}`);
}

if (
  parsedConfig.data.AUTH_MODE === "cognito" &&
  (!parsedConfig.data.COGNITO_USER_POOL_ID ||
    !parsedConfig.data.COGNITO_CLIENT_ID)
) {
  throw new Error(
    "COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required when AUTH_MODE=cognito",
  );
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
  modelProvider: parsedConfig.data.MODEL_PROVIDER,
  bedrockRegion: parsedConfig.data.BEDROCK_REGION,
  bedrockChatModelId: parsedConfig.data.BEDROCK_CHAT_MODEL_ID,
  bedrockEmbeddingModelId: parsedConfig.data.BEDROCK_EMBEDDING_MODEL_ID,
  bedrockEmbeddingDimensions: parsedConfig.data.BEDROCK_EMBEDDING_DIMENSIONS,
  chatModel:
    parsedConfig.data.MODEL_PROVIDER === "bedrock"
      ? parsedConfig.data.BEDROCK_CHAT_MODEL_ID
      : parsedConfig.data.OLLAMA_CHAT_MODEL,
  embeddingModel:
    parsedConfig.data.MODEL_PROVIDER === "bedrock"
      ? parsedConfig.data.BEDROCK_EMBEDDING_MODEL_ID
      : parsedConfig.data.OLLAMA_EMBEDDING_MODEL,
  uploadDirectory: parsedConfig.data.UPLOAD_DIRECTORY,
  maxUploadBytes: parsedConfig.data.MAX_UPLOAD_BYTES,
  uploadMode: parsedConfig.data.UPLOAD_MODE,
  workerPollIntervalMs: parsedConfig.data.WORKER_POLL_INTERVAL_MS,
  authMode: parsedConfig.data.AUTH_MODE,
  cognitoUserPoolId: parsedConfig.data.COGNITO_USER_POOL_ID,
  cognitoClientId: parsedConfig.data.COGNITO_CLIENT_ID,
  apiKey: parsedConfig.data.API_KEY,
};
