import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OllamaClient } from "./ollama.js";

test("DRHP model flow returns claims and evidence indexes without model-selected chunk ids", async (t) => {
  const outputs = [
    { evaluations: [{ candidateIndex: 0, relevance: 0.96 }] },
    { claims: ["Facilities are located in Bhiwadi, Rajasthan."] },
    { validations: [{ claimIndex: 0, evidenceIndexes: [0] }] },
  ];
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      const output = outputs.shift();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          message: { content: JSON.stringify(output) },
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new OllamaClient(
    `http://127.0.0.1:${address.port}`,
    "gemma4:12b-mlx",
    "nomic-embed-text",
  );
  const evidence = [
    {
      chunkId: "actual-chunk-id",
      page: 283,
      section: "OUR BUSINESS",
      score: 0.89,
      text: "The manufacturing facility is in Bhiwadi, Rajasthan.",
    },
  ];

  assert.deepEqual(
    await client.evaluateChunkRelevanceByIndex(
      "Where is the facility?",
      evidence,
    ),
    [{ candidateIndex: 0, relevance: 0.96 }],
  );
  assert.deepEqual(
    await client.generateGroundedClaims("Where is the facility?", evidence),
    { claims: ["Facilities are located in Bhiwadi, Rajasthan."] },
  );
  assert.deepEqual(
    await client.validateGroundedClaims(
      "Where is the facility?",
      ["Facilities are located in Bhiwadi, Rajasthan."],
      evidence,
    ),
    [{ claimIndex: 0, evidenceIndexes: [0] }],
  );

  assert.equal(requestBodies.length, 3);
  const messages = requestBodies.map((requestBody) => {
    const requestMessages = requestBody.messages as
      | Array<{ role: string; content: string }>
      | undefined;
    return requestMessages ?? [];
  });
  assert.match(messages[1]?.[0]?.content ?? "", /Do not include source references/);
  assert.match(messages[2]?.[0]?.content ?? "", /Do not return chunk ids/);
  assert.match(
    JSON.stringify(requestBodies[1]),
    /actual-chunk-id/,
  );
  assert.match(JSON.stringify(requestBodies[1]), /283/);
});

test("DRHP model rejects malformed claim-validation JSON", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: { content: "{not json}" } }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new OllamaClient(
    `http://127.0.0.1:${address.port}`,
    "gemma4:12b-mlx",
    "nomic-embed-text",
  );

  await assert.rejects(
    client.validateGroundedClaims("question", ["claim"], [
      {
        chunkId: "chunk-1",
        score: 0.8,
        text: "Evidence.",
      },
    ]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_CHAT_RESPONSE",
  );
});
