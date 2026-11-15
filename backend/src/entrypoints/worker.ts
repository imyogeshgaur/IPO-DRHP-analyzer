import { config } from "../config/config.js";
import { FileStorage, IngestionService } from "../services/ingestion.js";
import { RagDatabase } from "../infrastructure/mongo.js";
import { OllamaClient } from "../infrastructure/ollama.js";

const database = await RagDatabase.connect(
  config.mongoUri,
  config.mongoDatabase,
  config.vectorIndex,
);
const service = new IngestionService(
  database,
  new OllamaClient(config.ollamaUrl, config.chatModel, config.embeddingModel),
  new FileStorage(config.uploadDirectory),
);

let stopping = false;
process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

try {
  while (!stopping) {
    const foundJob = await service.processNext();
    if (!foundJob) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.workerPollIntervalMs),
      );
    }
  }
} finally {
  await database.close();
}
