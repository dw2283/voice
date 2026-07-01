import { performance } from "node:perf_hooks";
import {
  buildPolishInstructions,
  buildPolishRewriteInput,
  extractResponseText
} from "../../../../packages/shared/src/prompting.mjs";
import { transcribeWithLocalWhisper, warmLocalWhisper } from "./local-whisper.mjs";

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getBaseUrl() {
  return (process.env.FLOW_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

function roundTimingMs(value) {
  return Number(value.toFixed(1));
}

function logTiming(event, payload) {
  console.info(`VoiceKit timing ${JSON.stringify({
    event,
    scope: "api-provider",
    ...payload
  })}`);
}

function isPolishEnabled() {
  const raw = process.env.FLOW_POLISH_ENABLED;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }

  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function base64ToFile(audioBase64, mimeType) {
  const bytes = Buffer.from(audioBase64, "base64");
  const extension = mimeType.includes("mp4") ? "m4a" : "webm";

  return new File([bytes], `recording.${extension}`, { type: mimeType });
}

function buildPolishInput(rawTranscript, request) {
  return [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text: buildPolishInstructions(request)
        }
      ]
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: buildPolishRewriteInput(rawTranscript)
        }
      ]
    }
  ];
}

async function emitProviderEvent(onEvent, event) {
  if (typeof onEvent === "function") {
    await onEvent(event);
  }
}

function parseSseEventBlock(block) {
  const trimmed = block.trim();

  if (!trimmed) {
    return null;
  }

  let event = "";
  const dataLines = [];

  for (const line of trimmed.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join("\n");

  if (rawData === "[DONE]") {
    return {
      done: true,
      event,
      payload: null
    };
  }

  return {
    done: false,
    event,
    payload: JSON.parse(rawData)
  };
}

async function consumeSseStream(stream, onMessage) {
  if (!stream) {
    throw new Error("Streaming response body was empty.");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), {
      stream: !done
    });
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let separatorIndex = buffer.indexOf("\n\n");

    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const parsed = parseSseEventBlock(block);

      if (parsed) {
        await onMessage(parsed);
      }

      separatorIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }

  const trailing = parseSseEventBlock(buffer);

  if (trailing) {
    await onMessage(trailing);
  }
}

async function transcribeAudio({ apiKey, model, audioBase64, mimeType }) {
  const form = new FormData();
  form.append("model", model);
  form.append("file", base64ToFile(audioBase64, mimeType));

  const response = await fetch(`${getBaseUrl()}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  return json.text ?? "";
}

async function getTranscriptFromAvailableSource({ apiKey, request, transcribeModel }) {
  const directTranscript = request.debugTranscript?.trim() || "";

  if (directTranscript) {
    return {
      modelInfo: "client-side-transcript",
      rawTranscript: directTranscript
    };
  }

  if (!request.audioBase64) {
    throw new Error("Either debugTranscript or audioBase64 is required.");
  }

  if (transcribeModel) {
    if (!apiKey) {
      throw new Error("Missing required environment variable: OPENAI_API_KEY");
    }

    const rawTranscript = await transcribeAudio({
      apiKey,
      model: transcribeModel,
      audioBase64: request.audioBase64,
      mimeType: request.mimeType
    });

    if (!rawTranscript.trim()) {
      throw new Error("No speech was detected in that audio clip. Try speaking a bit louder or recording for longer.");
    }

    return {
      modelInfo: transcribeModel,
      rawTranscript
    };
  }

  const localResult = await transcribeWithLocalWhisper({
    audioBase64: request.audioBase64,
    mimeType: request.mimeType
  });

  if (!localResult.rawTranscript.trim()) {
    throw new Error("No speech was detected in that audio clip. Try speaking a bit louder or recording for longer.");
  }

  return {
    modelInfo: localResult.modelLabel,
    rawTranscript: localResult.rawTranscript
  };
}

async function polishTranscript({ apiKey, model, rawTranscript, request }) {
  const response = await fetch(`${getBaseUrl()}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: buildPolishInput(rawTranscript, request)
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI polish failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  return extractResponseText(json, rawTranscript);
}

async function polishTranscriptStream({ apiKey, model, rawTranscript, request, onDelta }) {
  const response = await fetch(`${getBaseUrl()}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      stream: true,
      input: buildPolishInput(rawTranscript, request)
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI polish failed: ${response.status} ${await response.text()}`);
  }

  let polishedText = "";
  let completedResponse = null;

  await consumeSseStream(response.body, async ({ payload }) => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
      polishedText += payload.delta;
      await onDelta?.(payload.delta, polishedText);
      return;
    }

    if (payload.type === "response.output_text.done" && typeof payload.text === "string" && !polishedText.trim()) {
      polishedText = payload.text;
      await onDelta?.(payload.text, polishedText);
      return;
    }

    if (payload.type === "response.completed") {
      completedResponse = payload.response ?? payload;
      return;
    }

    if (payload.type === "error") {
      throw new Error(payload.message || payload.error?.message || "OpenAI polish stream failed.");
    }
  });

  const finalText = polishedText.trim() || extractResponseText(completedResponse, rawTranscript);
  return finalText.trim() || rawTranscript;
}

