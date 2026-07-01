import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
export const cacheDir = path.join(repoRoot, ".cache");
export const logsDir = path.join(cacheDir, "logs");
export const pidDir = path.join(cacheDir, "pids");
export const defaultHotkey = "CommandOrControl+Shift+Space";
export const defaultHoldKey = "control";
export const defaultTriggerMode = process.platform === "darwin" ? "fn_hold" : "hotkey";

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
    FLOW_API_HOST: "127.0.0.1",
    FLOW_API_PORT: "8000",
    FLOW_API_TOKEN: "local-dev-token",
    FLOW_API_TOKENS: "local-dev-token",
    FLOW_AUTO_PASTE: "true",
    FLOW_AUTO_STOP_MAX_INITIAL_SILENCE_MS: "8000",
    FLOW_AUTO_STOP_SILENCE_MS: "650",
    FLOW_HOLD_KEY: defaultHoldKey,
    FLOW_HOTKEY: defaultHotkey,
    FLOW_TRIGGER_MODE: defaultTriggerMode,
    FLOW_LOCAL_TRANSCRIBE_COMPUTE_TYPE: "int8",
    FLOW_LOCAL_TRANSCRIBE_MODEL: "base",
    FLOW_MIN_RECORDING_MS: "700",
    FLOW_OPENAI_BASE_URL: "https://api.openai.com/v1",
    FLOW_POLISH_ENABLED: "true",
    FLOW_POLISH_MODEL: "gpt-4.1-mini",
    FLOW_PREFER_BROWSER_SPEECH_RECOGNITION: "false",
    FLOW_TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe",
    FLOW_TRANSCRIBE_PROVIDER: "openai"
  };

  return {
    ...defaults,
    ...extraEnv,
    ...process.env
  };
}

export function isLocalApiBaseUrl(value) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return false;
  }

  try {
    const url = new URL(raw);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function getApiMode(env = process.env) {
  return isLocalApiBaseUrl(env.FLOW_API_BASE_URL) ? "local" : "hosted";
}

export function needsLocalWhisper(env = process.env) {
  const provider = String(env.FLOW_TRANSCRIBE_PROVIDER ?? "mock").trim().toLowerCase();
  const transcribeModel = String(env.FLOW_TRANSCRIBE_MODEL ?? "").trim();

  return provider === "openai" && !transcribeModel;
}

export function isPolishEnabled(env = process.env) {
  const raw = env.FLOW_POLISH_ENABLED;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }

  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

export function formatHotkeyForDisplay(value, platform = process.platform) {
  return value
    .replaceAll("CommandOrControl", platform === "darwin" ? "Command" : "Control")
    .replaceAll("Meta", platform === "darwin" ? "Command" : "Meta")
    .replaceAll("Alt", platform === "darwin" ? "Option" : "Alt")
    .replaceAll("+", " + ");
}

export function normalizeHoldKey(value, fallback = defaultHoldKey) {
  const normalized = String(value ?? fallback).trim().toLowerCase();

  if (normalized === "ctrl") {
    return "control";
  }

  if (normalized === "alt") {
    return "option";
  }

  if (normalized === "cmd" || normalized === "meta") {
    return "command";
  }

  if (normalized === "function") {
    return "fn";
  }

  if (["fn", "control", "option", "shift", "command"].includes(normalized)) {
    return normalized;
  }

  return fallback;
}

export function getHoldKey(env = process.env) {
  return normalizeHoldKey(env.FLOW_HOLD_KEY);
}

export function formatHoldKeyForDisplay(value) {
  const normalized = normalizeHoldKey(value);

  if (normalized === "fn") {
    return "Fn";
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function getTriggerMode(env = process.env, platform = process.platform) {
  const raw = env.FLOW_TRIGGER_MODE ?? (platform === "darwin" ? "fn_hold" : "hotkey");
  const normalized = String(raw).trim().toLowerCase();

  if (!normalized) {
    return platform === "darwin" ? "fn_hold" : "hotkey";
  }

  if (normalized === "hold") {
    return "fn_hold";
  }

  return normalized;
}

export function getTriggerLabel({
  holdKey = defaultHoldKey,
  hotkey = defaultHotkey,
  platform = process.platform,
  triggerMode = getTriggerMode({ FLOW_TRIGGER_MODE: defaultTriggerMode }, platform)
} = {}) {
  if (platform === "darwin" && triggerMode === "fn_hold") {
    return `${formatHoldKeyForDisplay(holdKey)} (hold)`;
  }

  return formatHotkeyForDisplay(hotkey, platform);
}

export function buildAppleScriptHotkeyLines(accelerator) {
  const parts = accelerator.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop();
  const modifiers = [];

  for (const part of parts) {
    if (part === "CommandOrControl" || part === "Command" || part === "Meta") {
      modifiers.push("command down");
      continue;
    }

    if (part === "Alt" || part === "Option") {
      modifiers.push("option down");
      continue;
    }

    if (part === "Shift") {
      modifiers.push("shift down");
      continue;
    }

    if (part === "Control") {
      modifiers.push("control down");
      continue;
    }

    throw new Error(`Unsupported hotkey modifier for AppleScript: ${part}`);
  }

  let keyCommand = "";

  if (key === "Space") {
    keyCommand = "key code 49";
  } else if (key && /^[A-Za-z0-9]$/.test(key)) {
    keyCommand = `keystroke "${key.toLowerCase()}"`;
  } else {
    throw new Error(`Unsupported hotkey key for AppleScript: ${key}`);
  }

  if (modifiers.length > 0) {
    keyCommand += ` using {${modifiers.join(", ")}}`;
  }

  return [
    'tell application "System Events"',
    keyCommand,
    "end tell"
  ];
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
    command.includes("apps/desktop/build/bin/voice-flow-fn-listener") ||
    command.includes("apps/desktop/bin/voice-flow-fn-listener") ||
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
