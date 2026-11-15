import assert from "node:assert/strict";
import test from "node:test";
import type { QueryRequest } from "../contracts/contracts.js";
import type {
  LexicalSearchResult,
  SearchResult,
} from "../infrastructure/mongo.js";
import type {
  GroundedAnswer,
  RelevanceCandidate,
  RelevanceEvaluation,
} from "../infrastructure/ollama.js";
import {
  buildSearchQueries,
  lexicalCoverage,
  QueryService,
  queryFailureResponse,
  removeRedundantEvidence,
  removeRedundantChunks,
} from "./query.js";

test("compound questions produce focused retrieval queries", () => {
  const question =
    "Compare Basic membership and Premium membership discounts and reward points.";
  const queries = buildSearchQueries(question);

  assert.equal(queries.length, 4);
  assert.match(queries[1] ?? "", /Basic membership/i);
  assert.match(queries[2] ?? "", /Premium membership discounts/i);
  assert.match(queries[3] ?? "", /reward points/i);
});

test("lexical coverage detects exact evidence and rejects unrelated text", () => {
  assert.equal(
    lexicalCoverage(
      "maximum certification reimbursement",
      "Maximum certification reimbursement is ₹50,000.",
    ),
    1,
  );
  assert.equal(lexicalCoverage("CEO name", "Casual leave policy"), 0);
});

test("overlap removal preserves separate sections and documents", () => {
  const chunks = [
    result("a", "doc-1", "Memberships", "Premium is 5% off eligible groceries."),
    result("b", "doc-1", "Memberships", "Premium is 5% off eligible groceries."),
    result("c", "doc-1", "Rewards", "Premium is 5% off eligible groceries."),
    result("d", "doc-2", "Memberships", "Premium is 5% off eligible groceries."),
  ];

  const kept = removeRedundantChunks(chunks);
  assert.deepEqual(kept.map((chunk) => chunk.chunkId), ["a", "c", "d"]);
});

test("duplicate FAQ evidence yields to the detailed policy chunk", () => {
  const policy = result(
    "warehouse-policy",
    "doc-1",
    "Warehouse",
    "Dairy products must be stored between 2°C and 6°C.",
  );
  const faq = result(
    "faq",
    "doc-1",
    "FAQ",
    "Frequently Asked Questions\nQ: What is the temperature range for dairy products?\nA: Between 2°C and 6°C.\nQ: What is the minimum order value?\nA: ₹299.",
  );

  assert.deepEqual(
    removeRedundantEvidence(
      [policy, faq],
      "What is the dairy product storage temperature?",
    ).map((chunk) => chunk.chunkId),
    ["warehouse-policy"],
  );
});

test("multi-hop retrieval filters irrelevant chunks and returns the strict API shape", async () => {
  const basic = result(
    "basic",
    "doc-1",
    "Memberships",
    "Basic costs ₹499 yearly and gives a 2% discount on eligible grocery products.",
    0.91,
  );
  const premium = result(
    "premium",
    "doc-1",
    "Memberships",
    "Premium costs ₹999 yearly and gives a 5% discount on eligible grocery products.",
    0.74,
  );
  const support = result(
    "support",
    "doc-1",
    "Customer support",
    "Customer support is open seven days a week from 8 AM to 10 PM.",
    0.88,
  );
  const allChunks = [basic, premium, support];
  const lexicalResults: LexicalSearchResult[] = [];
  let judged: RelevanceCandidate[] = [];
  let used: RelevanceCandidate[] = [];
  const database = {
    searchChunks: async () => allChunks,
    searchChunksExact: async () => allChunks,
    searchChunksLexical: async () => lexicalResults,
    scoreChunks: async (ids: string[]) =>
      allChunks.filter((chunk) => ids.includes(chunk.chunkId)),
  };
  const ollama = {
    embed: async (queries: string[]) => queries.map(() => [1, 0]),
    evaluateChunkRelevance: async (
      _question: string,
      candidates: RelevanceCandidate[],
    ): Promise<RelevanceEvaluation[]> => {
      judged = candidates;
      return candidates.map((chunk) => ({
        chunkId: chunk.chunkId,
        relevance: chunk.chunkId === "support" ? 0.05 : 0.95,
      }));
    },
    generateGroundedAnswer: async (
      _question: string,
      evidence: RelevanceCandidate[],
    ): Promise<GroundedAnswer> => {
      used = evidence;
      return {
        answer: "Basic is 2% off and Premium is 5% off eligible groceries.",
        citedChunkIds: ["basic", "premium", "fabricated-id"],
      };
    },
  };

  const service = new QueryService(database, ollama);
  const request: QueryRequest = {
    question: "Compare Basic and Premium membership discounts.",
  };
  const response = await service.query(request);

  assert.ok(judged.some((chunk) => chunk.chunkId === "support"));
  assert.deepEqual(
    used.map((chunk) => chunk.chunkId),
    ["basic", "premium"],
  );
  assert.deepEqual(Object.keys(response), [
    "question",
    "answer",
    "citations",
    "ground_truth",
  ]);
  assert.deepEqual(
    response.citations.map((citation) => citation.chunkId),
    ["basic", "premium"],
  );
  assert.deepEqual(Object.keys(response.citations[0] ?? {}), [
    "chunkId",
    "text",
    "score",
  ]);
  assert.equal(response.citations[1]?.score, 0.74);
  assert.equal(response.ground_truth, null);
});