async function transcribeAndPolishInternal(request, { onEvent } = {}) {
  const providerStartedAt = performance.now();
  const transcribeModel = process.env.FLOW_TRANSCRIBE_MODEL?.trim() || null;
  const polishEnabled = isPolishEnabled();
  const needsOpenAIKey = Boolean(transcribeModel) || polishEnabled;
  const apiKey = needsOpenAIKey ? requireEnv("OPENAI_API_KEY") : null;
  const traceId = request.traceId || "";

  await emitProviderEvent(onEvent, {
    provider: "openai",
    traceId,
    type: "dictation.started"
  });

  await emitProviderEvent(onEvent, {
    modelInfo: {
      transcribe: transcribeModel || "local-whisper"
    },
    provider: "openai",
    traceId,
    type: "transcribe.started"
  });

  const transcribeStartedAt = performance.now();
  const transcriptResult = await getTranscriptFromAvailableSource({
    apiKey,
    request,
    transcribeModel
  });
  const transcribeMs = performance.now() - transcribeStartedAt;
  const rawTranscript = transcriptResult.rawTranscript;

  await emitProviderEvent(onEvent, {
    modelInfo: {
      transcribe: transcriptResult.modelInfo
    },
    provider: "openai",
    rawTranscript,
    traceId,
    transcribeMs: roundTimingMs(transcribeMs),
    type: "transcribe.completed"
  });

  if (!polishEnabled) {
    logTiming("dictation.completed", {
      polish: "disabled",
      polishMs: 0,
      totalMs: roundTimingMs(performance.now() - providerStartedAt),
      traceId,
      transcribe: transcriptResult.modelInfo,
      transcribeMs: roundTimingMs(transcribeMs)
    });

    const result = {
      provider: "openai",
      rawTranscript,
      polishedText: rawTranscript,
      contextUsed: request.context,
      modelInfo: {
        transcribe: transcriptResult.modelInfo,
        polish: "disabled"
      }
    };

    await emitProviderEvent(onEvent, {
      modelInfo: result.modelInfo,
      polishedText: result.polishedText,
      provider: "openai",
      traceId,
      type: "polish.disabled"
    });

    return result;
  }

  const polishModel = requireEnv("FLOW_POLISH_MODEL");

  await emitProviderEvent(onEvent, {
    modelInfo: {
      polish: polishModel,
      transcribe: transcriptResult.modelInfo
    },
    provider: "openai",
    rawTranscript,
    traceId,
    type: "polish.started"
  });

  const polishStartedAt = performance.now();
  let polishedText = "";

  if (typeof onEvent === "function") {
    polishedText = await polishTranscriptStream({
      apiKey,
      model: polishModel,
      rawTranscript,
      request,
      onDelta: async (delta, nextText) => {
        await emitProviderEvent(onEvent, {
          delta,
          modelInfo: {
            polish: polishModel
          },
          polishedText: nextText,
          provider: "openai",
          rawTranscript,
          traceId,
          type: "polish.delta"
        });
      }
    });
  } else {
    polishedText = await polishTranscript({
      apiKey,
      model: polishModel,
      rawTranscript,
      request
    });
  }

  const polishMs = performance.now() - polishStartedAt;

  await emitProviderEvent(onEvent, {
    modelInfo: {
      polish: polishModel,
      transcribe: transcriptResult.modelInfo
    },
    polishedText,
    provider: "openai",
    rawTranscript,
    traceId,
    type: "polish.completed"
  });

  logTiming("dictation.completed", {
    polish: polishModel,
    polishMs: roundTimingMs(polishMs),
    totalMs: roundTimingMs(performance.now() - providerStartedAt),
    traceId,
    transcribe: transcriptResult.modelInfo,
    transcribeMs: roundTimingMs(transcribeMs)
  });

  return {
    provider: "openai",
    rawTranscript,
    polishedText,
    contextUsed: request.context,
    modelInfo: {
      transcribe: transcriptResult.modelInfo,
      polish: polishModel
    }
  };
}

export function createOpenAIProvider() {
  return {
    name: "openai",
    async warmup() {
      const transcribeModel = process.env.FLOW_TRANSCRIBE_MODEL?.trim() || null;

      if (!transcribeModel) {
        await warmLocalWhisper();
      }
    },
    async transcribeAndPolish(request) {
      return transcribeAndPolishInternal(request);
    },
    async transcribeAndPolishStream(request, options = {}) {
      return transcribeAndPolishInternal(request, options);
    }
  };
}
