import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, systemPreferences } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveContext } from "./macos-context.mjs";
import { pasteText } from "./paste-text.mjs";
import { installRuntimeGuards } from "../../../packages/shared/src/runtime-guards.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardHtmlPath = path.join(__dirname, "renderer", "index.html");
const petHtmlPath = path.join(__dirname, "renderer", "pet.html");
const runtimeLogFilePath = path.resolve(__dirname, "../../../.cache/desktop-main.log");
const runtimeStateFilePath = path.resolve(__dirname, "../../../.cache/desktop-runtime-state.json");
const hasSingleInstanceLock = app.requestSingleInstanceLock();

installRuntimeGuards({
  logFilePath: runtimeLogFilePath
});

if (!hasSingleInstanceLock) {
  app.exit(0);
}

let petWindow = null;
let dashboardWindow = null;
let permissionsConfigured = false;
let isQuitting = false;
let petHideTimer = null;
let lastCapturedContext = null;
let runtimeStateWrite = Promise.resolve();
const isMac = process.platform === "darwin";
const petWindowSize = {
  width: 140,
  height: 58
};

const settings = {
  apiBaseUrl: process.env.FLOW_API_BASE_URL ?? "http://127.0.0.1:8000",
  hotkey: process.env.FLOW_HOTKEY ?? "Alt+Space",
  autoPaste: (process.env.FLOW_AUTO_PASTE ?? "true").toLowerCase() === "true",
  autoStopAfterSilenceMs: getNumberEnv("FLOW_AUTO_STOP_SILENCE_MS", 650, 350, 2000),
  autoStopMaxInitialSilenceMs: getNumberEnv("FLOW_AUTO_STOP_MAX_INITIAL_SILENCE_MS", 8000, 3000, 15000),
  minimumAutoStopRecordingMs: getNumberEnv("FLOW_MIN_RECORDING_MS", 700, 250, 2000),
  preferBrowserSpeechRecognition:
    (process.env.FLOW_PREFER_BROWSER_SPEECH_RECOGNITION ?? "false").toLowerCase() === "true",
  transcribeModel: process.env.FLOW_TRANSCRIBE_MODEL ?? "",
  transcribeProvider: process.env.FLOW_TRANSCRIBE_PROVIDER ?? "mock"
};

const uiState = {
  mode: "idle",
  status: "Press the hotkey to dictate.",
  micStatus: "Microphone status is loading...",
  rawTranscript: "No transcript yet.",
  polishedText: "No polished output yet.",
  provider: "unknown",
  isRecording: false,
  dashboardVisible: false,
  updatedAt: Date.now()
};

function toMicrophoneState(rawStatus) {
  if (rawStatus === "granted") {
    return {
      status: "granted",
      message: "Microphone access granted."
    };
  }

  if (rawStatus === "denied" || rawStatus === "restricted") {
    return {
      status: "denied",
      message: "Microphone access is denied. Enable it in System Settings > Privacy & Security > Microphone."
    };
  }

  return {
    status: "pending",
    message: "Microphone access has not been granted yet."
  };
}

function getMicrophoneAccessStatus() {
  if (!isMac) {
    return {
      status: "unknown",
      rawStatus: "unsupported",
      message: "Desktop microphone status is only implemented for macOS right now."
    };
  }

  const rawStatus = systemPreferences.getMediaAccessStatus("microphone");
  return {
    rawStatus,
    ...toMicrophoneState(rawStatus)
  };
}

async function ensureMicrophoneAccess() {
  if (!isMac) {
    return getMicrophoneAccessStatus();
  }

  const current = getMicrophoneAccessStatus();

  if (current.status !== "pending") {
    return current;
  }

  const granted = await systemPreferences.askForMediaAccess("microphone");
  const next = getMicrophoneAccessStatus();

  return {
    ...next,
    message: granted
      ? "Microphone access granted."
      : "Microphone access was not granted. Enable it in System Settings > Privacy & Security > Microphone."
  };
}

function isMediaPermission(permission) {
  return permission === "media" || permission === "microphone" || permission === "audioCapture";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getNumberEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name] ?? fallback);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return clamp(parsed, min, max);
}

function clearPetHideTimer() {
  if (!petHideTimer) {
    return;
  }

  clearTimeout(petHideTimer);
  petHideTimer = null;
}

