import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVoiceEnv,
  getHoldKey,
  getApiMode,
  getTriggerLabel,
  getTriggerMode,
  isPolishEnabled,
  isLocalApiBaseUrl,
  normalizeHoldKey,
  needsLocalWhisper
} from "../scripts/process-utils.mjs";

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

test("getTriggerMode normalizes trigger mode values", () => {
  assert.equal(getTriggerMode({ FLOW_TRIGGER_MODE: " FN_HOLD " }, "darwin"), "fn_hold");
  assert.equal(getTriggerMode({ FLOW_TRIGGER_MODE: "hotkey" }, "darwin"), "hotkey");
});

test("getTriggerLabel shows Fn hold on macOS when fn mode is enabled", () => {
  assert.equal(
    getTriggerLabel({
      holdKey: "fn",
      hotkey: "CommandOrControl+Shift+Space",
      platform: "darwin",
      triggerMode: "fn_hold"
    }),
    "Fn (hold)"
  );
});

test("getTriggerLabel reflects the configured hold key on macOS", () => {
  assert.equal(
    getTriggerLabel({
      holdKey: "control",
      hotkey: "CommandOrControl+Shift+Space",
      platform: "darwin",
      triggerMode: "fn_hold"
    }),
    "Control (hold)"
  );
});

test("getHoldKey normalizes aliases and invalid values", () => {
  assert.equal(getHoldKey({ FLOW_HOLD_KEY: "ctrl" }), "control");
  assert.equal(getHoldKey({ FLOW_HOLD_KEY: "alt" }), "option");
  assert.equal(normalizeHoldKey("???"), "control");
});

test("buildVoiceEnv enables polish by default", () => {
  const env = buildVoiceEnv({});

  assert.equal(env.FLOW_POLISH_ENABLED, "true");
});

test("buildVoiceEnv seeds a local desktop service token by default", () => {
  const env = buildVoiceEnv({});

  assert.equal(env.FLOW_API_TOKEN, "local-dev-token");
  assert.equal(env.FLOW_API_TOKENS, "local-dev-token");
});

test("isLocalApiBaseUrl recognizes localhost routes", () => {
  assert.equal(isLocalApiBaseUrl("http://127.0.0.1:8000"), true);
  assert.equal(isLocalApiBaseUrl("http://localhost:3000"), true);
  assert.equal(isLocalApiBaseUrl("https://voice.example.com"), false);
});

test("getApiMode reports hosted mode for non-local API routes", () => {
  assert.equal(getApiMode({ FLOW_API_BASE_URL: "http://127.0.0.1:8000" }), "local");
  assert.equal(getApiMode({ FLOW_API_BASE_URL: "https://voice.example.com" }), "hosted");
});

test("isPolishEnabled only disables polish for explicit false-like values", () => {
  assert.equal(isPolishEnabled({ FLOW_POLISH_ENABLED: "false" }), false);
  assert.equal(isPolishEnabled({ FLOW_POLISH_ENABLED: "off" }), false);
  assert.equal(isPolishEnabled({ FLOW_POLISH_ENABLED: "true" }), true);
  assert.equal(isPolishEnabled({}), true);
});

test("needsLocalWhisper only when OpenAI mode has no remote transcription model", () => {
  assert.equal(needsLocalWhisper({ FLOW_TRANSCRIBE_PROVIDER: "openai", FLOW_TRANSCRIBE_MODEL: "" }), true);
  assert.equal(needsLocalWhisper({ FLOW_TRANSCRIBE_PROVIDER: "openai", FLOW_TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe" }), false);
  assert.equal(needsLocalWhisper({ FLOW_TRANSCRIBE_PROVIDER: "mock", FLOW_TRANSCRIBE_MODEL: "" }), false);
});
