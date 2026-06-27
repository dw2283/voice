import test from "node:test";
import assert from "node:assert/strict";
import {
  createHttpError,
  invalidJsonBodyError,
  toErrorResponse,
  wrapDictationRequestError
} from "../apps/api/src/http-errors.mjs";

test("invalid JSON body is reported as a 400 error", () => {
  const response = toErrorResponse(invalidJsonBodyError());

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.payload, {
    error: "Invalid JSON body"
  });
});

test("dictation request validation failures are reported as 400 errors", () => {
  const response = toErrorResponse(wrapDictationRequestError(new Error('Expected "audioBase64" to be a string')));

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.payload, {
    error: 'Expected "audioBase64" to be a string'
  });
});

test("explicit HTTP errors preserve their status code", () => {
  const response = toErrorResponse(createHttpError(413, "Request body too large"));

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.payload, {
    error: "Request body too large"
  });
});

test("unexpected errors still surface as 500 responses", () => {
  const response = toErrorResponse(new Error("boom"));

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.payload, {
    error: "boom"
  });
});
