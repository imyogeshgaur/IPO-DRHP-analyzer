import type {
  Citation,
  QueryRequest,
  QueryResponse,
} from "../contracts/contracts.js";
import { config } from "../config/config.js";
import { AppError } from "../shared/errors.js";
import {
  RagDatabase,
  type LexicalSearchResult,
  type SearchResult,
} from "../infrastructure/mongo.js";
import {
  OllamaClient,
  type RelevanceCandidate,
} from "../infrastructure/ollama.js";

type ChunkMetadata = Omit<SearchResult, "score">;

type RankedChunk = {
  chunk: ChunkMetadata;
  reciprocalRankScore: number;
};

type QueryDatabase = Pick<
  RagDatabase,
  | "searchChunks"
  | "searchChunksExact"
  | "searchChunksLexical"
  | "scoreChunks"
> &
  Partial<Pick<RagDatabase, "getDocumentTypes">>;

type QueryOllama = Pick<
  OllamaClient,
  "embed" | "evaluateChunkRelevance" | "generateGroundedAnswer"
> &
  Partial<
    Pick<
      OllamaClient,
      | "evaluateChunkRelevanceByIndex"
      | "generateGroundedClaims"
      | "validateGroundedClaims"
    >
  >;

type QueryLog = (event: string, fields: Record<string, unknown>) => void;

type SupportedDrhpClaim = {
  claimIndex: number;
  text: string;
  chunkIds: string[];
};

type DrhpEvidenceValidation = {
  supportedClaims: SupportedDrhpClaim[];
  rejectedClaimIndexes: number[];
};

const ignoredSearchTerms = new Set([
  "about",
  "annual",
  "and",
  "are",
  "benefit",
  "combined",
  "does",
  "employee",
  "employees",
  "for",
  "from",
  "has",
  "have",
  "how",
  "many",
  "out",
  "that",
  "the",
  "their",
  "this",
  "total",
  "year",
  "years",
  "what",
  "when",
  "which",
  "with",
]);

const ignoredFactTerms = new Set([
  "a",
  "after",
  "all",
  "and",
  "are",
  "be",
  "between",
  "can",
  "customer",
  "customers",
  "each",
  "every",
  "for",
  "from",
  "how",
  "is",
  "it",
  "must",
  "of",
  "on",
  "should",
  "the",
  "to",
  "what",
  "which",
]);

export function buildSearchQueries(question: string): string[] {
  const subqueries = question
    .split(/\b(?:and|plus|as well as|combined with|along with)\b/i)
    .map((part) => part.replace(/^[\s,.:;?!]+|[\s,.:;?!]+$/g, "").trim())
    .filter((part) => part.split(/\s+/).length >= 2);

  return [...new Set([question.trim(), ...subqueries])].slice(0, 4);
}

export function lexicalCoverage(query: string, text: string): number {
  const queryTerms = [
    ...new Set(
      (query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (term) => term.length > 1 && !ignoredSearchTerms.has(term),
      ),
    ),
  ];
  if (queryTerms.length === 0) return 0;

  const textTerms = new Set(
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
  );
  const matches = queryTerms.filter((term) => textTerms.has(term)).length;
  return matches / queryTerms.length;
}

export function removeRedundantChunks<T extends ChunkMetadata>(
  chunks: T[],
): T[] {
  const retained: T[] = [];
  for (const candidate of chunks) {
    const duplicate = retained.some(
      (existing) =>
        existing.documentId === candidate.documentId &&
        (existing.section ?? "") === (candidate.section ?? "") &&
        substantiallyOverlaps(existing.text, candidate.text),
    );
    if (!duplicate) retained.push(candidate);
  }
  return retained;
}

export class QueryService {
  constructor(
    private readonly database: QueryDatabase,
    private readonly ollama: QueryOllama,
    private readonly log?: QueryLog,
  ) {}

