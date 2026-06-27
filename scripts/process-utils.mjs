import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
export const cacheDir = path.join(repoRoot, ".cache");
export const logsDir = path.join(cacheDir, "logs");
export const pidDir = path.join(cacheDir, "pids");

export async function ensureRuntimeDirs() {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(pidDir, { recursive: true });
}

export async function readEnvFile(filePath = path.join(repoRoot, ".env")) {
  const env = {};
  let raw = "";

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return env;
    }

    throw error;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

export function buildVoiceEnv(extraEnv = {}) {
  const defaults = {
    FLOW_API_BASE_URL: "http://127.0.0.1:8000",
    FLOW_API_PORT: "8000",
    FLOW_AUTO_PASTE: "true",
    FLOW_AUTO_STOP_MAX_INITIAL_SILENCE_MS: "8000",
    FLOW_AUTO_STOP_SILENCE_MS: "650",
    FLOW_HOTKEY: "Alt+Space",
    FLOW_LOCAL_TRANSCRIBE_COMPUTE_TYPE: "int8",
    FLOW_LOCAL_TRANSCRIBE_MODEL: "base",
    FLOW_MIN_RECORDING_MS: "700",
    FLOW_OPENAI_BASE_URL: "https://api.openai.com/v1",
    FLOW_POLISH_MODEL: "gpt-4.1-mini",
    FLOW_PREFER_BROWSER_SPEECH_RECOGNITION: "false",
    FLOW_TRANSCRIBE_PROVIDER: "openai"
  };

  return {
    ...defaults,
    ...extraEnv,
    ...process.env
  };
}

export async function listProcesses() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid,ppid,pgid,command"], {
    maxBuffer: 1024 * 1024 * 8
  });

  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);

      if (!match) {
        return null;
      }

      return {
        command: match[4],
        pgid: Number(match[3]),
        pid: Number(match[1]),
        ppid: Number(match[2])
      };
    })
    .filter(Boolean);
}

export function isVoiceProcess(processInfo) {
  const command = processInfo.command;

  return (
    command.includes("apps/api/src/index.mjs") ||
    command.includes("apps/desktop/src/main.mjs") ||
    command.includes("node_modules/.bin/electron src/main.mjs") ||
    command.includes("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron src/main.mjs") ||
    command.includes("local-whisper-worker.py")
  );
}

export async function killPid(pid, signal = "SIGTERM") {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

export async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
