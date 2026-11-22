import { buildApp } from "../api/app.js";
import { config } from "../config/config.js";
import { FileStorage } from "../services/ingestion.js";
import { RagDatabase } from "../infrastructure/mongo.js";
import { createModelClient } from "../infrastructure/model-factory.js";

const database = await RagDatabase.connect(
  config.mongoUri,
  config.mongoDatabase,
  config.vectorIndex,
);
const storage = new FileStorage(config.uploadDirectory);
await storage.initialize();
const model = createModelClient();
const app = buildApp({ database, model, storage });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  await database.close();
  process.exitCode = 1;
}

const shutdown = async (): Promise<void> => {
  await app.close();
  await database.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
