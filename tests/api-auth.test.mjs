import test from "node:test";
import assert from "node:assert/strict";
import {
  extractBearerToken,
  getConfiguredApiTokens,
  isApiAuthEnabled,
  isAuthorizedBearerToken
} from "../apps/api/src/auth.mjs";

test("getConfiguredApiTokens trims and deduplicates configured service tokens", () => {
  const tokens = getConfiguredApiTokens({
    FLOW_API_TOKENS: " alpha,\n beta ,alpha ,, gamma "
  });

  assert.deepEqual(tokens, ["alpha", "beta", "gamma"]);
});

test("isApiAuthEnabled only turns on when service tokens are configured", () => {
  assert.equal(isApiAuthEnabled({ FLOW_API_TOKENS: "" }), false);
  assert.equal(isApiAuthEnabled({ FLOW_API_TOKENS: "beta-token" }), true);
});

test("extractBearerToken pulls the token value from an Authorization header", () => {
  assert.equal(extractBearerToken("Bearer abc123"), "abc123");
  assert.equal(extractBearerToken("bearer test-token"), "test-token");
  assert.equal(extractBearerToken("Basic nope"), "");
});

test("isAuthorizedBearerToken accepts matching tokens and bypasses auth when disabled", () => {
  assert.equal(isAuthorizedBearerToken("Bearer beta-token", { FLOW_API_TOKENS: "alpha,beta-token" }), true);
  assert.equal(isAuthorizedBearerToken("Bearer wrong", { FLOW_API_TOKENS: "alpha,beta-token" }), false);
  assert.equal(isAuthorizedBearerToken("", { FLOW_API_TOKENS: "" }), true);
});
