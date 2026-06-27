import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");
const defaultPythonPath = path.join(repoRoot, ".venv", "bin", "python");
const workerScriptPath = path.join(__dirname, "local-whisper-worker.py");
const modelCacheDir = path.join(repoRoot, ".cache", "faster-whisper");

let requestId = 0;
let workerStatePromise = null;

function getLocalModelName() {
  return process.env.FLOW_LOCAL_TRANSCRIBE_MODEL?.trim() || "base";
}

function getLocalComputeType() {
  return process.env.FLOW_LOCAL_TRANSCRIBE_COMPUTE_TYPE?.trim() || "int8";
}

function getPythonPath() {
  return process.env.FLOW_LOCAL_TRANSCRIBE_PYTHON?.trim() || defaultPythonPath;
}

function inferExtensionFromMimeType(mimeType) {
  if (mimeType.includes("wav")) {
    return "wav";
  }

  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return "mp3";
  }

  if (mimeType.includes("mp4") || mimeType.includes("m4a")) {
    return "m4a";
  }

  return "webm";
}

async function writeAudioToTempFile(audioBase64, mimeType) {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "voice-flow-"));
  const extension = inferExtensionFromMimeType(mimeType);
  const audioPath = path.join(tempDir, `input.${extension}`);
  await fsPromises.writeFile(audioPath, Buffer.from(audioBase64, "base64"));
  return {
    audioPath,
    tempDir
  };
}

async function ensureWorker() {
  if (workerStatePromise) {
    return workerStatePromise;
  }

  workerStatePromise = (async () => {
    const pythonPath = getPythonPath();

    if (!fs.existsSync(pythonPath)) {
      throw new Error(
        `Local speech transcription is not ready yet because ${pythonPath} does not exist. Create the workspace .venv and install faster-whisper first.`
      );
    }

    await fsPromises.mkdir(modelCacheDir, { recursive: true });

    const child = spawn(
      pythonPath,
      [
        "-u",
        workerScriptPath,
        "--cache-dir",
        modelCacheDir,
        "--compute-type",
        getLocalComputeType(),
        "--model",
        getLocalModelName()
      ],
      {
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    const pending = new Map();
    const stderrChunks = [];

    const failPending = (message) => {
      for (const { reject } of pending.values()) {
        reject(new Error(message));
      }
      pending.clear();
    };

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk.toString());
    });

    child.on("error", (error) => {
      failPending(`Local speech worker crashed before it could start: ${error.message}`);
      workerStatePromise = null;
    });

    child.on("exit", (code, signal) => {
      const stderr = stderrChunks.join("").trim();
      const detail = stderr ? ` ${stderr}` : "";
      failPending(`Local speech worker exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"}).${detail}`);
      workerStatePromise = null;
    });

    const lineReader = readline.createInterface({
      input: child.stdout
    });

    return await new Promise((resolve, reject) => {
      lineReader.on("line", (line) => {
        let message;

        try {
          message = JSON.parse(line);
        } catch (error) {
          return;
        }

        if (message.event === "error") {
          const error = new Error(message.error || "Local speech worker failed to initialize.");
          workerStatePromise = null;
          reject(error);
          return;
        }

        if (message.event === "ready") {
          resolve({
            child,
            modelLabel: `local-whisper:${message.model}`,
            request(audioPath) {
              const id = String(++requestId);

              return new Promise((resolveRequest, rejectRequest) => {
                pending.set(id, {
                  reject: rejectRequest,
                  resolve: resolveRequest
                });

                child.stdin.write(`${JSON.stringify({ id, audio_path: audioPath })}\n`, (error) => {
                  if (!error) {
                    return;
                  }

                  pending.delete(id);
                  rejectRequest(new Error(`Failed to send audio to the local speech worker: ${error.message}`));
                });
              });
            }
          });
          return;
        }

        const entry = pending.get(String(message.id));

        if (!entry) {
          return;
        }

        pending.delete(String(message.id));

        if (message.error) {
          entry.reject(new Error(`Local speech transcription failed: ${message.error}`));
          return;
        }

        entry.resolve(message);
      });

      lineReader.on("close", () => {
        if (pending.size > 0) {
          failPending("Local speech worker closed before returning a result.");
        }
      });
    });
  })();

  workerStatePromise = workerStatePromise.catch((error) => {
    workerStatePromise = null;
    throw error;
  });

  return workerStatePromise;
}

export async function warmLocalWhisper() {
  await ensureWorker();
}

export async function transcribeWithLocalWhisper({ audioBase64, mimeType }) {
  if (!audioBase64) {
    throw new Error("Audio input is required for local speech transcription.");
  }

  const { audioPath, tempDir } = await writeAudioToTempFile(audioBase64, mimeType);

  try {
    const worker = await ensureWorker();
    const result = await worker.request(audioPath);

    return {
      language: result.language,
      languageProbability: result.language_probability,
      modelLabel: worker.modelLabel,
      rawTranscript: result.text || ""
    };
  } finally {
    await fsPromises.rm(tempDir, { force: true, recursive: true });
  }
}
