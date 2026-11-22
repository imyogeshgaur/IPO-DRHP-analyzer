import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { AppError } from "../shared/errors.js";
import { GroundedModelClient } from "./ollama.js";

const embeddingResponseSchema = z.object({
  embedding: z.array(z.number().finite()),
});

export class BedrockClient extends GroundedModelClient {
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly chatModelId: string,
    private readonly embeddingModelId: string,
    private readonly embeddingDimensions: 256 | 512 | 1024,
    region: string,
  ) {
    super();
    this.client = new BedrockRuntimeClient({
      region,
      retryMode: "adaptive",
      maxAttempts: 6,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return mapWithConcurrency(texts, 2, async (text) => {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: this.embeddingModelId,
          contentType: "application/json",
          accept: "application/json",
          body: Buffer.from(
            JSON.stringify({
              inputText: text,
              dimensions: this.embeddingDimensions,
              normalize: true,
            }),
          ),
        }),
      );
      const body: unknown = JSON.parse(
        new TextDecoder().decode(response.body),
      );
      const parsed = embeddingResponseSchema.safeParse(body);
      if (
        !parsed.success ||
        parsed.data.embedding.length !== this.embeddingDimensions
      ) {
        throw new AppError(
          "INVALID_EMBEDDING_RESPONSE",
          `Bedrock returned an invalid embedding; expected ${this.embeddingDimensions} dimensions`,
          502,
        );
      }
      return parsed.data.embedding;
    });
  }

  protected async generateJson(
    systemPrompt: string,
    userPrompt: unknown,
  ): Promise<string> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.chatModelId,
        system: [
          {
            text: `${systemPrompt} Output a single valid raw JSON object only. Do not wrap the response in markdown code fences or include any text outside the JSON object.`,
          },
        ],
        messages: [
          {
            role: "user",
            content: [{ text: JSON.stringify(userPrompt) }],
          },
          {
            role: "assistant",
            content: [{ text: "{" }],
          },
        ],
        inferenceConfig: {
          maxTokens: 4096,
          temperature: 0,
        },
      }),
    );
    const content = response.output?.message?.content ?? [];
    const text = content
      .flatMap((block) => ("text" in block ? [block.text] : []))
      .join("")
      .trim();
    if (!text) {
      throw new AppError(
        "INVALID_CHAT_RESPONSE",
        "Bedrock returned an empty model response",
        502,
      );
    }
    return text.startsWith("{") ? text : `{${text}`;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value === undefined) continue;
        results[index] = await task(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
