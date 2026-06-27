import { buildPolishInstructions, extractResponseText } from "../../../../packages/shared/src/prompting.mjs";
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

function base64ToFile(audioBase64, mimeType) {
  const bytes = Buffer.from(audioBase64, "base64");
  const extension = mimeType.includes("mp4") ? "m4a" : "webm";

  return new File([bytes], `recording.${extension}`, { type: mimeType });
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
    try {
      const rawTranscript = await transcribeAudio({
        apiKey,
        model: transcribeModel,
        audioBase64: request.audioBase64,
        mimeType: request.mimeType
      });

      if (rawTranscript.trim()) {
        return {
          modelInfo: transcribeModel,
          rawTranscript
        };
      }
    } catch (error) {
      console.warn(
        `Remote transcription failed for ${transcribeModel}. Falling back to local speech transcription.`,
        error instanceof Error ? error.message : error
      );
    }
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
      input: [
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
              text: rawTranscript
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI polish failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  return extractResponseText(json, rawTranscript);
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
      const apiKey = requireEnv("OPENAI_API_KEY");
      const polishModel = requireEnv("FLOW_POLISH_MODEL");
      const transcribeModel = process.env.FLOW_TRANSCRIBE_MODEL?.trim() || null;
      const transcriptResult = await getTranscriptFromAvailableSource({
        apiKey,
        request,
        transcribeModel
      });
      const rawTranscript = transcriptResult.rawTranscript;

      const polishedText = await polishTranscript({
        apiKey,
        model: polishModel,
        rawTranscript,
        request
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
  };
}
