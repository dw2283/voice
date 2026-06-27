import { buildPolishInstructions, simpleLocalPolish } from "../../../../packages/shared/src/prompting.mjs";

export function createMockProvider() {
  return {
    name: "mock",
    async transcribeAndPolish(request) {
      const rawTranscript =
        request.debugTranscript ??
        "umm hey there are three things this product does really well actually four wait no three and can you send it to the team after lunch";

      const polishedText = simpleLocalPolish(rawTranscript, request, buildPolishInstructions(request));

      return {
        provider: "mock",
        rawTranscript,
        polishedText,
        contextUsed: request.context,
        modelInfo: {
          transcribe: "mock-transcriber",
          polish: "mock-polisher"
        }
      };
    }
  };
}

