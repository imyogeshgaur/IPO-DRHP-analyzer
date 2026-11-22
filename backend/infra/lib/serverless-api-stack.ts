import * as path from "node:path";
import {
  ArnFormat,
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

type ServerlessApiStackProps = StackProps & {
  stage: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
};

export class ServerlessApiStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: ServerlessApiStackProps,
  ) {
    super(scope, id, props);

    if (!props.cognitoUserPoolId || !props.cognitoClientId) {
      throw new Error(
        "COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required to synthesize the serverless API stack",
      );
    }

    const bucket = new s3.Bucket(this, "DocumentsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          allowedOrigins: ["*"],
          allowedMethods: [s3.HttpMethods.POST],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 300,
        },
      ],
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const deadLetterQueue = new sqs.Queue(this, "IngestionDeadLetterQueue", {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const ingestionQueue = new sqs.Queue(this, "IngestionQueue", {
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(30),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    });
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(ingestionQueue),
      { prefix: "documents/" },
    );

    const parameterName = `/drhp-insight/${props.stage}/mongodb-uri`;
    const parameterArn = Stack.of(this).formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: parameterName.slice(1),
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const bedrockChatModelId =
      process.env.BEDROCK_CHAT_MODEL_ID ?? "apac.amazon.nova-lite-v1:0";
    const bedrockEmbeddingModelId =
      process.env.BEDROCK_EMBEDDING_MODEL_ID ??
      "amazon.titan-embed-text-v2:0";
    const bedrockEmbeddingDimensions =
      process.env.BEDROCK_EMBEDDING_DIMENSIONS ?? "1024";
    if (!["256", "512", "1024"].includes(bedrockEmbeddingDimensions)) {
      throw new Error(
        "BEDROCK_EMBEDDING_DIMENSIONS must be 256, 512, or 1024",
      );
    }
    const bedrockModelArns = [bedrockChatModelId, bedrockEmbeddingModelId].flatMap(
      (modelId) => {
        const inferenceProfile = /^(?:us|eu|apac|global)\.(.+)$/.exec(
          modelId,
        );
        if (inferenceProfile) {
          return [
            Stack.of(this).formatArn({
              service: "bedrock",
              resource: "inference-profile",
              resourceName: modelId,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            }),
            `arn:${Stack.of(this).partition}:bedrock:*::foundation-model/${inferenceProfile[1]}`,
          ];
        }

        return [
          Stack.of(this).formatArn({
            service: "bedrock",
            resource: "foundation-model",
            resourceName: modelId,
            account: "",
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ];
      },
    );
    const modelEnvironment = {
      MODEL_PROVIDER: "bedrock",
      BEDROCK_REGION: Stack.of(this).region,
      BEDROCK_CHAT_MODEL_ID: bedrockChatModelId,
      BEDROCK_EMBEDDING_MODEL_ID: bedrockEmbeddingModelId,
      BEDROCK_EMBEDDING_DIMENSIONS: bedrockEmbeddingDimensions,
    };

    const apiFunction = new NodejsFunction(this, "ApiFunction", {
      entry: path.join(
        __dirname,
        "../../src/entrypoints/lambda.ts",
      ),
      projectRoot: path.join(__dirname, "../.."),
      depsLockFilePath: path.join(__dirname, "../../yarn.lock"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 1024,
      timeout: Duration.seconds(25),
      environment: {
        AUTH_MODE: "cognito",
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        MONGODB_URI_PARAMETER_NAME: parameterName,
        MONGODB_DATABASE: process.env.MONGODB_DATABASE ?? "rag",
        MONGODB_VECTOR_INDEX:
          process.env.MONGODB_VECTOR_INDEX ?? "rag_vector_index",
        VECTOR_SEARCH_MODE: "mongodb",
        UPLOAD_MODE: "s3",
        MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES ?? "20971520",
        S3_BUCKET_NAME: bucket.bucketName,
        ...modelEnvironment,
      },
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: "node22",
      },
    });
    const ingestionFunction = new NodejsFunction(
      this,
      "IngestionFunction",
      {
        entry: path.join(
          __dirname,
          "../../src/entrypoints/ingestion-lambda.ts",
        ),
        projectRoot: path.join(__dirname, "../.."),
        depsLockFilePath: path.join(
          __dirname,
          "../../yarn.lock",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 2048,
        timeout: Duration.minutes(5),
        environment: {
          MONGODB_URI_PARAMETER_NAME: parameterName,
          MONGODB_DATABASE: process.env.MONGODB_DATABASE ?? "rag",
          MONGODB_VECTOR_INDEX:
            process.env.MONGODB_VECTOR_INDEX ?? "rag_vector_index",
          VECTOR_SEARCH_MODE: "mongodb",
          MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES ?? "20971520",
          S3_BUCKET_NAME: bucket.bucketName,
          SQS_QUEUE_URL: ingestionQueue.queueUrl,
          ...modelEnvironment,
        },
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: "node22",
        },
      },
    );

    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [parameterArn],
      }),
    );
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `ssm.${Stack.of(this).region}.amazonaws.com`,
            "kms:EncryptionContext:PARAMETER_ARN": parameterArn,
          },
        },
      }),
    );
    bucket.grantPut(apiFunction);
    bucket.grantDelete(apiFunction);
    ingestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [parameterArn],
      }),
    );
    ingestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `ssm.${Stack.of(this).region}.amazonaws.com`,
            "kms:EncryptionContext:PARAMETER_ARN": parameterArn,
          },
        },
      }),
    );
    ingestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: bedrockModelArns,
      }),
    );
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: bedrockModelArns,
      }),
    );
    bucket.grantRead(ingestionFunction);
    bucket.grantDelete(ingestionFunction);
    ingestionFunction.addEventSource(
      new events.SqsEventSource(ingestionQueue, {
        batchSize: 1,
        maxConcurrency: 2,
        reportBatchItemFailures: true,
      }),
    );

    const api = new apigateway.RestApi(this, "ApiGateway", {
      restApiName: `drhp-insight-${props.stage}`,
      deployOptions: {
        stageName: props.stage,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: [
          "authorization",
          "content-type",
          "x-document-type",
        ],
      },
    });
    api.root.addProxy({
      anyMethod: true,
      defaultIntegration: new apigateway.LambdaIntegration(apiFunction),
    });

    new CfnOutput(this, "ApiBaseUrl", {
      value: `${api.url}api/v1`,
    });
    new CfnOutput(this, "DocumentsBucketName", {
      value: bucket.bucketName,
    });
    new CfnOutput(this, "IngestionQueueUrl", {
      value: ingestionQueue.queueUrl,
    });
    new CfnOutput(this, "IngestionDeadLetterQueueUrl", {
      value: deadLetterQueue.queueUrl,
    });
    new CfnOutput(this, "MongoUriParameterName", {
      value: parameterName,
    });
  }
}
