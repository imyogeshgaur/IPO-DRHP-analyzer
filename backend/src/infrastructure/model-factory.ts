import { config } from "../config/config.js";
import { BedrockClient } from "./bedrock.js";
import { OllamaClient } from "./ollama.js";

export function createModelClient() {
  if (config.modelProvider === "bedrock") {
    return new BedrockClient(
      config.bedrockChatModelId,
      config.bedrockEmbeddingModelId,
      config.bedrockEmbeddingDimensions,
      config.bedrockRegion,
    );
  }
  return new OllamaClient(
    config.ollamaUrl,
    config.chatModel,
    config.embeddingModel,
  );
}
