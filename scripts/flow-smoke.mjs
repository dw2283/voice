import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "./process-utils.mjs";

const execFileAsync = promisify(execFile);
const apiUrl = process.env.FLOW_API_BASE_URL ?? "http://127.0.0.1:8000";
const expectedPhrase = "Hello from VoiceKit";

async function commandExists(command) {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function runAppleScript(lines) {
  const args = lines.flatMap((line) => ["-e", line]);
  const { stdout } = await execFileAsync("osascript", args, {
    timeout: 10000
  });

  return stdout.trim();
}

async function createTestAudio() {
  if (!(await commandExists("say")) || !(await commandExists("afconvert"))) {
    throw new Error("macOS commands `say` and `afconvert` are required for the flow smoke test.");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-flow-full-smoke-"));
  const aiffPath = path.join(tempDir, "input.aiff");
  const wavPath = path.join(tempDir, "input.wav");

  await execFileAsync("say", ["-o", aiffPath, "Hello from VoiceKit. Please clean up this dictated sentence."]);
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
        appName: "TextEdit",
        dictionaryHints: ["VoiceKit"],
        platform: "flow-smoke-test",
        selectedText: "",
        surroundingText: ""
      },
      finalOnly: true,
      mimeType: "audio/wav"
    })
  });
  const body = await response.json();

  if (!response.ok || !body.ok) {
    throw new Error(`Dictation request failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.result;
}

async function prepareTextEditDocument() {
  await runAppleScript([
    'tell application "TextEdit"',
    "activate",
    "make new document with properties {text:\"\"}",
    "end tell",
    "delay 0.3"
  ]);
}

async function readAndCloseTextEditDocument() {
  return runAppleScript([
    'tell application "TextEdit"',
    "set pastedText to text of front document",
    "close front document saving no",
    "return pastedText",
    "end tell"
  ]);
}

async function pasteWithElectron(text) {
  const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");
  const helperPath = path.join(repoRoot, "scripts", "paste-smoke-electron-app");

  await fs.access(electronBin);
  await execFileAsync(electronBin, [helperPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      VOICE_FLOW_PASTE_SMOKE_TEXT: text
    },
    timeout: 20000
  });
}

function assertDictationResult(result) {
  const rawTranscript = result.rawTranscript ?? "";
  const polishedText = result.polishedText ?? "";
  const transcribeModel = result.modelInfo?.transcribe ?? "";
  const polishModel = result.modelInfo?.polish ?? "";

  if (!rawTranscript.toLowerCase().includes(expectedPhrase.toLowerCase())) {
    throw new Error(`Unexpected transcript: ${rawTranscript}`);
  }

  if (!polishedText.trim()) {
    throw new Error("Polish model returned empty text.");
  }

  if (!transcribeModel.startsWith("local-whisper:")) {
    throw new Error(`Expected local-whisper transcription, got: ${transcribeModel}`);
  }

  if (!polishModel) {
    throw new Error("Polish model was not reported.");
  }
}

if (process.platform !== "darwin") {
  throw new Error("Flow smoke test is macOS-only because paste-back uses TextEdit and osascript.");
}

if (!(await commandExists("osascript"))) {
  throw new Error("macOS command `osascript` is required for the flow smoke test.");
}

let tempDir = "";

try {
  const audio = await createTestAudio();
  tempDir = audio.tempDir;
  const audioBytes = await fs.readFile(audio.wavPath);
  const result = await postDictation(audioBytes.toString("base64"));
  assertDictationResult(result);

  await prepareTextEditDocument();

  try {
    await pasteWithElectron(result.polishedText);
    const pastedText = await readAndCloseTextEditDocument();

    if (!pastedText.includes(result.polishedText)) {
      throw new Error(`TextEdit did not receive polished text. Expected "${result.polishedText}", got "${pastedText}".`);
    }

    console.log("PASS Flow smoke test");
    console.log(`PASS Transcript: ${result.rawTranscript}`);
    console.log(`PASS Polished text: ${result.polishedText}`);
    console.log(`PASS Transcribe model: ${result.modelInfo.transcribe}`);
    console.log(`PASS Polish model: ${result.modelInfo.polish}`);
    console.log("PASS Paste target: TextEdit");
  } catch (error) {
    try {
      await readAndCloseTextEditDocument();
    } catch {
      // Best-effort cleanup: do not mask the original failure.
    }

    throw error;
  }
} finally {
  if (tempDir) {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}
