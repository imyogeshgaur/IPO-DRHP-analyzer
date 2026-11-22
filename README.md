# Sunivesh — DRHP Insight

**Sunivesh (DRHP Insight)** is an AI-powered IPO & DRHP (Draft Red Herring Prospectus) research platform consisting of a React Native mobile application and a TypeScript RAG (Retrieval-Augmented Generation) backend deployable both locally (Ollama + MongoDB) and serverlessly on AWS (API Gateway, Lambda, S3, SQS, Cognito, Amazon Bedrock, and MongoDB Atlas).

Upload a company's DRHP PDF and explore structured, page-cited insights across **Company Overview**, **Financials**, **Risk Factors**, and **IPO Details** — complete with interactive charts — or ask free-form questions in **Document Chat** backed by strict, evidence-verified citations.

---

## Highlights

- **Structured DRHP Insights & Visual Charts** — Automatically extracts and caches verified metrics across 4 dedicated report tabs:
  - **Overview**: Company identity, CIN, registered office, business model, key strengths, and operational KPIs.
  - **Financials**: Multi-year Revenue, EBITDA, and PAT trends with YoY growth, margins, balance sheet metrics, and interactive SVG charts (`react-native-svg`).
  - **Risks**: Page-diverse risk sampling across the prospectus with deterministic severity and category breakdowns.
  - **IPO Details**: Fresh issue vs. Offer for Sale (OFS) breakdown, Objects of the Issue allocation chart, price band/face value, and key BRLMs/registrar details.
- **Grounded, Page-Cited Q&A** — DRHP queries decompose answers into atomic claims, validate each claim against retrieved chunks, and emit exact 1-based physical PDF page numbers and retrieval scores. Unsupported claims are dropped rather than hallucinated.
- **DRHP-Aware PDF Ingestion** — Page-aware PDF extractor preserving zero-based internal page indices, printed page footers, and section headings across pages, with explicit OCR detection (`DRHP_OCR_REQUIRED`) and bounded limits (up to 1,000 pages / 2,000 chunks).
- **Multi-Format Document Support** — Also supports generic ingestion for PDF, DOCX, CSV, XLSX, Markdown, HTML, JSON, plain text, and common source code files.
- **Per-User Isolation & Cognito Auth** — All documents, insights, feedback, and queries are strictly scoped to the authenticated Amazon Cognito user (`sub` claim), with a local auth mode for offline development.
- **Dual Deployment Modes** — Run fully locally with Ollama (`gemma4:12b-mlx` + `nomic-embed-text`) or deploy serverlessly to AWS with CDK using Amazon Bedrock (`apac.amazon.nova-lite-v1:0` + `amazon.titan-embed-text-v2:0`).

---

## Repository Structure

```text
.
├── README.md
├── backend/                 # TypeScript Fastify API, ingestion worker, RAG & insights services
│   ├── src/
│   │   ├── api/             # Fastify REST routes (/api/v1, /health, /ready)
│   │   ├── auth/            # Amazon Cognito JWT access-token verification
│   │   ├── config/          # Environment configuration & validation
│   │   ├── contracts/       # Shared Zod request/response schemas
│   │   ├── documents/       # DRHP page-aware PDF extractor & generic parsers
│   │   ├── entrypoints/     # Local server, local worker, API Lambda, SQS ingestion Lambda
│   │   ├── infrastructure/  # MongoDB Atlas/local, Ollama, Bedrock, S3 storage
│   │   ├── services/        # IngestionService, QueryService, DrhpInsightsService
│   │   └── shared/          # Typed application errors
│   └── infra/               # AWS CDK stack (API Gateway, Lambda, S3, SQS + DLQ, IAM)
└── frontend/                # Bare React Native 0.81 mobile app (Android & iOS)
    ├── android/             # Native Android project
    ├── ios/                 # Native iOS project
    └── src/                 # Screens, API client, Cognito auth, SVG charts & report visuals
```

---

## Architecture Overview

### Local Development Mode
```text
React Native App ──▶ Fastify API (UPLOAD_MODE=local) ──▶ Local Disk + MongoDB
                                                                │
                     Background Worker ◀────────────────────────┘
                            │
                            ▼
                  Ollama (Chat + Embeddings)
```

### Serverless AWS Mode (`backend/infra/`)
```text
React Native App (Cognito JWT)
      │
      ├── 1. POST /api/v1/documents/upload-url ──▶ API Gateway ──▶ ApiFunction Lambda
      ├── 2. Direct Presigned POST ─────────────▶ Private S3 Bucket (documents/*)
      │                                                   │ (ObjectCreated)
      │                                                   ▼
      │                                             SQS Queue (+ DLQ)
      │                                                   │
      │                                                   ▼
      │                                        IngestionFunction Lambda
      │                                                   │
      └── 3. GET insights / POST query ─────────▶ MongoDB Atlas + Amazon Bedrock
```

