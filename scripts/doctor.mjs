import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildVoiceEnv,
  isPolishEnabled,
  listProcesses,
  logsDir,
  readEnvFile,
  repoRoot
} from "./process-utils.mjs";

const execFileAsync = promisify(execFile);
const checks = [];

function addCheck(status, label, detail = "") {
  checks.push({
    detail,
    label,
    status
  });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLogTail(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split(/\r?\n/).slice(-80).join("\n");
  } catch {
    return "";
  }
}

async function checkFileSystem() {
  const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");
  const pythonBin = path.join(repoRoot, ".venv", "bin", "python");
  const modelCache = path.join(repoRoot, ".cache", "faster-whisper");

  addCheck((await pathExists(electronBin)) ? "pass" : "fail", "Electron installed", electronBin);
  addCheck((await pathExists(pythonBin)) ? "pass" : "fail", "Python venv exists", pythonBin);
  addCheck((await pathExists(modelCache)) ? "pass" : "warn", "Local model cache exists", modelCache);
}

async function checkEnv() {
  const envFile = await readEnvFile();
  const env = buildVoiceEnv(envFile);
  const provider = (env.FLOW_TRANSCRIBE_PROVIDER ?? "").trim().toLowerCase();
  const polishEnabled = isPolishEnabled(env);
  const transcribeModel = env.FLOW_TRANSCRIBE_MODEL?.trim() || "";
  const needsOpenAIConfig = provider === "openai" && (polishEnabled || Boolean(transcribeModel));

  addCheck(env.FLOW_TRANSCRIBE_PROVIDER ? "pass" : "fail", "FLOW_TRANSCRIBE_PROVIDER configured", env.FLOW_TRANSCRIBE_PROVIDER ? "set" : "missing");
  addCheck("pass", "Polish pass", `FLOW_POLISH_ENABLED=${env.FLOW_POLISH_ENABLED}`);

  if (needsOpenAIConfig) {
    for (const key of ["OPENAI_API_KEY", "FLOW_OPENAI_BASE_URL"]) {
      addCheck(env[key] ? "pass" : "fail", `${key} configured`, env[key] ? "set" : "missing");
    }
  }

  if (provider === "openai" && polishEnabled) {
    addCheck(env.FLOW_POLISH_MODEL ? "pass" : "fail", "FLOW_POLISH_MODEL configured", env.FLOW_POLISH_MODEL ? "set" : "missing");
  }

  addCheck(
    env.FLOW_PREFER_BROWSER_SPEECH_RECOGNITION === "false" ? "pass" : "warn",
    "Desktop avoids browser SpeechRecognition",
    `FLOW_PREFER_BROWSER_SPEECH_RECOGNITION=${env.FLOW_PREFER_BROWSER_SPEECH_RECOGNITION ?? ""}`
  );
}

async function checkPythonWhisper() {
  const pythonBin = path.join(repoRoot, ".venv", "bin", "python");

  if (!(await pathExists(pythonBin))) {
    addCheck("fail", "faster-whisper import", "Python venv missing");
    return;
  }

  try {
    await execFileAsync(pythonBin, ["-c", "import faster_whisper"], {
      cwd: repoRoot,
      timeout: 10000
    });
    addCheck("pass", "faster-whisper import", "ok");
  } catch (error) {
    addCheck("fail", "faster-whisper import", error.message);
  }
}

async function checkProcesses() {
  let processes = [];

  try {
    processes = await listProcesses();
  } catch (error) {
    addCheck("warn", "Process scan", error.message);
    return;
  }

  const api = processes.filter((processInfo) => processInfo.command.includes("apps/api/src/index.mjs"));
  const desktopWrapper = processes.filter((processInfo) =>
    processInfo.command.includes("node_modules/.bin/electron src/main.mjs")
  );
  const electronMain = processes.filter((processInfo) =>
    processInfo.command.includes("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron src/main.mjs")
  );
  const whisperWorker = processes.filter((processInfo) => processInfo.command.includes("local-whisper-worker.py"));

  addCheck(api.length === 1 ? "pass" : "fail", "One API process", `count=${api.length}`);
  addCheck(desktopWrapper.length === 1 ? "pass" : "fail", "One desktop launcher process", `count=${desktopWrapper.length}`);
  addCheck(electronMain.length === 1 ? "pass" : "fail", "One Electron main process", `count=${electronMain.length}`);
  addCheck(whisperWorker.length <= 1 ? "pass" : "warn", "Whisper worker count", `count=${whisperWorker.length}`);
}

async function checkApiHealth() {
  try {
    const response = await fetch("http://127.0.0.1:8000/health");
    const body = await response.json();
    addCheck(response.ok && body.ok ? "pass" : "fail", "API health", JSON.stringify(body));
  } catch (error) {
    addCheck("fail", "API health", error.message);
  }
}

async function checkLogs() {
  const apiLog = await readLogTail(path.join(logsDir, "api.log"));
  const desktopLog = await readLogTail(path.join(logsDir, "desktop.log"));
  const combined = `${apiLog}\n${desktopLog}`;
  const badPatterns = ["EADDRINUSE", "write EIO", "Uncaught Exception"];
  const hits = badPatterns.filter((pattern) => combined.includes(pattern));

  addCheck(hits.length === 0 ? "pass" : "warn", "Recent logs", hits.length === 0 ? "no known startup errors" : hits.join(", "));
}

function printResults() {
  for (const check of checks) {
    const prefix = check.status.toUpperCase().padEnd(4);
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`${prefix} ${check.label}${detail}`);
  }

  const hasFailures = checks.some((check) => check.status === "fail");

  if (hasFailures) {
    process.exitCode = 1;
  }
}

await checkFileSystem();
await checkEnv();
await checkPythonWhisper();
await checkProcesses();
await checkApiHealth();
await checkLogs();
printResults();
