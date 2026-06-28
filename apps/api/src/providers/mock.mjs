import { buildPolishInstructions, simpleLocalPolish } from "../../../../packages/shared/src/prompting.mjs";

function isPolishEnabled() {
  const raw = process.env.FLOW_POLISH_ENABLED;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }

  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

export function createMockProvider() {
  return {
    name: "mock",
    async transcribeAndPolish(request) {
      const rawTranscript =
        request.debugTranscript ??
        "umm hey there are three things this product does really well actually four wait no three and can you send it to the team after lunch";

      const polishedText = isPolishEnabled()
        ? simpleLocalPolish(rawTranscript, request, buildPolishInstructions(request))
        : rawTranscript;

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
  };
}
