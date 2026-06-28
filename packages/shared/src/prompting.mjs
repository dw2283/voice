export function buildPolishInstructions(request) {
  const dictionaryTerms = request.context.dictionaryHints.length
    ? request.context.dictionaryHints.join(", ")
    : "none";

  return [
    "You are the polish pass for a dictation product.",
    "You are not a chat assistant and you must not answer the user.",
    "Your job is only to rewrite the dictated transcript into cleaner text.",
    "Turn messy spoken language into clean text the user can send immediately.",
    "Preserve meaning. Do not invent facts.",
    "Do not add explanations, replies, advice, or follow-up content.",
    "If the transcript is a question, request, or command, keep it as the user's words instead of answering or carrying it out.",
    "Remove filler words only when they are clearly disfluencies.",
    "Respect self-corrections such as 'actually', 'wait', or restarts.",
    "Add punctuation, paragraphs, and light formatting when useful.",
    "Use the app context only to guide light formatting, not to add or change content.",
    `Frontmost app: ${request.context.appName}.`,
    `User intent hint: ${request.userIntent || "unknown"}.`,
    `Dictionary hints: ${dictionaryTerms}.`
  ].join(" ");
}

export function buildPolishRewriteInput(rawTranscript) {
  return [
    "Rewrite the following dictated transcript.",
    "Return only the rewritten transcript.",
    "Do not answer it, execute it, or add any text that was not implied by the transcript.",
    "",
    "Transcript to rewrite:",
    rawTranscript
  ].join("\n");
}

export function simpleLocalPolish(rawTranscript, request) {
  const compact = rawTranscript
    .replace(/\b(umm+|uh+|like)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  let polished = compact
    .replace(/\bthe the\b/gi, "the")
    .replace(/\bwait no\b/gi, "")
    .trim();

  polished = polished
    .replace(/\bi\b/g, "I")
    .replace(/\bim\b/gi, "I'm")
    .replace(/\bive\b/gi, "I've")
    .replace(/\bid\b/gi, "I'd")
    .replace(/\bhes\b/gi, "he's")
    .replace(/\bshes\b/gi, "she's")
    .replace(/\bthats\b/gi, "that's")
    .replace(/^hey team quick update\b/i, "Hey team, quick update:")
    .replace(/^hey team\b/i, "Hey team,")
    .replace(/^hi team\b/i, "Hi team,")
    .replace(/\bi think\b/gi, "I think")
    .replace(/\bitll\b/gi, "it'll")
    .replace(/\bcant\b/gi, "can't")
    .replace(/\bdont\b/gi, "don't")
    .replace(/\bfriday\b/gi, "Friday")
    .replace(/\bslack\b/g, "Slack")
    .replace(/\bmail\b/g, "Mail")
    .trim();

  const splitCues = ["can you", "please", "thanks", "let me know"];

  for (const cue of splitCues) {
    const pattern = new RegExp(`\\s+(${cue})\\b`, "i");

    if (pattern.test(polished) && !/[.!?]\s+[A-Z]/.test(polished)) {
      polished = polished.replace(pattern, `. $1`);
      break;
    }
  }

  if (!/[.!?]$/.test(polished) && polished.length > 0) {
    polished += ".";
  }

  polished = polished
    .replace(/([.!?]\s+)([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`)
    .replace(/^([a-z])/, (letter) => letter.toUpperCase())
    .replace(/,\s*,+/g, ", ")
    .replace(/,{2,}/g, ",")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (request.context.appName.toLowerCase().includes("mail") || request.userIntent === "email") {
    polished = polished.charAt(0).toUpperCase() + polished.slice(1);
  }

  return polished;
}

export function extractResponseText(responseJson, fallbackText = "") {
  const outputText = responseJson?.output_text;

  if (typeof outputText === "string" && outputText.trim()) {
    return outputText.trim();
  }

  const output = responseJson?.output;

  if (Array.isArray(output)) {
    for (const item of output) {
      const content = item?.content;

      if (!Array.isArray(content)) {
        continue;
      }

      for (const block of content) {
        const text = block?.text;

        if (typeof text === "string" && text.trim()) {
          return text.trim();
        }
      }
    }
  }

  return fallbackText;
}