  async query(request: QueryRequest): Promise<QueryResponse> {
    const isDrhpQuery = await this.isDrhpQuery(request);
    const searchQueries = buildSearchQueries(request.question);
    const embeddings = await this.ollama.embed(searchQueries);
    if (
      embeddings.length !== searchQueries.length ||
      embeddings.some((item) => !item)
    ) {
      throw new AppError(
        "INVALID_EMBEDDING_RESPONSE",
        "The model provider did not return an embedding for each search query",
        502,
      );
    }

    const originalQuestionEmbedding = embeddings[0];
    if (!originalQuestionEmbedding) {
      throw new AppError(
        "INVALID_EMBEDDING_RESPONSE",
        "The model provider returned no embedding for the original question",
        502,
      );
    }

    const topK = request.topK ?? 8;
    const retrievalLimit = isDrhpQuery
      ? config.drhpRetrievalCandidates
      : Math.min(
          config.maxRetrievalCandidates,
          Math.max(topK * 3, 12),
        );
    const rankedChunks = new Map<string, RankedChunk>();

    for (const [index, searchQuery] of searchQueries.entries()) {
      const embedding = embeddings[index];
      if (!embedding) {
        throw new AppError(
          "INVALID_EMBEDDING_RESPONSE",
          "The model provider returned no embedding for a search query",
          502,
        );
      }

      const [vectorResults, lexicalResults] = await Promise.all([
        config.vectorSearchMode === "exact_dev" || isDrhpQuery
          ? this.database.searchChunksExact(
              embedding,
              retrievalLimit,
              config.maxExactSearchChunks,
              request.documentIds,
            )
          : this.database.searchChunks(
              embedding,
              retrievalLimit,
              request.documentIds,
            ),
        this.database.searchChunksLexical(
          searchQuery,
          retrievalLimit,
          request.documentIds,
        ),
      ]);

      addRankedResults(rankedChunks, vectorResults);
      addRankedLexicalResults(rankedChunks, searchQuery, lexicalResults);
    }

    const candidateLimit = isDrhpQuery
      ? config.drhpRetrievalCandidates
      : config.maxRetrievalCandidates;
    const candidateMetadata = removeRedundantChunks(
      [...rankedChunks.values()]
        .sort((left, right) => {
          const leftScore =
            left.reciprocalRankScore +
            (isDrhpQuery
              ? Math.min(
                  drhpSectionPriority(request.question, left.chunk.section),
                  1,
                ) * 0.012
              : 0);
          const rightScore =
            right.reciprocalRankScore +
            (isDrhpQuery
              ? Math.min(
                  drhpSectionPriority(request.question, right.chunk.section),
                  1,
                ) * 0.012
              : 0);
          return rightScore - leftScore;
        })
        .map(({ chunk }) => chunk),
    ).slice(0, candidateLimit);
    const scoredCandidates = await this.database.scoreChunks(
      candidateMetadata.map((chunk) => chunk.chunkId),
      originalQuestionEmbedding,
    );

    if (scoredCandidates.length === 0) {
      return isDrhpQuery
        ? this.drhpInsufficientContextResponse(request)
        : this.unansweredResponse(request);
    }

    const scoredById = new Map(
      scoredCandidates.map((candidate) => [candidate.chunkId, candidate]),
    );
    const orderedScoredCandidates = candidateMetadata.flatMap((candidate) => {
      const scored = scoredById.get(candidate.chunkId);
      return scored ? [scored] : [];
    });
    const pageMappedCandidates = isDrhpQuery
      ? orderedScoredCandidates.filter(
          (candidate) => candidate.pdfPageIndex !== undefined,
        )
      : orderedScoredCandidates;
    if (isDrhpQuery && pageMappedCandidates.length === 0) {
      this.log?.("drhp.query.page_metadata_missing", {
        documentIds: request.documentIds,
        candidateIds: orderedScoredCandidates.map((candidate) => candidate.chunkId),
      });
      return this.drhpReindexResponse(request);
    }

    if (isDrhpQuery) {
      this.log?.("drhp.query.initial_candidates", {
        candidates: pageMappedCandidates.map((candidate) => ({
          chunkId: candidate.chunkId,
          score: candidate.score,
          page: candidate.pdfPageIndex === undefined
            ? undefined
            : candidate.pdfPageIndex + 1,
          section: candidate.section,
        })),
        excludedWithoutPage: orderedScoredCandidates
          .filter((candidate) => candidate.pdfPageIndex === undefined)
          .map((candidate) => candidate.chunkId),
      });
    }

    const candidateById = new Map(
      pageMappedCandidates.map((candidate) => [candidate.chunkId, candidate]),
    );
    const candidateForJudge: RelevanceCandidate[] = pageMappedCandidates.map(
      (chunk) => ({
        chunkId: chunk.chunkId,
        text: chunk.text,
        score: chunk.score,
        ...(chunk.section ? { section: chunk.section } : {}),
        ...(chunk.pdfPageIndex !== undefined
          ? { page: chunk.pdfPageIndex + 1 }
          : {}),
        ...(chunk.chunkIndex !== undefined
          ? { chunkIndex: chunk.chunkIndex }
          : {}),
      }),
    );
    const relevanceById = new Map<string, number>();
    if (isDrhpQuery) {
      if (!this.ollama.evaluateChunkRelevanceByIndex) {
        throw new AppError(
          "DRHP_RELEVANCE_EVALUATOR_UNAVAILABLE",
          "The DRHP relevance evaluator is not configured",
          503,
        );
      }
      const evaluations = await this.ollama.evaluateChunkRelevanceByIndex(
        request.question,
        candidateForJudge,
      );
      for (const evaluation of evaluations) {
        const candidate = pageMappedCandidates[evaluation.candidateIndex];
        if (!candidate) continue;
        relevanceById.set(
          candidate.chunkId,
          Math.max(
            relevanceById.get(candidate.chunkId) ?? 0,
            evaluation.relevance,
          ),
        );
      }
    } else {
      const relevanceEvaluations =
        await this.ollama.evaluateChunkRelevance(
          request.question,
          candidateForJudge,
        );
      for (const evaluation of relevanceEvaluations) {
        if (!candidateById.has(evaluation.chunkId)) continue;
        relevanceById.set(
          evaluation.chunkId,
          Math.max(
            relevanceById.get(evaluation.chunkId) ?? 0,
            evaluation.relevance,
          ),
        );
      }
    }

    const relevantChunks = pageMappedCandidates.filter(
      (chunk) =>
        (relevanceById.get(chunk.chunkId) ?? 0) >=
        config.citationRelevanceThreshold,
    );
    if (isDrhpQuery) {
      return this.answerDrhpQuestion(
        request,
        pageMappedCandidates,
        relevantChunks,
        relevanceById,
      );
    }

    const selectedChunks = removeRedundantEvidence(
      relevantChunks,
      request.question,
    );
    if (selectedChunks.length === 0) {
      return this.unansweredResponse(request);
    }

    const groundedAnswer = await this.ollama.generateGroundedAnswer(
      request.question,
      selectedChunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        text: chunk.text,
        score: chunk.score,
        ...(chunk.section ? { section: chunk.section } : {}),
      })),
    );
    const relevantById = new Map(
      selectedChunks.map((chunk) => [chunk.chunkId, chunk]),
    );
    const citedIds = [...new Set(groundedAnswer.citedChunkIds)].filter((id) =>
      relevantById.has(id),
    );
    if (citedIds.length === 0) {
      return this.unansweredResponse(request);
    }
    const citations: Citation[] = citedIds.flatMap((id) => {
      const chunk = relevantById.get(id);
      return chunk
        ? [{ chunkId: chunk.chunkId, text: chunk.text, score: chunk.score }]
        : [];
    });

    return {
      question: request.question,
      answer: groundedAnswer.answer,
      citations,
      ground_truth: config.evaluationMode
        ? (request.ground_truth ?? null)
        : null,
    };
  }

  private async isDrhpQuery(request: QueryRequest): Promise<boolean> {
    if (!request.documentIds?.length || !this.database.getDocumentTypes) {
      return false;
    }

    const documentIds = [...new Set(request.documentIds)];
    const documents = await this.database.getDocumentTypes(documentIds);
    return (
      documents.length === documentIds.length &&
      documents.every(
        (document) =>
          document.documentType === "drhp" ||
          (document.documentType === undefined &&
            document.extension.toLocaleLowerCase() === ".pdf" &&
            /\b(?:DRHP|Draft Red Herring Prospectus)\b/i.test(
              document.filename,
            )),
      )
    );
  }

  private async answerDrhpQuestion(
    request: QueryRequest,
    candidates: SearchResult[],
    relevantCandidates: SearchResult[],
    relevanceById: Map<string, number>,
  ): Promise<QueryResponse> {
    const rerankedCandidates = relevantCandidates
      .sort((left, right) =>
        drhpRerankScore(request.question, right, relevanceById) -
        drhpRerankScore(request.question, left, relevanceById),
      );
    const deduplicated = deduplicateDrhpEvidence(rerankedCandidates);
    const context = selectDrhpContext(
      deduplicated,
      candidates,
      relevanceById,
      request.question,
      config.drhpContextChunks,
    );
    this.log?.("drhp.query.reranked_candidates", {
      candidates: rerankedCandidates.map((candidate) => ({
        chunkId: candidate.chunkId,
        retrievalScore: candidate.score,
        relevance: relevanceById.get(candidate.chunkId) ?? 0,
        rerankScore: drhpRerankScore(
          request.question,
          candidate,
          relevanceById,
        ),
        section: candidate.section,
        page: candidate.pdfPageIndex === undefined
          ? undefined
          : candidate.pdfPageIndex + 1,
      })),
      removedByRelevance: candidates
        .filter(
          (candidate) =>
            (relevanceById.get(candidate.chunkId) ?? 0) <
            config.citationRelevanceThreshold,
        )
        .map((candidate) => candidate.chunkId),
      removedAsDuplicate: rerankedCandidates
        .filter((candidate) => !deduplicated.some((kept) => kept.chunkId === candidate.chunkId))
        .map((candidate) => candidate.chunkId),
      finalContextIds: context.map((candidate) => candidate.chunkId),
    });

    if (context.length === 0) {
      this.log?.("drhp.query.evidence_missing", {
        documentIds: request.documentIds,
      });
      return this.drhpInsufficientContextResponse(request);
    }
    if (!this.ollama.generateGroundedClaims || !this.ollama.validateGroundedClaims) {
      throw new AppError(
        "DRHP_CLAIM_VALIDATOR_UNAVAILABLE",
        "The DRHP answer and citation validators are not configured",
        503,
      );
    }

    const contextForModel = context.map((chunk) =>
      asRelevanceCandidate(chunk),
    );
    const generated = await this.ollama.generateGroundedClaims(
      request.question,
      contextForModel,
    );
    if (generated.claims.length === 0) {
      this.log?.("drhp.query.answer_insufficient", {
        documentIds: request.documentIds,
        reason: "model returned no evidence-grounded claims",
      });
      return this.drhpInsufficientContextResponse(request);
    }

    const validations = await this.ollama.validateGroundedClaims(
      request.question,
      generated.claims,
      contextForModel,
    );
    const validated = validateDrhpClaims(
      generated.claims,
      validations,
      context,
    );
    this.log?.("drhp.query.citation_validation", {
      claims: generated.claims.map((_claim, claimIndex) => ({
        claimIndex,
        supported: validated.supportedClaims.some(
          (claim) => claim.claimIndex === claimIndex,
        ),
        chunkIds:
          validated.supportedClaims.find(
            (claim) => claim.claimIndex === claimIndex,
          )?.chunkIds ?? [],
      })),
      rejectedClaimIndexes: validated.rejectedClaimIndexes,
    });

    if (validated.supportedClaims.length === 0) {
      this.log?.("drhp.query.evidence_missing", {
        documentIds: request.documentIds,
        reason: "no generated claim passed evidence validation",
      });
      return this.drhpInsufficientContextResponse(request);
    }

    const evidenceById = new Map(
      context.map((chunk) => [chunk.chunkId, chunk]),
    );
    const citedChunks = deduplicateDrhpEvidence(
      validated.supportedClaims
        .flatMap((claim) => claim.chunkIds)
        .flatMap((chunkId) => {
          const chunk = evidenceById.get(chunkId);
          return chunk ? [chunk] : [];
        }),
    );
    if (citedChunks.length === 0) {
      this.log?.("drhp.query.evidence_missing", {
        documentIds: request.documentIds,
        reason: "validated claims did not map to retrieved chunks",
      });
      return this.drhpInsufficientContextResponse(request);
    }

    const citations: Citation[] = citedChunks.flatMap((chunk) =>
      chunk.pdfPageIndex === undefined
        ? []
        : [{
            chunkId: chunk.chunkId,
            page: chunk.pdfPageIndex + 1,
            text: chunk.text,
            score: chunk.score,
          }],
    );
    if (citations.length === 0) {
      return this.drhpReindexResponse(request);
    }
    this.log?.("drhp.query.final_citations", {
      citations: citations.map(({ chunkId, page, score }) => ({
        chunkId,
        page,
        score,
      })),
    });

    return {
      question: request.question,
      answer: validated.supportedClaims
        .map((claim) => claim.text)
        .join(" "),
      citations,
      ground_truth: config.evaluationMode
        ? (request.ground_truth ?? null)
        : null,
    };
  }

  private unansweredResponse(request: QueryRequest): QueryResponse {
    return {
      question: request.question,
      answer: "Sorry, this information is not present in the document you uploaded",
      citations: [],
      ground_truth: config.evaluationMode
        ? (request.ground_truth ?? null)
        : null,
    };
  }

  private drhpInsufficientContextResponse(
    request: QueryRequest,
  ): QueryResponse {
    return {
      question: request.question,
      answer: "The available DRHP context is insufficient to answer this question.",
      citations: [],
      ground_truth: config.evaluationMode
        ? (request.ground_truth ?? null)
        : null,
    };
  }

  private drhpReindexResponse(request: QueryRequest): QueryResponse {
    return {
      question: request.question,
      answer:
        "This DRHP needs to be re-ingested to restore page metadata for verified citations.",
      citations: [],
      ground_truth: config.evaluationMode
        ? (request.ground_truth ?? null)
        : null,
    };
  }
}