test("multi-hop reward calculations retain complementary evidence", async () => {
  const earningRule = result(
    "earning-rule",
    "doc-1",
    "Rewards",
    "Customers earn 1 point for every ₹100 spent on eligible purchases.",
    0.88,
  );
  const pointValue = result(
    "point-value",
    "doc-1",
    "Rewards",
    "Each reward point is worth ₹1.",
    0.66,
  );
  const allChunks = [earningRule, pointValue];
  const database = {
    searchChunks: async () => allChunks,
    searchChunksExact: async () => allChunks,
    searchChunksLexical: async () => [],
    scoreChunks: async (ids: string[]) =>
      allChunks.filter((chunk) => ids.includes(chunk.chunkId)),
  };
  const ollama = {
    embed: async (queries: string[]) => queries.map(() => [1, 0]),
    evaluateChunkRelevance: async (
      _question: string,
      chunks: RelevanceCandidate[],
    ) => chunks.map((chunk) => ({ chunkId: chunk.chunkId, relevance: 0.9 })),
    generateGroundedAnswer: async (
      _question: string,
      chunks: RelevanceCandidate[],
    ) => ({
      answer: "They earn 25 points worth ₹25.",
      citedChunkIds: chunks.map((chunk) => chunk.chunkId),
    }),
  };

  const response = await new QueryService(database, ollama).query({
    question:
      "A customer spends ₹2,500 on eligible purchases. How many reward points will they earn and what is their monetary value?",
  });
  assert.deepEqual(
    response.citations.map((citation) => citation.chunkId),
    ["earning-rule", "point-value"],
  );
});

test("low-similarity evidence is kept when the relevance evaluator supports it", async () => {
  const lowSimilarity = result(
    "warehouse-temp",
    "doc-1",
    "Warehouse",
    "Dairy products must be stored between 2°C and 6°C.",
    0.41,
  );
  const database = {
    searchChunks: async () => [lowSimilarity],
    searchChunksExact: async () => [lowSimilarity],
    searchChunksLexical: async () => [],
    scoreChunks: async () => [lowSimilarity],
  };
  const ollama = {
    embed: async (queries: string[]) => queries.map(() => [1, 0]),
    evaluateChunkRelevance: async () => [
      { chunkId: lowSimilarity.chunkId, relevance: 0.96 },
    ],
    generateGroundedAnswer: async () => ({
      answer: "Dairy products should be stored between 2°C and 6°C.",
      citedChunkIds: [lowSimilarity.chunkId],
    }),
  };
  const response = await new QueryService(database, ollama).query({
    question: "What is the dairy product storage temperature?",
  });

  assert.equal(response.citations[0]?.chunkId, "warehouse-temp");
  assert.equal(response.citations[0]?.score, 0.41);
});

test("missing information returns no invented citations", async () => {
  const unrelated = result(
    "support-policy",
    "doc-1",
    "Customer support",
    "Customer support operates seven days a week.",
    0.91,
  );
  const database = {
    searchChunks: async () => [unrelated],
    searchChunksExact: async () => [unrelated],
    searchChunksLexical: async () => [],
    scoreChunks: async () => [unrelated],
  };
  const ollama = {
    embed: async (queries: string[]) => queries.map(() => [1, 0]),
    evaluateChunkRelevance: async () => [
      { chunkId: unrelated.chunkId, relevance: 0.1 },
    ],
    generateGroundedAnswer: async () => {
      assert.fail("Generation should not run when all candidates are irrelevant");
    },
  };
  const response = await new QueryService(database, ollama).query({
    question: "Who is GreenCart's CEO?",
  });

  assert.equal(
    response.answer,
    "Sorry, this information is not present in the document you uploaded",
  );
  assert.deepEqual(response.citations, []);
});

