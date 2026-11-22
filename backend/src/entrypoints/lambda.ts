import awsLambdaFastify from "@fastify/aws-lambda";
import {
  GetParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { buildApp } from "../api/app.js";
import { config } from "../config/config.js";
import { RagDatabase } from "../infrastructure/mongo.js";
import { createModelClient } from "../infrastructure/model-factory.js";
import { S3DocumentStorage } from "../infrastructure/s3-storage.js";

type ApiGatewayProxy = (
  event: APIGatewayProxyEvent,
  context: Context,
) => Promise<APIGatewayProxyResult>;

const ssm = new SSMClient({});
let proxyPromise: Promise<ApiGatewayProxy> | undefined;

async function createProxy(): Promise<ApiGatewayProxy> {
  const parameterName = process.env.MONGODB_URI_PARAMETER_NAME;
  const bucketName = process.env.S3_BUCKET_NAME;
  if (!parameterName || !bucketName) {
    throw new Error(
      "MONGODB_URI_PARAMETER_NAME and S3_BUCKET_NAME are required",
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
    const app = buildApp({
      database,
      model: createModelClient(),
      storage,
      presignedUploads: storage,
    });
    await app.ready();
    return awsLambdaFastify<APIGatewayProxyEvent>(app);
  } catch (error) {
    await database.close();
    throw error;
  }
}

export const handler: ApiGatewayProxy = async (event, context) => {
  proxyPromise ??= createProxy();
  return (await proxyPromise)(event, context);
};