---

## API Reference

All mobile-facing endpoints are versioned under `/api/v1` and validated at runtime with Zod schemas (`backend/src/contracts/contracts.ts`).

### Authentication & Error Format

- When `AUTH_MODE=cognito`, every `/api/v1/*` endpoint requires an `Authorization: Bearer <cognito_access_token>` header.
- `/health` and `/ready` are unauthenticated probes.
- All error responses follow a uniform structure:

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document not found",
    "requestId": "req-1"
  }
}
```

### Health & Readiness

| Method | Path | Status | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | `200` | Liveness check (`{ "status": "ok" }`). |
| `GET` | `/ready` | `200` / `503` | Verifies MongoDB connectivity, embedding model availability, and vector index readiness. |

### Documents

| Method | Path | Status | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/documents` | `202` | **Local mode (`UPLOAD_MODE=local`) only.** Upload a file as `multipart/form-data` with field name `file`. Optional header `X-Document-Type: drhp \| generic` (DRHP is PDF-only; auto-detected if omitted). Returns `{ documentId, status, createdAt }`. |
| `POST` | `/api/v1/documents/upload-url` | `201` | **S3 mode (`UPLOAD_MODE=s3`) only.** Body: `{ "fileName": "company-drhp.pdf", "documentType": "drhp" }`. Creates an owner-scoped reservation and returns `{ documentId, uploadUrl, fields, status, createdAt }` for direct browser/mobile S3 POST upload. |
| `GET` | `/api/v1/documents?limit=50` | `200` | Lists the authenticated user's documents ordered newest first (`limit`: integer `1–100`, default `50`). |
| `GET` | `/api/v1/documents/:documentId` | `200` | Returns `{ documentId, filename, mediaType, status, createdAt, updatedAt, error? }`. Status lifecycle: `queued` → `processing` → `ready` \| `failed`. |
| `DELETE` | `/api/v1/documents/:documentId` | `204` | Deletes the stored file (S3 or local disk) first, then removes all MongoDB records (document, chunks, jobs, cached insights). |

### Structured DRHP Insights

| Method | Path | Status | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/documents/:documentId/insights?section=<section>` | `200` | Returns cached (or on-demand generated) structured, page-cited insights for a `ready` document. `section` must be one of `overview`, `financials`, `risks`, or `ipo`. Returns `409` if the document is not yet `ready`. |
| `POST` | `/api/v1/documents/:documentId/insights/refresh` | `200` | Forces regeneration and persistence of a section. Body: `{ "section": "overview" \| "financials" \| "risks" \| "ipo" }`. |

### Grounded Q&A & Feedback

| Method | Path | Status | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/query` | `200` | Ask a question over one or more owned documents. |
| `POST` | `/api/v1/documents/:documentId/feedback` | `202` | Submit answer quality feedback. Body: `{ "rating": "helpful" \| "not_helpful", "question": "..." }`. Stores a SHA-256 hash of the question rather than raw text. |

#### Example `POST /api/v1/query`

**Request**
```json
{
  "question": "What was the company's revenue from operations in FY24 and FY25?",
  "documentIds": ["550e8400-e29b-41d4-a716-446655440000"],
  "topK": 5
}
```

**Response**
```json
{
  "question": "What was the company's revenue from operations in FY24 and FY25?",
  "answer": "Restated consolidated revenue from operations was ₹5,427.70 crore in FY24 and ₹6,652.52 crore in FY25.",
  "citations": [
    {
      "chunkId": "a1b2c3d4-...",
      "text": "Restated Consolidated Statement of Profit and Loss...",
      "score": 0.89,
      "page": 294
    }
  ],
  "ground_truth": null
}
```

> Generic document citations return `{ chunkId, text, score }`; DRHP citations also include `page` (1-based physical PDF page number).

---

## Prerequisites

- **Node.js** `>= 20.19.4` (required by React Native 0.81 and the backend/CDK toolchains)
- **Yarn** (for `backend/`) and **npm** (for `backend/infra/` and `frontend/`)
- **For Local Development**:
  - **MongoDB** (local MongoDB with vector search support, or MongoDB Atlas, or `VECTOR_SEARCH_MODE=exact_dev` for small local smoke tests)
  - **Ollama** with `gemma4:12b-mlx` and `nomic-embed-text` pulled
- **For Mobile Development**:
  - **Android**: Android Studio, JDK 17+, Android SDK, and an emulator or physical device
  - **iOS**: macOS, Xcode, Ruby Bundler, and CocoaPods
- **For AWS Serverless Deployment**:
  - AWS CLI configured with deployment permissions
  - Amazon Cognito User Pool + **public** App Client (no client secret)
  - MongoDB Atlas cluster with vector index `rag_vector_index` (1024 dimensions, `documentId` filter field)
  - SSM SecureString parameter `/drhp-insight/<stage>/mongodb-uri`