test("an answer without a valid citation is converted to an abstention", async () => {
  const evidence = result(
    "policy-1",
    "doc-1",
    "Policy",
    "Premium members receive a 5% discount on eligible grocery products.",
  );
  const database = {
    searchChunks: async () => [evidence],
    searchChunksExact: async () => [evidence],
    searchChunksLexical: async () => [],
    scoreChunks: async () => [evidence],
  };
  const ollama = {
    embed: async (queries: string[]) => queries.map(() => [1, 0]),
    evaluateChunkRelevance: async () => [
      { chunkId: evidence.chunkId, relevance: 0.9 },
    ],
    generateGroundedAnswer: async () => ({
      answer: "Premium offers a 5% discount.",
      citedChunkIds: ["unknown-id"],
    }),
  };

  const response = await new QueryService(database, ollama).query({
    question: "What discount does Premium provide?",
  });
  assert.equal(
    response.answer,
    "Sorry, this information is not present in the document you uploaded",
  );
  assert.deepEqual(response.citations, []);
});

test("query processing failures use the generic message and no citations", () => {
  const response = queryFailureResponse({
    question: "What is in this document?",
  });

  assert.deepEqual(response, {
    question: "What is in this document?",
    answer: "Something went wrong",
    citations: [],
    ground_truth: null,
  });
});

test("DRHP manufacturing answer cites only location evidence with its PDF page", async () => {
  const trace = {
    exactSearchCalls: 0,
    vectorSearchCalls: 0,
    documentFilters: [] as Array<string[] | undefined>,
  };
  const manufacturing = drhpResult(
    "manufacturing-locations",
    "OUR BUSINESS",
    "We manufacture prescription eyeglasses at our centralized manufacturing facilities at Bhiwadi, Rajasthan and Gurugram, Haryana.",
    283,
    0.82,
    100,
  );
  const finance = drhpResult(
    "financial-revenue",
    "FINANCIAL INFORMATION",
    "Revenue from operations was ₹66,525.17 million in Financial Year 2025.",
    108,
    0.95,
    200,
  );
  const response = await runDrhpQuery({
    question: "Where are Lenskart's manufacturing facilities located?",
    chunks: [finance, manufacturing],
    relevance: (candidate) =>
      candidate.chunkId === manufacturing.chunkId ? 0.98 : 0.08,
    claims: [
      "Lenskart manufactures prescription eyeglasses at centralized facilities in Bhiwadi, Rajasthan, and Gurugram, Haryana.",
      "Lenskart also operates a manufacturing facility in Mumbai.",
    ],
    trace,
    evidenceForClaim: (_claimIndex, evidence) => [
      evidence.findIndex((chunk) => chunk.chunkId === manufacturing.chunkId),
    ],
  });

  assert.match(response.answer, /Bhiwadi, Rajasthan/);
  assert.match(response.answer, /Gurugram, Haryana/);
  assert.doesNotMatch(response.answer, /Mumbai/);
  assert.deepEqual(
    response.citations.map(({ chunkId, page }) => ({ chunkId, page })),
    [{ chunkId: manufacturing.chunkId, page: 283 }],
  );
  assert.deepEqual(Object.keys(response.citations[0] ?? {}), [
    "chunkId",
    "page",
    "text",
    "score",
  ]);
  assert.ok(trace.exactSearchCalls > 0);
  assert.equal(trace.vectorSearchCalls, 0);
  assert.ok(
    trace.documentFilters.every((ids) => ids?.includes("drhp-document")),
  );
});