function asRelevanceCandidate(chunk: SearchResult): RelevanceCandidate {
  return {
    chunkId: chunk.chunkId,
    text: chunk.text,
    score: chunk.score,
    ...(chunk.section ? { section: chunk.section } : {}),
    ...(chunk.pdfPageIndex !== undefined
      ? { page: chunk.pdfPageIndex + 1 }
      : {}),
    ...(chunk.chunkIndex !== undefined
      ? { chunkIndex: chunk.chunkIndex }
      : {}),
  };
}

function drhpSectionPriority(question: string, section?: string): number {
  if (!section) return 0;
  const query = question.toLocaleLowerCase();
  const title = section.toLocaleLowerCase();
  const preferences: Array<{ query: RegExp; sections: string[] }> = [
    {
      query: /manufactur|facilit|factory|production|supplier|vendor|raw material|procurement/,
      sections: ["our business", "risk factors"],
    },
    {
      query: /revenue|financial|profit|loss|ebitda|eps|margin|cash flow/,
      sections: [
        "financial information",
        "summary of restated",
        "summary of financial information",
        "basis for issue price",
      ],
    },
    {
      query: /registered office|corporate identity|cin\b|incorporat|address/,
      sections: ["general information", "about our company", "legal and other information"],
    },
    {
      query: /objects?|fresh issue|proceeds|allocation/,
      sections: ["objects of the offer", "objects of the issue"],
    },
    {
      query: /third.party|supplier|vendor|dependency|risk/,
      sections: ["risk factors", "our business"],
    },
  ];

  return preferences.reduce((priority, preference) => {
    if (
      preference.query.test(query) &&
      preference.sections.some((preferred) => title.includes(preferred))
    ) {
      return priority + 1;
    }
    return priority;
  }, 0);
}