function schedulePetWindowHide(delayMs, { resetModes = [] } = {}) {
  clearPetHideTimer();
  petHideTimer = setTimeout(() => {
    if (!petWindow || petWindow.isDestroyed() || uiState.isRecording || uiState.mode === "processing") {
      return;
    }

    petWindow.hide();

    if (resetModes.includes(uiState.mode)) {
      broadcastUiState({
        mode: "idle",
        status: "Press the hotkey to dictate.",
        isRecording: false
      });
    }
  }, delayMs);
}

function positionPetWindowNearCursor() {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { width, height } = petWindowSize;
  const padding = 10;
  const offset = 18;
  const minX = display.workArea.x + padding;
  const maxX = display.workArea.x + display.workArea.width - width - padding;
  const minY = display.workArea.y + padding;
  const maxY = display.workArea.y + display.workArea.height - height - padding;
  const preferredY = cursor.y - height - offset;
  const fallbackY = cursor.y + offset;
  const nextX = clamp(cursor.x - Math.round(width / 2), minX, maxX);
  const nextY = clamp(preferredY >= minY ? preferredY : fallbackY, minY, maxY);

  petWindow.setBounds({
    x: nextX,
    y: nextY,
    width,
    height
  });
}

function revealPetWindow({ nearCursor = false } = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow();
  }

  clearPetHideTimer();

  if (nearCursor) {
    positionPetWindowNearCursor();
  }

  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.showInactive();
}

function syncPetWindowVisibility() {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }

  if (uiState.mode === "listening" || uiState.mode === "processing") {
    revealPetWindow();
    return;
  }

  if (uiState.mode === "done") {
    revealPetWindow();
    schedulePetWindowHide(900, { resetModes: ["done"] });
    return;
  }

  if (uiState.mode === "error") {
    revealPetWindow();
    schedulePetWindowHide(1600, { resetModes: ["error"] });
    return;
  }

  if (uiState.mode === "idle") {
    schedulePetWindowHide(180);
  }
}

function broadcastUiState(patch = {}) {
  Object.assign(uiState, patch, { updatedAt: Date.now() });
  persistRuntimeStateSnapshot();

  for (const window of [petWindow, dashboardWindow]) {
    if (!window || window.isDestroyed()) {
      continue;
    }

    window.webContents.send("flow:ui-state", uiState);
  }

  syncPetWindowVisibility();
}

function buildRuntimeStateSnapshot() {
  return {
    autoPaste: settings.autoPaste,
    capturedAppName: lastCapturedContext?.appName ?? "",
    dashboardVisible: uiState.dashboardVisible,
    hotkey: settings.hotkey,
    isRecording: uiState.isRecording,
    micStatus: uiState.micStatus,
    mode: uiState.mode,
    provider: uiState.provider,
    status: uiState.status,
    updatedAt: uiState.updatedAt
  };
}

function persistRuntimeStateSnapshot() {
  const snapshot = buildRuntimeStateSnapshot();

  runtimeStateWrite = runtimeStateWrite
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(runtimeStateFilePath), { recursive: true });
      await fs.writeFile(runtimeStateFilePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    })
    .catch(() => {});
}

async function safeGetActiveContext() {
  try {
    return await getActiveContext();
  } catch {
    return {
      appName: "unknown",
      dictionaryHints: [],
      platform: process.platform,
      selectedText: "",
      surroundingText: ""
    };
  }
}

function configurePermissions(session) {
  if (permissionsConfigured) {
    return;
  }

  permissionsConfigured = true;

  session.setPermissionCheckHandler((_webContents, permission) => {
    if (isMediaPermission(permission)) {
      return true;
    }

    return false;
  });

  session.setPermissionRequestHandler(async (_webContents, permission, callback) => {
    if (!isMediaPermission(permission)) {
      callback(false);
      return;
    }

    const access = await ensureMicrophoneAccess();
    callback(access.status === "granted");
  });
}

