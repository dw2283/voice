import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAIProvider } from "../apps/api/src/providers/openai.mjs";

function buildRequest(debugTranscript) {
  return {
    audioBase64: "",
    context: {
      appName: "Claude",
      dictionaryHints: ["Voice Flow"],
      platform: "test",
      selectedText: "",
      surroundingText: ""
    },
    debugTranscript,
    finalOnly: true,
    mimeType: "audio/webm",
    userIntent: ""
  };
}

function withTemporaryEnv(overrides, fn) {
  const original = new Map();

  for (const key of Object.keys(overrides)) {
    original.set(key, process.env[key]);

    const nextValue = overrides[key];

    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of original.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

test("openai provider skips polish when FLOW_POLISH_ENABLED=false", async () => {
  const originalFetch = global.fetch;
  let fetchCallCount = 0;

  global.fetch = async () => {
    fetchCallCount += 1;
    throw new Error("fetch should not be called when polish is disabled and debugTranscript is provided");
  };

  try {
    await withTemporaryEnv(
      {
        FLOW_POLISH_ENABLED: "false",
        FLOW_POLISH_MODEL: undefined,
        FLOW_TRANSCRIBE_MODEL: "",
        OPENAI_API_KEY: undefined
      },
      async () => {
        const provider = createOpenAIProvider();
        const result = await provider.transcribeAndPolish(buildRequest("what's the weather tomorrow"));

        assert.equal(result.rawTranscript, "what's the weather tomorrow");
        assert.equal(result.polishedText, "what's the weather tomorrow");
        assert.equal(result.modelInfo.polish, "disabled");
      }
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(fetchCallCount, 0);
});

test("openai provider sends rewrite-only polish instructions", async () => {
  const originalFetch = global.fetch;
  const seenCalls = [];

  global.fetch = async (_url, options = {}) => {
    seenCalls.push(JSON.parse(options.body));
    return {
      ok: true,
      async json() {
        return {
          output_text: "What's the weather tomorrow?"
        };
      }
    };
  };

  try {
    await withTemporaryEnv(
      {
        FLOW_POLISH_ENABLED: "true",
        FLOW_POLISH_MODEL: "gpt-4.1-mini",
        FLOW_TRANSCRIBE_MODEL: "",
        OPENAI_API_KEY: "test-key"
      },
      async () => {
        const provider = createOpenAIProvider();
        const result = await provider.transcribeAndPolish(buildRequest("what's the weather tomorrow"));

        assert.equal(result.polishedText, "What's the weather tomorrow?");
        assert.equal(result.modelInfo.polish, "gpt-4.1-mini");
      }
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(seenCalls.length, 1);
  assert.match(seenCalls[0].input[0].content[0].text, /not a chat assistant/i);
  assert.match(seenCalls[0].input[0].content[0].text, /must not answer the user/i);
  assert.match(seenCalls[0].input[1].content[0].text, /return only the rewritten transcript/i);
  assert.match(seenCalls[0].input[1].content[0].text, /transcript to rewrite:/i);
  assert.match(seenCalls[0].input[1].content[0].text, /what's the weather tomorrow/i);
});

test("openai provider does not fall back to local whisper when cloud transcription is configured", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    if (String(url).includes("/audio/transcriptions")) {
      throw new Error("simulated network failure");
    }

    throw new Error("unexpected fetch call");
  };

  try {
    await withTemporaryEnv(
      {
        FLOW_POLISH_ENABLED: "false",
        FLOW_POLISH_MODEL: undefined,
        FLOW_TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe",
        OPENAI_API_KEY: "test-key"
      },
      async () => {
        const provider = createOpenAIProvider();
        const request = buildRequest("");
        request.audioBase64 = Buffer.from("dummy-audio").toString("base64");

        await assert.rejects(
          provider.transcribeAndPolish(request),
          /simulated network failure/
        );
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});