function drhpRerankScore(
  question: string,
  candidate: SearchResult,
  relevanceById: Map<string, number>,
): number {
  const relevance = relevanceById.get(candidate.chunkId) ?? 0;
  const sectionPriority = drhpSectionPriority(question, candidate.section);
  return relevance * 0.75 + Math.min(sectionPriority, 1) * 0.15 + candidate.score * 0.1;
}

function deduplicateDrhpEvidence<T extends SearchResult>(chunks: T[]): T[] {
  const retained: T[] = [];
  const seenIds = new Set<string>();
  for (const candidate of chunks) {
    if (seenIds.has(candidate.chunkId)) continue;
    const duplicate = retained.some(
      (existing) =>
        existing.documentId === candidate.documentId &&
        substantiallyOverlaps(existing.text, candidate.text),
    );
    if (duplicate) continue;
    seenIds.add(candidate.chunkId);
    retained.push(candidate);
  }
  return retained;
}

function selectDrhpContext(
  ranked: SearchResult[],
  allCandidates: SearchResult[],
  relevanceById: Map<string, number>,
  question: string,
  contextLimit: number,
): SearchResult[] {
  const selected: SearchResult[] = [];
  const selectedIds = new Set<string>();

  for (const candidate of ranked) {
    if (selected.length >= contextLimit) break;
    add(candidate);

    const chunkIndex = candidate.chunkIndex;
    if (chunkIndex === undefined || !candidate.section) continue;
    const neighbors = allCandidates
      .filter(
        (other) =>
          other.documentId === candidate.documentId &&
          other.section === candidate.section &&
          other.chunkIndex !== undefined &&
          Math.abs(other.chunkIndex - chunkIndex) === 1 &&
          (relevanceById.get(other.chunkId) ?? 0) >=
            config.citationRelevanceThreshold - 0.1,
      )
      .sort(
        (left, right) =>
          drhpRerankScore(question, right, relevanceById) -
          drhpRerankScore(question, left, relevanceById),
      );
    for (const neighbor of neighbors) {
      if (selected.length >= contextLimit) break;
      add(neighbor);
    }
  }

  return selected;

  function add(candidate: SearchResult): void {
    if (selectedIds.has(candidate.chunkId)) return;
    if (
      deduplicateDrhpEvidence([...selected, candidate]).length ===
      selected.length
    ) {
      return;
    }
    selected.push(candidate);
    selectedIds.add(candidate.chunkId);
  }
}

