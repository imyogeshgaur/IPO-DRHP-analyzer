# DRHP Insight AWS Infrastructure

CDK stack for the serverless DRHP Insight backend (`backend/infra/`).

## Serverless API and direct S3 uploads

The stack defines API Gateway, a Cognito-protected Lambda API, a private S3
documents bucket, an S3-to-SQS ingestion queue with a DLQ, and an SQS-triggered
ingestion Lambda. The APIs use Amazon Bedrock (Nova Lite + Titan Text Embeddings
V2 at 1024 dimensions) and read the MongoDB URI from the SSM SecureString
`/drhp-insight/<stage>/mongodb-uri`.

1. Copy `.env.example` to `.env` and set `COGNITO_USER_POOL_ID` and
   `COGNITO_CLIENT_ID`.
2. Configure AWS CLI credentials and create the SSM SecureString
   `/drhp-insight/<stage>/mongodb-uri` containing the MongoDB Atlas connection string.
3. Configure the Atlas vector search index `rag_vector_index` for 1024 dimensions
   with `documentId` as a filter field.
4. Build and synthesize the stack:

   ```sh
   cd backend/infra
   npm install
   npm run build
   npm run synth -- --context stage=dev
   ```

5. Deploy:

   ```sh
   npm run deploy -- --context stage=dev
   ```

For the mobile app, set `API_BASE_URL` to the `ApiBaseUrl` stack output and
`UPLOAD_MODE=s3` in `frontend/.env`.
