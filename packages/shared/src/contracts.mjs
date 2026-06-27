function ensureString(value, fieldName, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error(`Expected "${fieldName}" to be a string`);
  }

  return value;
}

function ensureStringArray(value, fieldName) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected "${fieldName}" to be an array of strings`);
  }

  return value;
}

export function assertDictationRequest(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Request body must be an object");
  }

  return {
    audioBase64: ensureString(payload.audioBase64, "audioBase64", { optional: true }),
    mimeType: ensureString(payload.mimeType, "mimeType", { optional: true }) || "audio/webm",
    finalOnly: Boolean(payload.finalOnly),
    debugTranscript: ensureString(payload.debugTranscript, "debugTranscript", { optional: true }),
    userIntent: ensureString(payload.userIntent, "userIntent", { optional: true }),
    context: {
      platform: ensureString(payload.context?.platform, "context.platform", { optional: true }) || "unknown",
      appName: ensureString(payload.context?.appName, "context.appName", { optional: true }) || "unknown",
      selectedText: ensureString(payload.context?.selectedText, "context.selectedText", { optional: true }),
      surroundingText: ensureString(payload.context?.surroundingText, "context.surroundingText", { optional: true }),
      dictionaryHints: ensureStringArray(payload.context?.dictionaryHints, "context.dictionaryHints")
    }
  };
}

