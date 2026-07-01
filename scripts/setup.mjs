import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildVoiceEnv, ensureRuntimeDirs, needsLocalWhisper, readEnvFile, repoRoot } from "./process-utils.mjs";

const execFileAsync = promisify(execFile);
const shouldInstall = process.argv.includes("--install");
const steps = [];

function record(status, label, detail = "") {
  steps.push({
    detail,
    label,
    status
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  await execFileAsync(command, args, {
    cwd: options.cwd ?? repoRoot,
    maxBuffer: 1024 * 1024 * 8
  });
}

async function ensureEnvFile() {
  const envPath = path.join(repoRoot, ".env");
  const examplePath = path.join(repoRoot, ".env.example");

  if (await exists(envPath)) {
    record("pass", ".env exists", ".env");
    return;
  }

  await fs.copyFile(examplePath, envPath);
  record("warn", ".env created", "Fill OPENAI_API_KEY before starting VoiceKit.");
}

async function ensureNodeDeps() {
  const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");

  if (await exists(electronBin)) {
    record("pass", "Node dependencies installed", "electron found");
    return;
  }

  if (!shouldInstall) {
    record("fail", "Node dependencies missing", "Run npm run voice:setup -- --install");
    return;
  }

  await run("npm", ["install"]);
  record("pass", "Node dependencies installed", "npm install completed");
}

async function ensureFnListenerBinary() {
  if (process.platform !== "darwin") {
    record("warn", "Fn listener build skipped", "This helper is only required on macOS.");
    return;
  }

  try {
    await run("node", ["scripts/build-fn-listener.mjs"]);
    record("pass", "Fn listener built", "apps/desktop/build/bin/voice-flow-fn-listener");
  } catch (error) {
    record("fail", "Fn listener build failed", error.message);
  }
}

async function ensurePythonVenv() {
  const pythonBin = path.join(repoRoot, ".venv", "bin", "python");

  if (await exists(pythonBin)) {
    record("pass", "Python venv exists", ".venv");
    return;
  }

  if (!shouldInstall) {
    record("fail", "Python venv missing", "Run npm run voice:setup -- --install");
    return;
  }

  await run("python3", ["-m", "venv", ".venv"]);
  record("pass", "Python venv created", ".venv");
}

async function ensureFasterWhisper() {
  const pythonBin = path.join(repoRoot, ".venv", "bin", "python");

  if (!(await exists(pythonBin))) {
    record("fail", "faster-whisper unavailable", "Python venv missing");
    return;
  }

  try {
    await run(pythonBin, ["-c", "import faster_whisper"]);
    record("pass", "faster-whisper installed", "import ok");
    return;
  } catch {
    if (!shouldInstall) {
      record("fail", "faster-whisper missing", "Run npm run voice:setup -- --install");
      return;
    }
  }

  await run(pythonBin, ["-m", "pip", "install", "faster-whisper"]);
  record("pass", "faster-whisper installed", "pip install completed");
}

function printSummary() {
  for (const step of steps) {
    const prefix = step.status.toUpperCase().padEnd(4);
    const detail = step.detail ? ` - ${step.detail}` : "";
    console.log(`${prefix} ${step.label}${detail}`);
  }

  const failed = steps.some((step) => step.status === "fail");

  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log("NEXT npm run voice:doctor");
  console.log("NEXT npm run voice:restart");
}

await ensureRuntimeDirs();
await ensureEnvFile();
await ensureNodeDeps();
await ensureFnListenerBinary();

const envFile = await readEnvFile();
const env = buildVoiceEnv(envFile);

if (needsLocalWhisper(env)) {
  await ensurePythonVenv();
  await ensureFasterWhisper();
} else {
  record("pass", "Local Whisper optional", "FLOW_TRANSCRIBE_MODEL is set, so Python and faster-whisper are not required.");
}

printSummary();
