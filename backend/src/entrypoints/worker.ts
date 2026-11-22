import { config } from "../config/config.js";
import { FileStorage, IngestionService } from "../services/ingestion.js";
import { DrhpInsightsService } from "../services/insights.js";
import { RagDatabase } from "../infrastructure/mongo.js";
import { createModelClient } from "../infrastructure/model-factory.js";

const database = await RagDatabase.connect(
  config.mongoUri,
  config.mongoDatabase,
  config.vectorIndex,
);
const model = createModelClient();
const insights = new DrhpInsightsService(database, model, (event, fields) =>
  console.info(JSON.stringify({ event, ...fields })),
);
const service = new IngestionService(
  database,
  model,
  new FileStorage(config.uploadDirectory),
  insights,
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