test("DRHP revenue claim preserves FY values, units, basis and one financial citation", async () => {
  const financials = drhpResult(
    "restated-revenue",
    "FINANCIAL INFORMATION",
    "SUMMARY OF RESTATED CONSOLIDATED PROFIT AND LOSS (₹ in million, unless otherwise stated). Revenue from operations: Financial Year 2025 66,525.17; Financial Year 2024 54,277.03; Financial Year 2023 37,880.28.",
    108,
    0.89,
    300,
  );
  const manufacturing = drhpResult(
    "manufacturing",
    "OUR BUSINESS",
    "Our manufacturing facilities are located in Bhiwadi, Rajasthan and Gurugram, Haryana.",
    283,
    0.92,
    100,
  );
  const response = await runDrhpQuery({
    question:
      "What was revenue from operations for FY2023, FY2024 and FY2025?",
    chunks: [manufacturing, financials],
    relevance: (candidate) =>
      candidate.chunkId === financials.chunkId ? 0.97 : 0.1,
    claims: [
      "On a restated consolidated basis, revenue from operations was ₹66,525.17 million in FY2025, ₹54,277.03 million in FY2024, and ₹37,880.28 million in FY2023.",
    ],
    evidenceForClaim: (_claimIndex, evidence) => [
      evidence.findIndex((chunk) => chunk.chunkId === financials.chunkId),
    ],
  });

  assert.match(response.answer, /66,525\.17 million/);
  assert.match(response.answer, /54,277\.03 million/);
  assert.match(response.answer, /37,880\.28 million/);
  assert.deepEqual(
    response.citations.map(({ chunkId }) => chunkId),
    [financials.chunkId],
  );
  assert.equal(response.citations[0]?.page, 108);
});

test("DRHP context retains a relevant neighboring chunk for a multi-year table", async () => {
  const recentYears = drhpResult(
    "revenue-years-2025-2024",
    "FINANCIAL INFORMATION",
    "On a restated consolidated basis, revenue from operations was ₹66,525.17 million in Financial Year 2025 and ₹54,277.03 million in Financial Year 2024.",
    108,
    0.88,
    300,
  );
  const earlierYear = drhpResult(
    "revenue-year-2023",
    "FINANCIAL INFORMATION",
    "On a restated consolidated basis, revenue from operations was ₹37,880.28 million in Financial Year 2023.",
    109,
    0.71,
    301,
  );
  const response = await runDrhpQuery({
    question:
      "What was revenue from operations for FY2023, FY2024 and FY2025?",
    chunks: [recentYears, earlierYear],
    relevance: (candidate) =>
      candidate.chunkId === recentYears.chunkId ? 0.97 : 0.6,
    claims: [
      "On a restated consolidated basis, revenue was ₹66,525.17 million in FY2025, ₹54,277.03 million in FY2024, and ₹37,880.28 million in FY2023.",
    ],
    evidenceForClaim: (_claimIndex, evidence) =>
      evidence.map((_candidate, index) => index),
  });

  assert.deepEqual(
    response.citations.map(({ chunkId }) => chunkId),
    [recentYears.chunkId, earlierYear.chunkId],
  );
});

test("DRHP registered office and CIN are cited without subsidiary addresses", async () => {
  const companyDetails = drhpResult(
    "company-identity",
    "GENERAL INFORMATION",
    "Registered Office: Plot No. 151, Okhla Industrial Estate, Phase III, New Delhi – 110 020, Delhi, India. Corporate Identity Number: U33100DL2008PLC178355.",
    3,
    0.84,
    20,
  );
  const subsidiary = drhpResult(
    "subsidiary-address",
    "OUR GROUP COMPANIES",
    "A subsidiary is registered at 4th Floor, IFCI Tower, Nehru Place, New Delhi – 110 019.",
    111,
    0.95,
    210,
  );
  const response = await runDrhpQuery({
    question: "What is Lenskart's registered office address and CIN?",
    chunks: [subsidiary, companyDetails],
    relevance: (candidate) =>
      candidate.chunkId === companyDetails.chunkId ? 0.98 : 0.12,
    claims: [
      "The registered office is Plot No. 151, Okhla Industrial Estate, Phase III, New Delhi – 110 020, Delhi, India; the CIN is U33100DL2008PLC178355.",
    ],
    evidenceForClaim: (_claimIndex, evidence) => [
      evidence.findIndex((chunk) => chunk.chunkId === companyDetails.chunkId),
    ],
  });

  assert.match(response.answer, /U33100DL2008PLC178355/);
  assert.deepEqual(
    response.citations.map(({ chunkId }) => chunkId),
    [companyDetails.chunkId],
  );
  assert.equal(response.citations[0]?.page, 3);
});

