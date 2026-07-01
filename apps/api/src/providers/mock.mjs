import { buildPolishInstructions, simpleLocalPolish } from "../../../../packages/shared/src/prompting.mjs";

function isPolishEnabled() {
  const raw = process.env.FLOW_POLISH_ENABLED;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }

  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

export function createMockProvider() {
  async function runMockDictation(request, { onEvent } = {}) {
    const rawTranscript =
      request.debugTranscript ??
      "umm hey there are three things this product does really well actually four wait no three and can you send it to the team after lunch";

    const polishedText = isPolishEnabled()
      ? simpleLocalPolish(rawTranscript, request, buildPolishInstructions(request))
      : rawTranscript;
    const traceId = request.traceId || "";

    if (typeof onEvent === "function") {
      await onEvent({
        modelInfo: {
          transcribe: "mock-transcriber"
        },
        provider: "mock",
        traceId,
        type: "dictation.started"
      });
      await onEvent({
        modelInfo: {
          transcribe: "mock-transcriber"
        },
        provider: "mock",
        traceId,
        type: "transcribe.started"
      });
      await onEvent({
        modelInfo: {
          transcribe: "mock-transcriber"
        },
        provider: "mock",
        rawTranscript,
        traceId,
        type: "transcribe.completed"
      });

      if (isPolishEnabled()) {
        await onEvent({
          modelInfo: {
            polish: "mock-polisher",
            transcribe: "mock-transcriber"
          },
          provider: "mock",
          rawTranscript,
          traceId,
          type: "polish.started"
        });
        await onEvent({
          delta: polishedText,
          modelInfo: {
            polish: "mock-polisher"
          },
          polishedText,
          provider: "mock",
          rawTranscript,
          traceId,
          type: "polish.delta"
        });
        await onEvent({
          modelInfo: {
            polish: "mock-polisher",
            transcribe: "mock-transcriber"
          },
          polishedText,
          provider: "mock",
          rawTranscript,
          traceId,
          type: "polish.completed"
        });
      } else {
        await onEvent({
          modelInfo: {
            polish: "disabled",
            transcribe: "mock-transcriber"
          },
          polishedText,
          provider: "mock",
          traceId,
          type: "polish.disabled"
        });
      }
    }

    return {
      provider: "mock",
      rawTranscript,
      polishedText,
      contextUsed: request.context,
      modelInfo: {
        transcribe: "mock-transcriber",
        polish: isPolishEnabled() ? "mock-polisher" : "disabled"
      }
    };
  }

  return {
    name: "mock",
    async transcribeAndPolish(request) {
      return runMockDictation(request);
    },
    async transcribeAndPolishStream(request, options = {}) {
      return runMockDictation(request, options);
    }
  };
}
