import { execFile, spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, systemPreferences } from "electron";
import { getActiveContext } from "./macos-context.mjs";
import { pasteText } from "./paste-text.mjs";
import { installRuntimeGuards } from "../../../packages/shared/src/runtime-guards.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardHtmlPath = path.join(__dirname, "renderer", "index.html");
const petHtmlPath = path.join(__dirname, "renderer", "pet.html");
const fnKeyListenerSourcePath = path.join(__dirname, "fn-key-listener.m");
const fnKeyListenerBinaryPath = path.resolve(__dirname, "../bin/voice-flow-fn-listener");
const runtimeLogFilePath = path.resolve(__dirname, "../../../.cache/desktop-main.log");
const runtimeStateFilePath = path.resolve(__dirname, "../../../.cache/desktop-runtime-state.json");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const execFileAsync = promisify(execFile);

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
let fnKeyListenerProcess = null;
let fnKeyListenerReader = null;
let runtimeStateWrite = Promise.resolve();
let fnHoldPressed = false;
let lastPetAnchor = "hidden";
const isMac = process.platform === "darwin";
const petWindowSize = {
  width: 154,
  height: 64
};
const configuredTriggerMode = String(process.env.FLOW_TRIGGER_MODE ?? (isMac ? "fn_hold" : "hotkey"))
  .trim()
  .toLowerCase();
const configuredHotkey = process.env.FLOW_HOTKEY ?? "CommandOrControl+Shift+Space";

const settings = {
  apiBaseUrl: process.env.FLOW_API_BASE_URL ?? "http://127.0.0.1:8000",
  hotkey: configuredHotkey,
  triggerMode: configuredTriggerMode,
  triggerLabel: configuredTriggerMode === "fn_hold" && isMac ? "Fn (hold)" : formatAcceleratorLabel(configuredHotkey),
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
  status: getIdleStatusText(),
  micStatus: "Microphone status is loading...",
  hotkeyRegistered: false,
  hotkeyStatus: `${settings.triggerLabel} is getting ready.`,
  hotkeyTriggerCount: 0,
  lastHotkeyTriggeredAt: "",
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

function formatAcceleratorLabel(value) {
  return value
    .replaceAll("CommandOrControl", isMac ? "Command" : "Control")
    .replaceAll("Meta", isMac ? "Command" : "Meta")
    .replaceAll("Alt", isMac ? "Option" : "Alt")
    .replaceAll("+", " + ");
}

function getIdleStatusText() {
  if (settings.triggerMode === "fn_hold" && isMac) {
    return "Hold fn to dictate.";
  }

  return "Press the hotkey to dictate.";
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

function applyPetOverlayBehavior() {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }

  petWindow.setFocusable(false);
  petWindow.setAlwaysOnTop(true, "screen-saver", 1);

  if (isMac) {
    petWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    });
    return;
  }

  petWindow.setVisibleOnAllWorkspaces(true);
}