function validateDrhpClaims(
  claims: string[],
  validations: Array<{ claimIndex: number; evidenceIndexes: number[] }>,
  candidates: SearchResult[],
): DrhpEvidenceValidation {
  const evidenceIndexesByClaim = new Map<number, Set<number>>();
  for (const validation of validations) {
    if (validation.claimIndex < 0 || validation.claimIndex >= claims.length) {
      continue;
    }
    const indexes = evidenceIndexesByClaim.get(validation.claimIndex) ?? new Set();
    for (const evidenceIndex of validation.evidenceIndexes) {
      if (evidenceIndex >= 0 && evidenceIndex < candidates.length) {
        indexes.add(evidenceIndex);
      }
    }
    evidenceIndexesByClaim.set(validation.claimIndex, indexes);
  }

  const supportedClaims: SupportedDrhpClaim[] = [];
  const rejectedClaimIndexes: number[] = [];
  claims.forEach((claim, claimIndex) => {
    const evidenceIndexes = evidenceIndexesByClaim.get(claimIndex);
    const evidence = [...(evidenceIndexes ?? [])].flatMap((index) => {
      const candidate = candidates[index];
      return candidate ? [candidate] : [];
    });
    const supportingEvidence = supportingEvidenceForClaim(claim, evidence);
    if (supportingEvidence.length === 0) {
      rejectedClaimIndexes.push(claimIndex);
      return;
    }
    supportedClaims.push({
      claimIndex,
      text: claim,
      chunkIds: deduplicateDrhpEvidence(supportingEvidence).map(
        (candidate) => candidate.chunkId,
      ),
    });
  });

  return { supportedClaims, rejectedClaimIndexes };
}

