import {
  ChangeMessageVisibilityCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  GetParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { z } from "zod";
import { config } from "../config/config.js";
import { AppError } from "../shared/errors.js";
import { IngestionService } from "../services/ingestion.js";
import { DrhpInsightsService } from "../services/insights.js";
import { RagDatabase } from "../infrastructure/mongo.js";
import { S3DocumentStorage } from "../infrastructure/s3-storage.js";
import { createModelClient } from "../infrastructure/model-factory.js";

const s3NotificationSchema = z.object({
  Records: z.array(
    z.object({
      s3: z.object({
        bucket: z.object({ name: z.string().min(1) }),
        object: z.object({ key: z.string().min(1) }),
      }),
    }),
  ),
});

type WorkerRuntime = {
  bucketName: string;
  queueUrl: string;
  database: RagDatabase;
  storage: S3DocumentStorage;
  ingestion: IngestionService;
};

const ssm = new SSMClient({});
const sqs = new SQSClient({});
let runtimePromise: Promise<WorkerRuntime> | undefined;

async function createRuntime(): Promise<WorkerRuntime> {
  const parameterName = process.env.MONGODB_URI_PARAMETER_NAME;
  const bucketName = process.env.S3_BUCKET_NAME;
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!parameterName || !bucketName || !queueUrl) {
    throw new Error(
      "MONGODB_URI_PARAMETER_NAME, S3_BUCKET_NAME, and SQS_QUEUE_URL are required",
    );
  }

  const parameter = await ssm.send(
    new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    }),
  );
  const mongoUri = parameter.Parameter?.Value;
  if (!mongoUri) {
    throw new Error("The MongoDB URI parameter has no value");
  }

  const database = await RagDatabase.connect(
    mongoUri,
    config.mongoDatabase,
    config.vectorIndex,
  );
  try {
    const storage = new S3DocumentStorage(
      bucketName,
      config.maxUploadBytes,
    );
    const model = createModelClient();
    const insights = new DrhpInsightsService(database, model, (event, fields) =>
      console.info(JSON.stringify({ event, ...fields })),
    );
    return {
      bucketName,
      queueUrl,
      database,
      storage,
      ingestion: new IngestionService(
        database,
        model,
        storage,
        insights,
      ),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function getRuntime(): Promise<WorkerRuntime> {
  runtimePromise ??= createRuntime().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const runtime = await getRuntime();
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const message of event.Records) {
    try {
      const body: unknown = JSON.parse(message.body);
      if (
        typeof body === "object" &&
        body !== null &&
        "Event" in body &&
        body.Event === "s3:TestEvent"
      ) {
        continue;
      }

      const notification = s3NotificationSchema.safeParse(body);
      if (!notification.success) {
        throw new AppError(
          "INVALID_S3_NOTIFICATION",
          "The SQS message is not a valid S3 object-created notification",
          400,
        );
      }

      for (const record of notification.data.Records) {
        if (record.s3.bucket.name !== runtime.bucketName) {
          throw new AppError(
            "UNEXPECTED_S3_BUCKET",
            "The S3 notification references an unexpected bucket",
            400,
          );
        }
        const storagePath = decodeURIComponent(
          record.s3.object.key.replace(/\+/g, " "),
        );
        if (!storagePath.startsWith("documents/")) {
          throw new AppError(
            "UNEXPECTED_S3_KEY",
            "The S3 notification references an unexpected object key",
            400,
          );
        }

        const document =
          await runtime.database.getDocumentByStoragePath(storagePath);
        if (!document) {
          await runtime.storage.remove(storagePath);
          continue;
        }
        await runtime.ingestion.processQueuedDocument(
          document.documentId,
          (queuedDocument) =>
            runtime.storage.downloadToTemporaryFile(
              queuedDocument.storagePath,
              queuedDocument.extension,
            ),
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : "unknown error";
      console.error(
        `SQS ingestion message ${message.messageId} failed: ${errorMessage}`,
      );
      const receiveCount =
        Number(message.attributes.ApproximateReceiveCount) || 1;
      const retryDelaySeconds = Math.min(
        300,
        30 * 2 ** Math.min(receiveCount - 1, 4),
      );
      try {
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: runtime.queueUrl,
            ReceiptHandle: message.receiptHandle,
            VisibilityTimeout: retryDelaySeconds,
          }),
        );
      } catch (visibilityError) {
        console.error(
          `Could not shorten retry delay for SQS message ${message.messageId}: ${
            visibilityError instanceof Error
              ? visibilityError.message
              : "unknown error"
          }`,
        );
      }
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }

  return { batchItemFailures };
}
