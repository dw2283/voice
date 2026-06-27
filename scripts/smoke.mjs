import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const apiUrl = process.env.FLOW_API_BASE_URL ?? "http://127.0.0.1:8000";
const expectedPhrase = "Hello from Voice Flow";

async function commandExists(command) {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function createTestAudio() {
  if (!(await commandExists("say")) || !(await commandExists("afconvert"))) {
    throw new Error("macOS commands `say` and `afconvert` are required for the smoke test.");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-flow-smoke-"));
  const aiffPath = path.join(tempDir, "input.aiff");
  const wavPath = path.join(tempDir, "input.wav");

  await execFileAsync("say", ["-o", aiffPath, "Hello from Voice Flow. Please clean up this dictated sentence."]);
  await execFileAsync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", aiffPath, wavPath]);

  return {
    tempDir,
    wavPath
  };
}

async function postDictation(audioBase64) {
  const response = await fetch(`${apiUrl}/v1/dictate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      audioBase64,
      context: {
        appName: "Voice Flow Smoke Test",
        dictionaryHints: ["Voice Flow"],
        platform: "smoke-test",
        selectedText: "",
        surroundingText: ""
      },
      finalOnly: true,
      mimeType: "audio/wav"
    })
  });

  const body = await response.json();

  if (!response.ok || !body.ok) {
    throw new Error(`Dictation smoke test failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.result;
}

function assertSmokeResult(result) {
  const rawTranscript = result.rawTranscript ?? "";
  const transcribeModel = result.modelInfo?.transcribe ?? "";
  const polishModel = result.modelInfo?.polish ?? "";

  if (!rawTranscript.toLowerCase().includes(expectedPhrase.toLowerCase())) {
    throw new Error(`Unexpected transcript: ${rawTranscript}`);
  }

  if (!transcribeModel.startsWith("local-whisper:")) {
    throw new Error(`Expected local-whisper transcription, got: ${transcribeModel}`);
  }

  if (!polishModel) {
    throw new Error("Polish model was not reported.");
  }
}

let tempDir = "";

try {
  const audio = await createTestAudio();
  tempDir = audio.tempDir;
  const audioBytes = await fs.readFile(audio.wavPath);
  const result = await postDictation(audioBytes.toString("base64"));
  assertSmokeResult(result);

  console.log("PASS Audio dictation smoke test");
  console.log(`PASS Transcript: ${result.rawTranscript}`);
  console.log(`PASS Transcribe model: ${result.modelInfo.transcribe}`);
  console.log(`PASS Polish model: ${result.modelInfo.polish}`);
} finally {
  if (tempDir) {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}