test("DRHP fresh-issue answer cites objects and discloses placeholder allocations", async () => {
  const objects = drhpResult(
    "fresh-issue-objects",
    "OBJECTS OF THE OFFER",
    "Our Company proposes to utilize the Net Proceeds from the Fresh Issue towards: capital expenditure for new CoCo stores in India; lease, rent and licence payments for company-operated CoCo stores; technology and cloud infrastructure; brand marketing and business promotion; and unidentified inorganic acquisitions and general corporate purposes.",
    173,
    0.81,
    420,
  );
  const allocation = drhpResult(
    "fresh-issue-allocation",
    "OBJECTS OF THE OFFER",
    "The allocation table lists Total Net Proceeds as [●]. The table notes that amounts are to be finalised upon determination of the Offer Price and updated in the Prospectus.",
    174,
    0.77,
    421,
  );
  const unrelatedFinancials = drhpResult(
    "unrelated-financials",
    "FINANCIAL INFORMATION",
    "Revenue from operations was ₹66,525.17 million in Financial Year 2025.",
    108,
    0.91,
    200,
  );
  const response = await runDrhpQuery({
    question: "What are the objects of the Fresh Issue and how are proceeds allocated?",
    chunks: [unrelatedFinancials, objects, allocation],
    relevance: (candidate) =>
      candidate.chunkId === unrelatedFinancials.chunkId ? 0.14 : 0.97,
    claims: [
      "The Fresh Issue proceeds are intended for new CoCo stores, related lease payments, technology and cloud infrastructure, brand marketing, and unidentified inorganic acquisitions and general corporate purposes.",
      "The draft leaves the total allocation as [●], to be finalised after the Offer Price is determined.",
    ],
    evidenceForClaim: (claimIndex, evidence) => [
      evidence.findIndex((chunk) =>
        chunk.chunkId ===
        (claimIndex === 0 ? objects.chunkId : allocation.chunkId),
      ),
    ],
  });

  assert.match(response.answer, /new CoCo stores/);
  assert.match(response.answer, /\[●\]/);
  assert.deepEqual(
    response.citations.map(({ chunkId }) => chunkId),
    [objects.chunkId, allocation.chunkId],
  );
});

test("DRHP supplier risks do not cite company-owned manufacturing facilities", async () => {
  const supplierSource = drhpResult(
    "supplier-source",
    "RISK FACTORS",
    "We source blank and powered lenses, frames, eyeglass cases, packaging materials and consumables from third-party suppliers. A majority of raw materials are purchased on a spot purchase order basis.",
    58,
    0.82,
    500,
  );
  const supplierRisk = drhpResult(
    "supplier-risk",
    "RISK FACTORS",
    "Our procurement relationships are concentrated among a limited number of raw material suppliers. Our reliance on them exposes us to risks including delays, interruptions or reductions in the supply of raw materials.",
    59,
    0.78,
    501,
  );
  const ownedFacilities = drhpResult(
    "owned-facilities",
    "OUR BUSINESS",
    "We own and operate centralized manufacturing facilities in India at Bhiwadi, Rajasthan and Gurugram, Haryana.",
    286,
    0.97,
    700,
  );
  const response = await runDrhpQuery({
    question:
      "What risks does Lenskart face from third-party manufacturers or suppliers?",
    chunks: [ownedFacilities, supplierSource, supplierRisk],
    relevance: (candidate) =>
      candidate.chunkId === ownedFacilities.chunkId ? 0.1 : 0.96,
    claims: [
      "Lenskart sources raw materials from third-party suppliers, with most raw materials bought on spot purchase orders.",
      "Reliance on a limited number of raw material suppliers exposes Lenskart to delays, interruptions, or reductions in supply.",
    ],
    evidenceForClaim: (claimIndex, evidence) => [
      evidence.findIndex((chunk) =>
        chunk.chunkId ===
        (claimIndex === 0 ? supplierSource.chunkId : supplierRisk.chunkId),
      ),
    ],
  });

  assert.match(response.answer, /third-party suppliers/);
  assert.match(response.answer, /delays, interruptions/);
  assert.deepEqual(
    response.citations.map(({ chunkId }) => chunkId),
    [supplierSource.chunkId, supplierRisk.chunkId],
  );
});

test("DRHP unsupported generated claims are omitted and overlapping citations deduplicated", async () => {
  const evidence = drhpResult(
    "address-source",
    "GENERAL INFORMATION",
    "The registered office is at Plot No. 151, Okhla Industrial Estate, Phase III, New Delhi – 110 020, Delhi, India.",
    3,
    0.84,
    20,
  );
  const overlap = drhpResult(
    "address-overlap",
    "GENERAL INFORMATION",
    evidence.text,
    3,
    0.83,
    21,
  );
  const response = await runDrhpQuery({
    question: "What is the registered office address?",
    chunks: [evidence, overlap],
    relevance: () => 0.98,
    claims: [
      "The registered office is at Plot No. 151, Okhla Industrial Estate, Phase III, New Delhi – 110 020, Delhi, India.",
      "The company has annual revenue of ₹99,999 million.",
    ],
    evidenceForClaim: (claimIndex, candidates) =>
      claimIndex === 0
        ? candidates.map((_candidate, index) => index)
        : [0],
  });

  assert.doesNotMatch(response.answer, /₹99,999/);
  assert.equal(response.citations.length, 1);
  assert.equal(response.citations[0]?.chunkId, evidence.chunkId);
});

