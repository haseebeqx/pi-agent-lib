import assert from "node:assert/strict";
import test from "node:test";
import { resolveModel } from "../src/model.js";

test("resolveModel leaves model selection to Pi when no model id is supplied", () => {
  assert.equal(resolveModel({} as never), undefined);
});
