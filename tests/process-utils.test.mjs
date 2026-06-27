import test from "node:test";
import assert from "node:assert/strict";
import { buildVoiceEnv } from "../scripts/process-utils.mjs";

test("buildVoiceEnv uses the official OpenAI base URL by default", () => {
  const env = buildVoiceEnv({});

  assert.equal(env.FLOW_OPENAI_BASE_URL, "https://api.openai.com/v1");
});

test("buildVoiceEnv respects process env overrides over defaults", () => {
  const originalValue = process.env.FLOW_OPENAI_BASE_URL;
  process.env.FLOW_OPENAI_BASE_URL = "https://example.com/v1";

  try {
    const env = buildVoiceEnv({});
    assert.equal(env.FLOW_OPENAI_BASE_URL, "https://example.com/v1");
  } finally {
    if (originalValue === undefined) {
      delete process.env.FLOW_OPENAI_BASE_URL;
    } else {
      process.env.FLOW_OPENAI_BASE_URL = originalValue;
    }
  }
});

test("buildVoiceEnv keeps .env values when the shell does not override them", () => {
  const originalValue = process.env.FLOW_OPENAI_BASE_URL;
  delete process.env.FLOW_OPENAI_BASE_URL;

  try {
    const env = buildVoiceEnv({
      FLOW_OPENAI_BASE_URL: "https://custom.example/v1"
    });
    assert.equal(env.FLOW_OPENAI_BASE_URL, "https://custom.example/v1");
  } finally {
    if (originalValue === undefined) {
      delete process.env.FLOW_OPENAI_BASE_URL;
    } else {
      process.env.FLOW_OPENAI_BASE_URL = originalValue;
    }
  }
});