function schedulePetWindowHide(delayMs, { resetModes = [] } = {}) {
  clearPetHideTimer();
  petHideTimer = setTimeout(() => {
    if (!petWindow || petWindow.isDestroyed() || uiState.isRecording || uiState.mode === "processing") {
      return;
    }

    petWindow.hide();
    lastPetAnchor = "hidden";

    if (resetModes.includes(uiState.mode)) {
      broadcastUiState({
        mode: "idle",
        status: getIdleStatusText(),
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
  lastPetAnchor = "cursor";
}

function positionPetWindowNearActiveWindow(windowBounds) {
  if (!petWindow || petWindow.isDestroyed() || !windowBounds) {
    return false;
  }

  const { width, height } = petWindowSize;
  const anchorPoint = {
    x: windowBounds.x + Math.round(windowBounds.width / 2),
    y: windowBounds.y + Math.min(28, Math.max(18, Math.round(windowBounds.height * 0.08)))
  };
  const display = screen.getDisplayNearestPoint(anchorPoint);
  const padding = 10;
  const minX = display.workArea.x + padding;
  const maxX = display.workArea.x + display.workArea.width - width - padding;
  const minY = display.workArea.y + padding;
  const maxY = display.workArea.y + display.workArea.height - height - padding;
  const nextX = clamp(anchorPoint.x - Math.round(width / 2), minX, maxX);
  const nextY = clamp(anchorPoint.y, minY, maxY);

  petWindow.setBounds({
    x: nextX,
    y: nextY,
    width,
    height
  });
  lastPetAnchor = "active-window";
  return true;
}

function revealPetWindow({ nearCursor = false, context = null } = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow();
  }

  clearPetHideTimer();
  applyPetOverlayBehavior();

  const positionedNearWindow = context?.windowBounds ? positionPetWindowNearActiveWindow(context.windowBounds) : false;

  if (!positionedNearWindow && nearCursor) {
    positionPetWindowNearCursor();
  }

  petWindow.showInactive();
  petWindow.moveTop();
}

function syncPetWindowVisibility() {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }

  if (uiState.mode === "arming" || uiState.mode === "listening" || uiState.mode === "processing") {
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
    hotkeyRegistered: uiState.hotkeyRegistered,
    hotkeyStatus: uiState.hotkeyStatus,
    hotkeyTriggerCount: uiState.hotkeyTriggerCount,
    isRecording: uiState.isRecording,
    lastHotkeyTriggeredAt: uiState.lastHotkeyTriggeredAt,
    petAnchor: lastPetAnchor,
    petVisible: Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible()),
    petBounds: petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null,
    micStatus: uiState.micStatus,
    mode: uiState.mode,
    provider: uiState.provider,
    status: uiState.status,
    triggerLabel: settings.triggerLabel,
    triggerMode: settings.triggerMode,
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
      surroundingText: "",
      windowBounds: null
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
  applyPetOverlayBehavior();
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

async function toggleDictationFromDashboard() {
  if (uiState.mode === "processing") {
    return false;
  }

  if (uiState.isRecording) {
    sendDictationAction({
      action: "stop",
      source: "dashboard"
    });
    return true;
  }

  return triggerDictationStart({
    holdToTalk: false,
    source: "dashboard"
  });
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

function sendDictationAction(payload) {
  petWindow?.webContents.send("flow:hotkey-toggle", payload);
}

function recordTriggerActivity(statusText) {
  const triggeredAt = new Date().toISOString();
  const nextTriggerCount = (uiState.hotkeyTriggerCount || 0) + 1;

  broadcastUiState({
    hotkeyRegistered: true,
    hotkeyStatus: statusText,
    hotkeyTriggerCount: nextTriggerCount,
    lastHotkeyTriggeredAt: triggeredAt
  });

  return triggeredAt;
}

async function triggerDictationStart({ holdToTalk = false, source = "hotkey" } = {}) {
  if (uiState.mode === "processing") {
    return false;
  }

  broadcastUiState({
    mode: "arming",
    status: holdToTalk
      ? "Getting the microphone ready..."
      : "Waking up Voice Flow...",
    isRecording: false
  });

  lastCapturedContext = await safeGetActiveContext();
  applyPetOverlayBehavior();
  revealPetWindow({
    context: lastCapturedContext,
    nearCursor: true
  });
  sendDictationAction({
    action: "start",
    holdToTalk,
    source
  });
  return true;
}

function triggerDictationStop({ source = "hotkey" } = {}) {
  sendDictationAction({
    action: "stop",
    source
  });
}

async function ensureFnKeyListenerBinary() {
  await fs.mkdir(path.dirname(fnKeyListenerBinaryPath), { recursive: true });

  const sourceExists = fsSync.existsSync(fnKeyListenerSourcePath);

  if (!sourceExists) {
    throw new Error(`Fn key listener source is missing: ${fnKeyListenerSourcePath}`);
  }

  const sourceStat = await fs.stat(fnKeyListenerSourcePath);
  const binaryStat = await fs.stat(fnKeyListenerBinaryPath).catch(() => null);
  const shouldCompile = !binaryStat || sourceStat.mtimeMs > binaryStat.mtimeMs;

  if (!shouldCompile) {
    return;
  }

  await execFileAsync(
    "clang",
    [
      fnKeyListenerSourcePath,
      "-fobjc-arc",
      "-framework",
      "Cocoa",
      "-framework",
      "ApplicationServices",
      "-o",
      fnKeyListenerBinaryPath
    ],
    {
      timeout: 30000
    }
  );
}

function handleFnKeyListenerMessage(rawLine) {
  let payload;

  try {
    payload = JSON.parse(rawLine);
  } catch {
    console.warn(`Voice Flow fn listener emitted invalid JSON: ${rawLine}`);
    return;
  }

  if (payload.event === "status") {
    const trusted = Boolean(payload.accessibilityTrusted);
    const message =
      payload.message ||
      (trusted
        ? "Fn hold listener is active."
        : "Fn hold listener needs Accessibility permission in System Settings > Privacy & Security > Accessibility.");

    broadcastUiState({
      hotkeyRegistered: trusted,
      hotkeyStatus: message
    });
    return;
  }

  if (payload.event !== "fn") {
    return;
  }

  if (payload.phase === "down") {
    if (fnHoldPressed) {
      return;
    }

    fnHoldPressed = true;
    const triggeredAt = recordTriggerActivity("Fn hold listener is active.");
    console.log(`Voice Flow fn trigger down at ${triggeredAt}`);
    void triggerDictationStart({
      holdToTalk: true,
      source: "fn_hold"
    });
    return;
  }

  if (payload.phase === "up") {
    if (!fnHoldPressed) {
      return;
    }

    fnHoldPressed = false;
    console.log("Voice Flow fn trigger released");

    if (uiState.isRecording) {
      triggerDictationStop({
        source: "fn_hold"
      });
    }
  }
}

async function startFnKeyListener() {
  if (!isMac || settings.triggerMode !== "fn_hold" || fnKeyListenerProcess) {
    return;
  }

  try {
    await ensureFnKeyListenerBinary();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fn key listener compilation failed.";

    console.error(`Voice Flow failed to prepare fn hold listener: ${message}`);
    broadcastUiState({
      hotkeyRegistered: false,
      hotkeyStatus: `Fn hold listener setup failed: ${message}`
    });
    return;
  }

  const child = spawn(fnKeyListenerBinaryPath, [], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  fnKeyListenerProcess = child;
  fnKeyListenerReader = readline.createInterface({
    input: child.stdout
  });

  fnKeyListenerReader.on("line", (line) => {
    handleFnKeyListenerMessage(line);
  });

  child.stderr.on("data", (chunk) => {
    console.warn(`Voice Flow fn listener stderr: ${chunk.toString().trim()}`);
  });

  child.on("exit", (code, signal) => {
    fnKeyListenerReader?.close();
    fnKeyListenerReader = null;
    fnKeyListenerProcess = null;
    fnHoldPressed = false;

    if (isQuitting) {
      return;
    }

    const detail = `Fn hold listener exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"}).`;
    console.error(detail);
    broadcastUiState({
      hotkeyRegistered: false,
      hotkeyStatus: detail
    });
  });
}

function stopFnKeyListener() {
  if (!fnKeyListenerProcess) {
    return;
  }

  fnKeyListenerProcess.kill("SIGTERM");
  fnKeyListenerProcess = null;
  fnHoldPressed = false;
}

function registerHotkey() {
  if (settings.triggerMode === "fn_hold" && isMac) {
    return;
  }

  let registered = false;

  try {
    registered = globalShortcut.register(settings.hotkey, () => {
      const triggeredAt = recordTriggerActivity(`Hotkey is active. Last trigger: ${new Date().toISOString()}`);

      console.log(`Voice Flow hotkey triggered (${settings.hotkey}) at ${triggeredAt}`);

      void (async () => {
        if (uiState.mode === "processing") {
          return;
        }

        if (uiState.isRecording) {
          triggerDictationStop({
            source: "hotkey"
          });
          return;
        }

        await triggerDictationStart({
          holdToTalk: false,
          source: "hotkey"
        });
      })();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown hotkey registration error.";

    console.error(`Voice Flow failed to register hotkey ${settings.hotkey}: ${message}`);
    broadcastUiState({
      hotkeyRegistered: false,
      hotkeyStatus: `Hotkey registration failed: ${message}`
    });
    return;
  }

  const isRegistered = registered && globalShortcut.isRegistered(settings.hotkey);

  broadcastUiState({
    hotkeyRegistered: isRegistered,
    hotkeyStatus: isRegistered
      ? `Hotkey is active: ${formatAcceleratorLabel(settings.hotkey)}`
      : `Hotkey could not be registered. macOS may already be using ${formatAcceleratorLabel(settings.hotkey)}.`
  });

  if (isRegistered) {
    console.log(`Voice Flow registered hotkey ${settings.hotkey}`);
    return;
  }

  console.warn(`Voice Flow could not register hotkey ${settings.hotkey}`);
}

app.whenReady().then(() => {
  createPetWindow();
  createDashboardWindow();
  void startFnKeyListener();
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
  applyPetOverlayBehavior();
  revealPetWindow({
    context: lastCapturedContext,
    nearCursor: true
  });
});

app.on("will-quit", () => {
  isQuitting = true;
  stopFnKeyListener();
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
ipcMain.handle("flow:toggle-dictation", async () => {
  return toggleDictationFromDashboard();
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
