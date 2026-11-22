#!/usr/bin/env node
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import * as cdk from "aws-cdk-lib";
import { ServerlessApiStack } from "../lib/serverless-api-stack";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const app = new cdk.App();
const stage = String(app.node.tryGetContext("stage") ?? "dev");

if (!/^[a-z][a-z0-9-]{0,15}$/.test(stage)) {
  throw new Error(
    "CDK context 'stage' must start with a lowercase letter and contain only lowercase letters, digits, or hyphens.",
  );
}

const env =
  process.env.CDK_DEFAULT_ACCOUNT && process.env.CDK_DEFAULT_REGION
    ? {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      }
    : undefined;

new ServerlessApiStack(app, `DrhpInsight-${stage}-ServerlessApi`, {
  stage,
  cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  cognitoClientId: process.env.COGNITO_CLIENT_ID ?? "",
  ...(env ? { env } : {}),
});