function supportingEvidenceForClaim(
  claim: string,
  evidence: SearchResult[],
): SearchResult[] {
  const claimTerms = drhpFactTerms(claim);
  if (claimTerms.size < 2) return [];
  const claimNumbers = extractNumberTokens(claim);
  const claimIsNegated = hasNegation(claim);
  const claimEntities = extractDrhpEntities(claim);
  const rankedEvidence = evidence.flatMap((chunk) => {
    const chunkTerms = drhpFactTerms(chunk.text);
    const sharedTerms = [...claimTerms].filter((term) => chunkTerms.has(term));
    const chunkNumbers = extractNumberTokens(chunk.text);
    const sharedNumbers = [...claimNumbers].filter((number) =>
      numberMatchesAny(number, chunkNumbers),
    );
    const chunkEntities = extractDrhpEntities(chunk.text);
    const sharedEntities = [...claimEntities].filter((entity) =>
      chunkEntities.has(entity),
    );
    if (
      sharedTerms.length < Math.min(2, claimTerms.size) ||
      (claimNumbers.size > 0 && sharedNumbers.length === 0) ||
      (claimIsNegated && !hasNegation(chunk.text))
    ) {
      return [];
    }
    return [{ chunk, sharedTerms, sharedNumbers, sharedEntities }];
  });
  rankedEvidence.sort(
    (left, right) =>
      right.sharedNumbers.length - left.sharedNumbers.length ||
      right.sharedTerms.length - left.sharedTerms.length ||
      right.chunk.score - left.chunk.score,
  );

  const supporting: SearchResult[] = [];
  const coveredTerms = new Set<string>();
  const coveredNumbers = new Set<string>();
  const coveredEntities = new Set<string>();
  for (const item of rankedEvidence) {
    const addsTerms = item.sharedTerms.some((term) => !coveredTerms.has(term));
    const addsNumbers = item.sharedNumbers.some(
      (number) => !coveredNumbers.has(number),
    );
    const addsEntities = item.sharedEntities.some(
      (entity) => !coveredEntities.has(entity),
    );
    if (!addsTerms && !addsNumbers && !addsEntities) continue;
    supporting.push(item.chunk);
    item.sharedTerms.forEach((term) => coveredTerms.add(term));
    item.sharedNumbers.forEach((number) => coveredNumbers.add(number));
    item.sharedEntities.forEach((entity) => coveredEntities.add(entity));
    if (
      coveredTerms.size / claimTerms.size >= 0.4 &&
      [...claimNumbers].every((number) => coveredNumbers.has(number)) &&
      [...claimEntities].every((entity) => coveredEntities.has(entity))
    ) {
      break;
    }
  }

  const allNumbersSupported = [...claimNumbers].every((number) =>
    coveredNumbers.has(number),
  );
  const allEntitiesSupported = [...claimEntities].every((entity) =>
    coveredEntities.has(entity),
  );
  if (
    coveredTerms.size / claimTerms.size < 0.4 ||
    !allNumbersSupported ||
    !allEntitiesSupported
  ) {
    return [];
  }
  return supporting;
}

