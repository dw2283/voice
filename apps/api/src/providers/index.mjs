import { createMockProvider } from "./mock.mjs";
import { createOpenAIProvider } from "./openai.mjs";

export function createProvider() {
  const provider = (process.env.FLOW_TRANSCRIBE_PROVIDER ?? "mock").toLowerCase();

  if (provider === "openai") {
    return createOpenAIProvider();
  }

  return createMockProvider();
}

