# RAG backend

TypeScript REST backend using Ollama for generation and embeddings, and MongoDB for document metadata, ingestion jobs, chunks, and vector retrieval.

## Stable mobile API contract

The mobile-facing API is versioned under `/api/v1`. Request and response schemas are defined in `src/contracts/contracts.ts`; the exported TypeScript types are inferred from those schemas. The server validates incoming requests and validates its response shapes. Breaking contract changes should be introduced under a new API version rather than changing `/api/v1`.

- `POST /api/v1/documents` — `multipart/form-data`, one file field named `file`; optionally send `X-Document-Type: generic` or `X-Document-Type: drhp`. DRHP-specific processing is PDF-only; if omitted, PDFs are conservatively checked for DRHP wording. Returns `202` with `{ documentId, status, createdAt }`.
- `GET /api/v1/documents/:documentId` — returns `{ documentId, filename, mediaType, status, createdAt, updatedAt, error? }`.
- `DELETE /api/v1/documents/:documentId` — deletes the document and returns `204`.
- `POST /api/v1/query` — JSON `{ question, documentIds?, topK? }`; returns exactly `{ question, answer, citations, ground_truth }`. Generic citations are `{ chunkId, text, score }`; DRHP citations also include `page`, the 1-based physical PDF page number. Citation text and score come from the original retrieved chunk and original-question cosine similarity.
- Errors use `{ error: { code, message, requestId } }`.

The mobile client should treat `documentId` as an opaque UUID and handle all four document states: `queued`, `processing`, `ready`, and `failed`.
Production responses always set `ground_truth` to `null`. An explicitly supplied `ground_truth` is accepted only when `EVALUATION_MODE=true`; keep evaluation mode disabled in production.

## Supported document extensions

Text, Markdown, HTML, CSV, XLSX, JSON, PDF, DOCX, and common source files (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.py`, `.java`, `.go`, `.rs`). CSV and XLSX rows include column labels in extracted text to preserve financial/table context across chunks. Parsers are registered in `src/documents/parsers.ts`; add an adapter there for additional formats.

DRHP PDFs use an isolated page-aware extractor in `src/documents/drhp.ts`; chunks retain zero-based internal PDF page indices, detected printed page labels, section titles, and a document-local chunk index. The API converts the internal index to a 1-based physical PDF page. Generic parsing and chunking are unchanged, and DOCX stays on the generic pipeline. The backend currently has no OCR engine: if a DRHP PDF contains a page with no extractable text, ingestion fails explicitly with `DRHP_OCR_REQUIRED` rather than indexing a silently incomplete document. The extractor avoids creating one concatenated full-document text string, but the upload and PDF bytes are still buffered, with `MAX_UPLOAD_BYTES` defaulting to 20 MiB. OCR, page-level retry/resume, and long-document progress are not implemented.

## MongoDB vector index

The backend uses MongoDB's `$vectorSearch` aggregation stage and expects a vector search index named by `MONGODB_VECTOR_INDEX` (default `rag_vector_index`) on the `chunks` collection. Configure the index for the `embedding` field as a vector field with the embedding dimension returned by the configured Ollama embedding model, and make `documentId` a filter field. Confirm that the selected local MongoDB server distribution/version supports vector search before starting the service; `/ready` checks MongoDB, Ollama embeddings, and the vector-search index rather than silently switching to an in-memory search.

For small local smoke tests only, set `VECTOR_SEARCH_MODE=exact_dev`. This explicitly scans MongoDB chunks and computes cosine similarity in the API process, refusing to search if the collection exceeds `MAX_EXACT_SEARCH_CHUNKS` (default `5000`). This mode is not suitable for production or large corpora; the default remains `mongodb` and requires the vector index above.

## Retrieval and answer grounding

Queries use vector and MongoDB text search. Compound questions are split into focused searches and merged with reciprocal-rank fusion. For DRHP processing, send the selected DRHP `documentIds`; only an all-DRHP selection uses the DRHP-specific path. DRHP uses an exact cosine scan over the selected document's existing embeddings so MongoDB Community can be used without Atlas vector search; `MAX_EXACT_SEARCH_CHUNKS` (default `5000`) bounds the scan. That path retrieves 15–20 candidates (`DRHP_RETRIEVAL_CANDIDATES`, default `18`), prefers relevant sections, and limits Gemma context to 4–6 chunks (`DRHP_CONTEXT_CHUNKS`, default `6`). `CITATION_RELEVANCE_THRESHOLD` (default `0.65`) controls relevance filtering.

DRHP answers are generated as atomic claims without model-selected citation IDs. A batched evidence validator checks each claim against the supplied chunks; application code then verifies claim/evidence overlap, maps evidence indexes to real MongoDB chunks, deduplicates citations, and emits their stored page and retrieval score. Unsupported claims are omitted. When retrieved context is insufficient, the DRHP response says so rather than asserting the information is absent from the entire prospectus. A DRHP record whose chunks lack page metadata returns a re-ingestion notice; existing chunks are not silently assigned estimated page numbers. Generic queries retain their existing answer/citation path.

## Run locally

1. Copy `.env.example` to `.env` and adjust settings if needed.
2. Start MongoDB with the vector search index described above.
3. Start Ollama and pull the configured models (`gemma4:12b-mlx` and `nomic-embed-text`).
4. Install and build:

   ```sh
   yarn install
   yarn build
   ```

5. Run the API and worker in separate terminals:

   ```sh
   yarn start
   yarn worker
   ```

For development, use `yarn dev` and `yarn worker:dev`. Set `API_KEY` to require `Authorization: Bearer <key>` on API routes. Do not embed a production secret in a distributed mobile application; integrate user-token authentication before exposing the service publicly.