function drhpFactTerms(text: string): Set<string> {
  const ignoredTerms = new Set([
    ...ignoredFactTerms,
    "also",
    "among",
    "company",
    "could",
    "during",
    "following",
    "has",
    "have",
    "into",
    "more",
    "our",
    "reported",
    "than",
    "their",
    "there",
    "these",
    "they",
    "was",
    "were",
    "will",
  ]);
  const tokens = text.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? [];
  return new Set(
    tokens
      .map((token) => {
        if (token.endsWith("ies") && token.length > 5) {
          return `${token.slice(0, -3)}y`;
        }
        if (token.endsWith("ing") && token.length > 6) {
          return token.slice(0, -3);
        }
        if (token.endsWith("ed") && token.length > 5) {
          return token.slice(0, -2);
        }
        if (token.endsWith("s") && token.length > 4) {
          return token.slice(0, -1);
        }
        return token;
      })
      .filter((token) => token.length > 2 && !ignoredTerms.has(token)),
  );
}

function extractNumberTokens(text: string): Set<string> {
  return new Set(
    (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((number) =>
      number.replace(/,/g, ""),
    ),
  );
}

function numberMatchesAny(claimNumber: string, chunkNumbers: Set<string>): boolean {
  if (chunkNumbers.has(claimNumber)) return true;
  const target = Number(claimNumber);
  if (!Number.isFinite(target)) return false;
  // Ignore exact calendar years from fuzzy rounding tolerance
  if (Number.isInteger(target) && target >= 1900 && target <= 2100) {
    return false;
  }
  const tolerance = Math.max(0.11, Math.abs(target) * 0.005);
  for (const candidate of chunkNumbers) {
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed)) continue;
    if (Math.abs(parsed - target) <= tolerance) return true;
  }
  return false;
}

function extractDrhpEntities(text: string): Set<string> {
  const ignoredEntities = new Set([
    "As",
    "Company",
    "Consolidated",
    "Financial",
    "Facilities",
    "Facility",
    "Fresh",
    "Identity",
    "Issue",
    "Lenskart",
    "Number",
    "Net",
    "Office",
    "Offer",
    "Our",
    "Price",
    "Proceeds",
    "Registered",
    "Reliance",
    "Revenue",
    "Restated",
    "The",
    "Year",
  ]);
  return new Set(
    (text.match(/\b[A-Z][a-z]{2,}\b/g) ?? [])
      .filter((entity) => !ignoredEntities.has(entity))
      .map((entity) => entity.toLocaleLowerCase()),
  );
}

function hasNegation(text: string): boolean {
  return /\b(?:not|no|never|without|neither|cannot|unable|lack(?:s|ed)?)\b/i.test(
    text,
  );
}

export function queryFailureResponse(request: QueryRequest): QueryResponse {
  return {
    question: request.question,
    answer: "Something went wrong",
    citations: [],
    ground_truth: config.evaluationMode
      ? (request.ground_truth ?? null)
      : null,
  };
}

function addRankedResults(
  results: Map<string, RankedChunk>,
  chunks: SearchResult[],
): void {
  chunks.forEach((result, index) => {
    addRankedChunk(
      results,
      result,
      1 / (60 + index + 1),
    );
  });
}

function addRankedLexicalResults(
  results: Map<string, RankedChunk>,
  query: string,
  chunks: LexicalSearchResult[],
): void {
  chunks.forEach((result, index) => {
    const coverage = lexicalCoverage(query, result.text);
    addRankedChunk(
      results,
      result,
      (1 / (60 + index + 1)) * (1 + coverage),
    );
  });
}

function addRankedChunk(
  results: Map<string, RankedChunk>,
  chunk: ChunkMetadata,
  score: number,
): void {
  const existing = results.get(chunk.chunkId);
  if (existing) {
    existing.reciprocalRankScore += score;
    return;
  }

  results.set(chunk.chunkId, {
    chunk,
    reciprocalRankScore: score,
  });
}