---

## How to Run the Application

### 1. Run the Backend Locally (Ollama + MongoDB)

```sh
cd backend
cp .env.example .env
```

Review `backend/.env` and ensure MongoDB and Ollama are running:

```sh
ollama pull gemma4:12b-mlx
ollama pull nomic-embed-text
```

Install dependencies and start the API server and ingestion worker in two separate terminals:

```sh
# Terminal 1 — API server (http://localhost:3000)
cd backend
yarn install
yarn dev

# Terminal 2 — Background ingestion worker
cd backend
yarn worker:dev
```

> For production-style local execution, run `yarn build`, then `yarn start` and `yarn worker`.
>
> To run backend unit tests:
> ```sh
> cd backend
> yarn test
> ```

---

### 2. Deploy the Backend Serverlessly on AWS (Optional)

The AWS CDK infrastructure lives in `backend/infra/`.

1. Configure your MongoDB Atlas vector search index `rag_vector_index` on the `chunks` collection for **1024 dimensions** (`embedding` vector field + `documentId` filter field).
2. Store your MongoDB Atlas connection string in AWS Systems Manager Parameter Store as a SecureString named `/drhp-insight/dev/mongodb-uri`.
3. Configure Cognito IDs and deploy via CDK:

```sh
cd backend/infra
cp .env.example .env
# Set COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID in backend/infra/.env

npm install
npm run build
npm run synth -- --context stage=dev
npm run deploy -- --context stage=dev
```

Note the `ApiBaseUrl` CloudFormation stack output — you will use it in `frontend/.env`.

---

### 3. Run the React Native Mobile App (`frontend/`)

This is a bare React Native CLI application (not Expo).

```sh
cd frontend
cp .env.example .env
npm install
```

Configure `frontend/.env`:

- **Against Local Backend**:
  - Set `UPLOAD_MODE=local`
  - Android emulator: `API_BASE_URL=http://10.0.2.2:3000/api/v1`
  - iOS simulator: `API_BASE_URL=http://localhost:3000/api/v1`
  - Leave `COGNITO_*` blank to use the local-preview login path (with `AUTH_MODE=local` on the backend).
- **Against AWS Serverless Backend**:
  - Set `UPLOAD_MODE=s3`
  - Set `API_BASE_URL` to the `ApiBaseUrl` CDK output
  - Set `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, and `COGNITO_CLIENT_ID` (public app client, no secret).

#### Launch on Android

```sh
cd frontend
npm start            # Terminal 1: Metro bundler
npm run android      # Terminal 2: Build & launch on emulator or USB device
```

#### Launch on iOS

```sh
cd frontend/ios
bundle install
bundle exec pod install
cd ..
npm start            # Terminal 1: Metro bundler
npm run ios          # Terminal 2: Build & launch on iOS simulator
```

#### Run Frontend Checks

```sh
cd frontend
npm test
npm run lint
```

---

## Key Environment Variables

### Backend (`backend/.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP bind port and host (local server). |
| `MODEL_PROVIDER` | `ollama` | `ollama` (local) or `bedrock` (AWS). |
| `UPLOAD_MODE` | `local` | `local` (multipart upload) or `s3` (presigned S3 upload). |
| `AUTH_MODE` | `local` | `local` (dev only) or `cognito` (JWT access-token auth). |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection string (or use `MONGODB_URI_PARAMETER_NAME` on AWS). |
| `MONGODB_DATABASE` | `rag` | Target MongoDB database name. |
| `MONGODB_VECTOR_INDEX` | `rag_vector_index` | Vector search index name on the `chunks` collection. |
| `VECTOR_SEARCH_MODE` | `mongodb` | `mongodb` (`$vectorSearch`) or `exact_dev` (in-process scan for small local tests). |
| `MAX_UPLOAD_BYTES` | `20971520` | Maximum upload file size in bytes (20 MiB). |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | — | Required when `AUTH_MODE=cognito`. |

### Frontend (`frontend/.env`)

| Variable | Example | Description |
| :--- | :--- | :--- |
| `API_BASE_URL` | `http://10.0.2.2:3000/api/v1` | Backend `/api/v1` base URL reachable from the device. |
| `UPLOAD_MODE` | `local` \| `s3` | Must match the backend's `UPLOAD_MODE`. |
| `COGNITO_REGION` | `ap-south-1` | AWS region for the Cognito User Pool. |
| `COGNITO_USER_POOL_ID` | `ap-south-1_xxxxxxxxx` | Cognito User Pool ID. |
| `COGNITO_CLIENT_ID` | `xxxxxxxxxxxxxxxxxxxxxxxxxx` | Cognito public App Client ID (without client secret). |
