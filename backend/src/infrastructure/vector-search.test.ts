import assert from "node:assert/strict";
import test from "node:test";
import { cosineSearchScore } from "./mongo.js";

test("exact search score ranks identical and opposite vectors correctly", () => {
  assert.equal(cosineSearchScore([1, 0], [1, 0]), 1);
  assert.equal(cosineSearchScore([1, 0], [0, 1]), 0.5);
  assert.equal(cosineSearchScore([1, 0], [-1, 0]), 0);
});

test("exact search score rejects incompatible embedding dimensions", () => {
  assert.throws(
    () => cosineSearchScore([1, 0], [1]),
    /different dimensions/,
  );
});