export function removeRedundantEvidence<T extends SearchResult>(
  chunks: T[],
  question: string,
): T[] {
  const questionTerms = factTerms(question);
  return chunks.filter((candidate, candidateIndex) => {
    const candidateFacts = evidenceFragments(candidate.text).filter((fact) =>
      isRelevantFact(fact, questionTerms),
    );
    if (candidateFacts.length === 0) return true;

    return !chunks.some((other, otherIndex) => {
      if (
        otherIndex === candidateIndex ||
        other.documentId !== candidate.documentId
      ) {
        return false;
      }

      const otherFacts = evidenceFragments(other.text);
      const duplicateFacts = candidateFacts.filter((fact) =>
        otherFacts.some((otherFact) => sameFact(fact, otherFact)),
      ).length;
      const allFactsDuplicated = duplicateFacts === candidateFacts.length;
      if (!allFactsDuplicated) return false;

      if (isFaqChunk(candidate.text) !== isFaqChunk(other.text)) {
        return isFaqChunk(candidate.text);
      }
      return otherIndex < candidateIndex;
    });
  });
}

function substantiallyOverlaps(left: string, right: string): boolean {
  const normalizedLeft = normalizeChunkText(left);
  const normalizedRight = normalizeChunkText(right);
  if (normalizedLeft === normalizedRight) return true;

  const leftTerms = new Set(normalizedLeft.split(" "));
  const rightTerms = new Set(normalizedRight.split(" "));
  const smallerSet = leftTerms.size <= rightTerms.size ? leftTerms : rightTerms;
  const largerSet = smallerSet === leftTerms ? rightTerms : leftTerms;
  if (smallerSet.size === 0) return true;

  let sharedTerms = 0;
  for (const term of smallerSet) {
    if (largerSet.has(term)) sharedTerms += 1;
  }
  const termCoverage = sharedTerms / smallerSet.size;
  const lengthRatio =
    Math.min(normalizedLeft.length, normalizedRight.length) /
    Math.max(normalizedLeft.length, normalizedRight.length);
  return termCoverage >= 0.9 && lengthRatio >= 0.8;
}

function evidenceFragments(text: string): string[] {
  const fragments: string[] = [];
  const questionAnswerPattern = /Q:\s*([^\n]+)\s*A:\s*([^\n]+)/gi;
  for (const match of text.matchAll(questionAnswerPattern)) {
    const question = match[1];
    const answer = match[2];
    if (question && answer) fragments.push(`${question} ${answer}`);
  }

  const remainingText = text.replace(questionAnswerPattern, " ");
  fragments.push(
    ...remainingText
      .split(/[\n.!?;]+/)
      .map((fragment) => fragment.trim())
      .filter(Boolean),
  );
  return fragments;
}

function isRelevantFact(fact: string, questionTerms: Set<string>): boolean {
  const terms = factTerms(fact);
  let matches = 0;
  for (const term of terms) {
    if (questionTerms.has(term)) matches += 1;
  }
  return matches >= Math.min(2, questionTerms.size);
}

function sameFact(left: string, right: string): boolean {
  const leftNumbers = [...new Set(left.match(/\d+(?:[.,]\d+)?/g) ?? [])].sort();
  const rightNumbers = [...new Set(right.match(/\d+(?:[.,]\d+)?/g) ?? [])].sort();
  if (
    leftNumbers.length === 0 ||
    leftNumbers.length !== rightNumbers.length ||
    leftNumbers.some((number, index) => number !== rightNumbers[index])
  ) {
    return false;
  }

  const leftTerms = factTerms(left);
  const rightTerms = factTerms(right);
  const smallerTerms =
    leftTerms.size <= rightTerms.size ? leftTerms : rightTerms;
  const largerTerms = smallerTerms === leftTerms ? rightTerms : leftTerms;
  if (smallerTerms.size === 0) return false;
  let sharedTerms = 0;
  for (const term of smallerTerms) {
    if (largerTerms.has(term)) sharedTerms += 1;
  }
  return sharedTerms / smallerTerms.size >= 0.6;
}

function factTerms(text: string): Set<string> {
  const terms = text.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? [];
  return new Set(
    terms
      .map((term) => {
        if (term === "loyalty") return "reward";
        if (term === "value") return "worth";
        if (term === "storage" || term === "stored") return "store";
        return term.endsWith("s") && term.length > 4
          ? term.slice(0, -1)
          : term;
      })
      .filter((term) => term.length > 2 && !ignoredFactTerms.has(term)),
  );
}

function isFaqChunk(text: string): boolean {
  return /(?:frequently asked questions|\bFAQ\b|Q:)/i.test(text);
}

function normalizeChunkText(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