function createPetWindow() {
  petWindow = new BrowserWindow({
    width: petWindowSize.width,
    height: petWindowSize.height,
    minWidth: petWindowSize.width,
    minHeight: petWindowSize.height,
    maxWidth: petWindowSize.width,
    maxHeight: petWindowSize.height,
    title: "Voice Flow",
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    vibrancy: "hud",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  configurePermissions(petWindow.webContents.session);
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.loadFile(petHtmlPath);
  petWindow.on("closed", () => {
    petWindow = null;
  });
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    return dashboardWindow;
  }

  dashboardWindow = new BrowserWindow({
    width: 420,
    height: 620,
    minWidth: 380,
    minHeight: 560,
    title: "Voice Flow Dashboard",
    show: false,
    backgroundColor: "#f6f3ec",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  configurePermissions(dashboardWindow.webContents.session);
  dashboardWindow.loadFile(dashboardHtmlPath);
  dashboardWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    dashboardWindow.hide();
    broadcastUiState({ dashboardVisible: false });
  });
  dashboardWindow.on("show", () => {
    broadcastUiState({ dashboardVisible: true });
  });
  dashboardWindow.on("hide", () => {
    broadcastUiState({ dashboardVisible: false });
  });

  return dashboardWindow;
}

function showDashboard() {
  const window = createDashboardWindow();
  window.show();
  window.focus();
  broadcastUiState({ dashboardVisible: true });
}

function hideDashboard() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    return;
  }

  dashboardWindow.hide();
  broadcastUiState({ dashboardVisible: false });
}

async function callDictationApi(payload) {
  const response = await fetch(`${settings.apiBaseUrl}/v1/dictate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    let message = errorText;

    try {
      message = JSON.parse(errorText).error || errorText;
    } catch {
      // The API normally returns JSON errors, but keep plain text readable too.
    }

    throw new Error(message || `Dictation API error: ${response.status}`);
  }

  const json = await response.json();
  return json.result;
}

function registerHotkey() {
  globalShortcut.register(settings.hotkey, () => {
    void (async () => {
      if (uiState.mode === "processing") {
        return;
      }

      if (uiState.isRecording) {
        petWindow?.webContents.send("flow:hotkey-toggle", {
          action: "stop"
        });
        return;
      }

      lastCapturedContext = await safeGetActiveContext();
      revealPetWindow({ nearCursor: true });
      petWindow?.webContents.send("flow:hotkey-toggle", {
        action: "start"
      });
    })();
  });
}

app.whenReady().then(() => {
  createPetWindow();
  createDashboardWindow();
  registerHotkey();
  broadcastUiState({
    micStatus: getMicrophoneAccessStatus().message
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPetWindow();
      createDashboardWindow();
    } else {
      showDashboard();
    }
  });
});

app.on("second-instance", () => {
  revealPetWindow({ nearCursor: true });
});

app.on("will-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
});

ipcMain.handle("flow:get-settings", async () => settings);
ipcMain.handle("flow:get-context", async () => lastCapturedContext ?? safeGetActiveContext());
ipcMain.handle("flow:get-microphone-status", async () => getMicrophoneAccessStatus());
ipcMain.handle("flow:ensure-microphone-access", async () => ensureMicrophoneAccess());
ipcMain.handle("flow:get-ui-state", async () => uiState);
ipcMain.handle("flow:update-ui-state", async (_event, patch) => {
  broadcastUiState(patch);
  return uiState;
});
ipcMain.handle("flow:show-dashboard", async () => {
  showDashboard();
  return true;
});
ipcMain.handle("flow:hide-dashboard", async () => {
  hideDashboard();
  return true;
});
ipcMain.handle("flow:open-external-url", async (_event, url) => {
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("flow:process-dictation", async (_event, payload) => {
  try {
    const result = await callDictationApi(payload);
    const textToPaste = result.polishedText || result.rawTranscript || "";
    let pasteError = "";

    if (settings.autoPaste && textToPaste) {
      try {
        await pasteText(textToPaste);
      } catch (error) {
        pasteError = error instanceof Error ? error.message : "Paste automation failed.";
      }
    }

    broadcastUiState({
      mode: pasteError ? "error" : "done",
      isRecording: false,
      status: pasteError || (settings.autoPaste ? "Pasted back into your app." : `Transcribed with ${result.provider}.`),
      rawTranscript: result.rawTranscript,
      polishedText: textToPaste,
      provider: result.provider,
      micStatus: getMicrophoneAccessStatus().message
    });

    return {
      ...result,
      pasteError
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dictation failed.";

    broadcastUiState({
      mode: "error",
      isRecording: false,
      status: message,
      micStatus: getMicrophoneAccessStatus().message
    });

    return {
      error: message,
      ok: false
    };
  } finally {
    lastCapturedContext = null;
  }
});