test("legacy DRHP chunks without page metadata are not cited with guessed pages", async () => {
  const legacyChunk = result(
    "legacy-chunk",
    "drhp-document",
    "OUR BUSINESS",
    "Our manufacturing facilities are in Bhiwadi, Rajasthan.",
  );
  const response = await runDrhpQuery({
    question: "Where are Lenskart's manufacturing facilities?",
    chunks: [legacyChunk],
    relevance: () => 0.99,
    claims: ["The facility is in Bhiwadi, Rajasthan."],
    evidenceForClaim: () => [0],
    legacyDrhpFilename: true,
  });

  assert.match(response.answer, /re-ingested/);
  assert.deepEqual(response.citations, []);
});

function result(
  chunkId: string,
  documentId: string,
  section: string,
  text: string,
  score = 0.8,
): SearchResult {
  return {
    chunkId,
    documentId,
    filename: "greencart.pdf",
    section,
    text,
    embeddingModel: "nomic-embed-text",
    score,
  };
}

function drhpResult(
  chunkId: string,
  section: string,
  text: string,
  page: number,
  score = 0.8,
  chunkIndex = page,
): SearchResult {
  return {
    ...result(chunkId, "drhp-document", section, text, score),
    chunkIndex,
    pdfPageIndex: page - 1,
    ...(page > 5 ? { printedPageNumber: String(page - 5) } : {}),
  };
}

function runDrhpQuery(options: {
  question: string;
  chunks: SearchResult[];
  relevance: (candidate: RelevanceCandidate) => number;
  claims: string[];
  legacyDrhpFilename?: boolean;
  trace?: {
    exactSearchCalls: number;
    vectorSearchCalls: number;
    documentFilters: Array<string[] | undefined>;
  };
  evidenceForClaim: (
    claimIndex: number,
    evidence: RelevanceCandidate[],
  ) => number[];
}): Promise<Awaited<ReturnType<QueryService["query"]>>> {
  const { chunks, evidenceForClaim } = options;
  const database = {
    getDocumentTypes: async (documentIds: string[]) =>
      documentIds.map((documentId) =>
        options.legacyDrhpFilename
          ? {
              documentId,
              filename: "Lenskart Solutions Limited-DRHP.pdf",
              extension: ".pdf",
            }
          : {
              documentId,
              documentType: "drhp" as const,
              filename: "lenskart-drhp.pdf",
              extension: ".pdf",
            },
      ),
    searchChunks: async () => {
      if (options.trace) options.trace.vectorSearchCalls += 1;
      return chunks;
    },
    searchChunksExact: async (
      _embedding: number[],
      _topK: number,
      _maxChunks: number,
      documentIds?: string[],
    ) => {
      if (options.trace) {
        options.trace.exactSearchCalls += 1;
        options.trace.documentFilters.push(documentIds);
      }
      return chunks;
    },
    searchChunksLexical: async () => [] as LexicalSearchResult[],
    scoreChunks: async (ids: string[]) =>
      chunks.filter((chunk) => ids.includes(chunk.chunkId)),
  };
  const ollama = {
    embed: async (queries: string[]) => queries.map(() => [1, 0]),
    evaluateChunkRelevance: async () => [],
    evaluateChunkRelevanceByIndex: async (
      _question: string,
      candidates: RelevanceCandidate[],
    ) =>
      candidates.map((candidate, candidateIndex) => ({
        candidateIndex,
        relevance: options.relevance(candidate),
      })),
    generateGroundedAnswer: async () => {
      throw new Error("Generic answer generation must not run for DRHP queries");
    },
    generateGroundedClaims: async () => ({ claims: options.claims }),
    validateGroundedClaims: async (
      _question: string,
      claims: string[],
      evidence: RelevanceCandidate[],
    ) =>
      claims.map((_claim, claimIndex) => ({
        claimIndex,
        evidenceIndexes: evidenceForClaim(claimIndex, evidence).filter(
          (index) => index >= 0,
        ),
      })),
  };

  return new QueryService(database, ollama).query({
    question: options.question,
    documentIds: ["drhp-document"],
  });
}
