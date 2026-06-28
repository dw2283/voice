import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  shell,
  systemPreferences
} from "electron";
import { autoUpdater } from "electron-updater";
import { createDesktopConfigStore } from "./config-store.mjs";
import { getActiveContext } from "./macos-context.mjs";
import { pasteText } from "./paste-text.mjs";
import { installRuntimeGuards } from "../../../packages/shared/src/runtime-guards.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardHtmlPath = path.join(__dirname, "renderer", "index.html");
const petHtmlPath = path.join(__dirname, "renderer", "pet.html");
const userDataPath = app.getPath("userData");
const runtimeLogFilePath = path.join(userDataPath, "logs", "desktop-main.log");
const runtimeStateFilePath = path.join(userDataPath, "desktop-runtime-state.json");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const isMac = process.platform === "darwin";

app.setName("Voice Flow");

installRuntimeGuards({
  logFilePath: runtimeLogFilePath
});

if (!hasSingleInstanceLock) {
  app.exit(0);
}

function getFnKeyListenerBinaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bin", "voice-flow-fn-listener");
  }

  return path.resolve(__dirname, "../build/bin/voice-flow-fn-listener");
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
const petWindowSize = {
  width: 154,
  height: 64
};
const configuredTriggerMode = String(process.env.FLOW_TRIGGER_MODE ?? (isMac ? "fn_hold" : "hotkey"))
  .trim()
  .toLowerCase();
const configuredHotkey = process.env.FLOW_HOTKEY ?? "CommandOrControl+Shift+Space";
const baseSettings = {
  autoPaste: (process.env.FLOW_AUTO_PASTE ?? "true").toLowerCase() === "true",
  autoStopAfterSilenceMs: getNumberEnv("FLOW_AUTO_STOP_SILENCE_MS", 650, 350, 2000),
  autoStopMaxInitialSilenceMs: getNumberEnv("FLOW_AUTO_STOP_MAX_INITIAL_SILENCE_MS", 8000, 3000, 15000),
  hotkey: configuredHotkey,
  minimumAutoStopRecordingMs: getNumberEnv("FLOW_MIN_RECORDING_MS", 700, 250, 2000),
  preferBrowserSpeechRecognition:
    (process.env.FLOW_PREFER_BROWSER_SPEECH_RECOGNITION ?? "false").toLowerCase() === "true",
  transcribeModel: process.env.FLOW_TRANSCRIBE_MODEL ?? "",
  transcribeProvider: process.env.FLOW_TRANSCRIBE_PROVIDER ?? "mock",
  triggerLabel: configuredTriggerMode === "fn_hold" && isMac ? "Fn (hold)" : formatAcceleratorLabel(configuredHotkey),
  triggerMode: configuredTriggerMode
};
const desktopConfigStore = createDesktopConfigStore({
  app,
  safeStorage
});
const updateState = {
  message: app.isPackaged ? "Voice Flow will check for beta updates after launch." : "Auto-update is only active in packaged beta builds.",
  progress: 0,
  status: app.isPackaged ? "idle" : "disabled",
  version: ""
};
const uiState = {
  mode: "idle",
  status: "Loading Voice Flow...",
  micStatus: "Microphone status is loading...",
  hotkeyRegistered: false,
  hotkeyStatus: `${baseSettings.triggerLabel} is getting ready.`,
  hotkeyTriggerCount: 0,
  lastHotkeyTriggeredAt: "",
  rawTranscript: "No transcript yet.",
  polishedText: "No polished output yet.",
  provider: "unknown",
  isRecording: false,
  dashboardVisible: false,
  updatedAt: Date.now()
};

function formatAcceleratorLabel(value) {
  return value
    .replaceAll("CommandOrControl", isMac ? "Command" : "Control")
    .replaceAll("Meta", isMac ? "Command" : "Meta")
    .replaceAll("Alt", isMac ? "Option" : "Alt")
    .replaceAll("+", " + ");
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

function getSettingsSnapshot() {
  return {
    ...baseSettings,
    ...desktopConfigStore.getSnapshot(),
    canCheckForUpdates: app.isPackaged,
    isPackaged: app.isPackaged,
    updateMessage: updateState.message,
    updateProgress: updateState.progress,
    updateStatus: updateState.status,
    updateVersion: updateState.version
  };
}

function broadcastSettings() {
  const snapshot = getSettingsSnapshot();

  for (const window of [petWindow, dashboardWindow]) {
    if (!window || window.isDestroyed()) {
      continue;
    }

    window.webContents.send("flow:settings", snapshot);
  }
}

function setUpdateState(patch) {
  Object.assign(updateState, patch);
  broadcastSettings();
}

function getIdleStatusText() {
  if (!desktopConfigStore.isConfigured()) {
    return "Open the dashboard and connect your API before dictating.";
  }

  if (baseSettings.triggerMode === "fn_hold" && isMac) {
    return "Hold fn to dictate.";
  }

  return "Press the hotkey to dictate.";
}

function toMicrophoneState(rawStatus) {
  if (rawStatus === "granted") {
    return {
      message: "Microphone access granted.",
      status: "granted"
    };
  }

  if (rawStatus === "denied" || rawStatus === "restricted") {
    return {
      message: "Microphone access is denied. Enable it in System Settings > Privacy & Security > Microphone.",
      status: "denied"
    };
  }

  return {
    message: "Microphone access has not been granted yet.",
    status: "pending"
  };
}

function getMicrophoneAccessStatus() {
  if (!isMac) {
    return {
      message: "Desktop microphone status is only implemented for macOS right now.",
      rawStatus: "unsupported",
      status: "unknown"
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
        isRecording: false,
        mode: "idle",
        status: getIdleStatusText()
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
    height,
    width,
    x: nextX,
    y: nextY
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
    height,
    width,
    x: nextX,
    y: nextY
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

function buildRuntimeStateSnapshot() {
  return {
    apiConfigured: desktopConfigStore.isConfigured(),
    autoPaste: baseSettings.autoPaste,
    capturedAppName: lastCapturedContext?.appName ?? "",
    dashboardVisible: uiState.dashboardVisible,
    hotkey: baseSettings.hotkey,
    hotkeyRegistered: uiState.hotkeyRegistered,
    hotkeyStatus: uiState.hotkeyStatus,
    hotkeyTriggerCount: uiState.hotkeyTriggerCount,
    isRecording: uiState.isRecording,
    lastHotkeyTriggeredAt: uiState.lastHotkeyTriggeredAt,
    micStatus: uiState.micStatus,
    mode: uiState.mode,
    petAnchor: lastPetAnchor,
    petBounds: petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null,
    petVisible: Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible()),
    provider: uiState.provider,
    status: uiState.status,
    triggerLabel: baseSettings.triggerLabel,
    triggerMode: baseSettings.triggerMode,
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
    acceptFirstMouse: true,
    alwaysOnTop: true,
    focusable: false,
    frame: false,
    fullscreenable: false,
    hasShadow: true,
    height: petWindowSize.height,
    maxHeight: petWindowSize.height,
    maxWidth: petWindowSize.width,
    minHeight: petWindowSize.height,
    minWidth: petWindowSize.width,
    resizable: false,
    show: false,
    skipTaskbar: true,
    title: "Voice Flow",
    transparent: true,
    vibrancy: "hud",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: false
    },
    width: petWindowSize.width
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
    backgroundColor: "#f6f3ec",
    height: 760,
    minHeight: 640,
    minWidth: 460,
    show: false,
    title: "Voice Flow Dashboard",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: false
    },
    width: 520
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
  broadcastSettings();
}

function hideDashboard() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    return;
  }

  dashboardWindow.hide();
  broadcastUiState({ dashboardVisible: false });
}

async function ensureApiConfigured() {
  if (desktopConfigStore.isConfigured()) {
    return true;
  }

  showDashboard();
  broadcastUiState({
    isRecording: false,
    mode: "error",
    status: "Connect your API in the dashboard before dictating."
  });
  return false;
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
  const { apiBaseUrl, apiToken } = desktopConfigStore.getApiCredentials();
  const response = await fetch(`${apiBaseUrl}/v1/dictate`, {
    body: JSON.stringify(payload),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
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

  if (!(await ensureApiConfigured())) {
    return false;
  }

  broadcastUiState({
    isRecording: false,
    mode: "arming",
    status: holdToTalk ? "Getting the microphone ready..." : "Waking up Voice Flow..."
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
  try {
    await fs.access(getFnKeyListenerBinaryPath());
    return getFnKeyListenerBinaryPath();
  } catch {
    throw new Error("Fn hold helper is missing. Run npm run build:fn-listener or rebuild the packaged app.");
  }
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
  if (!isMac || baseSettings.triggerMode !== "fn_hold" || fnKeyListenerProcess) {
    return;
  }

  let binaryPath = "";

  try {
    binaryPath = await ensureFnKeyListenerBinary();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fn hold listener setup failed.";

    console.error(`Voice Flow failed to prepare fn hold listener: ${message}`);
    broadcastUiState({
      hotkeyRegistered: false,
      hotkeyStatus: `Fn hold listener setup failed: ${message}`
    });
    return;
  }

  const child = spawn(binaryPath, [], {
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
  if (baseSettings.triggerMode === "fn_hold" && isMac) {
    return;
  }

  let registered = false;

  try {
    registered = globalShortcut.register(baseSettings.hotkey, () => {
      const triggeredAt = recordTriggerActivity(`Hotkey is active. Last trigger: ${new Date().toISOString()}`);

      console.log(`Voice Flow hotkey triggered (${baseSettings.hotkey}) at ${triggeredAt}`);

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

    console.error(`Voice Flow failed to register hotkey ${baseSettings.hotkey}: ${message}`);
    broadcastUiState({
      hotkeyRegistered: false,
      hotkeyStatus: `Hotkey registration failed: ${message}`
    });
    return;
  }

  const isRegistered = registered && globalShortcut.isRegistered(baseSettings.hotkey);

  broadcastUiState({
    hotkeyRegistered: isRegistered,
    hotkeyStatus: isRegistered
      ? `Hotkey is active: ${formatAcceleratorLabel(baseSettings.hotkey)}`
      : `Hotkey could not be registered. macOS may already be using ${formatAcceleratorLabel(baseSettings.hotkey)}.`
  });

  if (isRegistered) {
    console.log(`Voice Flow registered hotkey ${baseSettings.hotkey}`);
    return;
  }

  console.warn(`Voice Flow could not register hotkey ${baseSettings.hotkey}`);
}

function initializeAutoUpdates() {
  if (!app.isPackaged) {
    setUpdateState({
      message: "Auto-update is only active in packaged beta builds.",
      progress: 0,
      status: "disabled",
      version: ""
    });
    return;
  }

  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({
      message: "Checking for beta updates...",
      progress: 0,
      status: "checking"
    });
  });

  autoUpdater.on("update-available", (info) => {
    setUpdateState({
      message: `Downloading beta update ${info.version}...`,
      progress: 0,
      status: "available",
      version: info.version ?? ""
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setUpdateState({
      message: `Downloading beta update... ${Math.round(progress.percent)}%`,
      progress: Math.round(progress.percent),
      status: "downloading"
    });
  });

  autoUpdater.on("update-not-available", () => {
    setUpdateState({
      message: "You're already on the latest beta build.",
      progress: 0,
      status: "idle",
      version: ""
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    setUpdateState({
      message: `Beta update ${info.version} is ready to install.`,
      progress: 100,
      status: "downloaded",
      version: info.version ?? ""
    });

    const result = await dialog.showMessageBox({
      buttons: ["Restart to Install", "Later"],
      cancelId: 1,
      defaultId: 0,
      detail: `Voice Flow ${info.version} has finished downloading. Restart whenever you're ready to install it.`,
      message: "A new Voice Flow beta is ready.",
      type: "info"
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (error) => {
    const message = error instanceof Error ? error.message : "Unknown update error.";
    setUpdateState({
      message: `Update check failed: ${message}`,
      progress: 0,
      status: "error"
    });
  });

  setTimeout(() => {
    void checkForUpdates();
  }, 3500);
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    setUpdateState({
      message: "Auto-update is only active in packaged beta builds.",
      progress: 0,
      status: "disabled",
      version: ""
    });
    return getSettingsSnapshot();
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown update error.";
    setUpdateState({
      message: `Update check failed: ${message}`,
      progress: 0,
      status: "error"
    });
  }

  return getSettingsSnapshot();
}

function installDownloadedUpdate() {
  if (updateState.status !== "downloaded") {
    throw new Error("No downloaded update is ready to install yet.");
  }

  autoUpdater.quitAndInstall();
}

function refreshIdleUiState(message = "") {
  broadcastUiState({
    isRecording: false,
    micStatus: getMicrophoneAccessStatus().message,
    mode: "idle",
    status: message || getIdleStatusText()
  });
}

app.whenReady().then(async () => {
  await desktopConfigStore.load();
  createPetWindow();
  createDashboardWindow();
  broadcastSettings();
  void startFnKeyListener();
  registerHotkey();
  refreshIdleUiState();
  initializeAutoUpdates();

  if (!desktopConfigStore.isConfigured()) {
    showDashboard();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPetWindow();
      createDashboardWindow();
      broadcastSettings();
      refreshIdleUiState();
      return;
    }

    showDashboard();
  });
});

app.on("second-instance", () => {
  if (!desktopConfigStore.isConfigured()) {
    showDashboard();
    return;
  }

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

ipcMain.handle("flow:get-settings", async () => getSettingsSnapshot());
ipcMain.handle("flow:save-api-config", async (_event, payload) => {
  const snapshot = await desktopConfigStore.save(payload);
  broadcastSettings();
  refreshIdleUiState("API connected. Voice Flow is ready.");
  return snapshot;
});
ipcMain.handle("flow:reset-api-config", async () => {
  const snapshot = await desktopConfigStore.reset();
  broadcastSettings();
  showDashboard();
  refreshIdleUiState();
  return snapshot;
});
ipcMain.handle("flow:check-for-updates", async () => checkForUpdates());
ipcMain.handle("flow:install-update", async () => {
  installDownloadedUpdate();
  return true;
});
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
ipcMain.handle("flow:toggle-dictation", async () => toggleDictationFromDashboard());
ipcMain.handle("flow:open-external-url", async (_event, url) => {
  await shell.openExternal(url);
  return true;
});
ipcMain.handle("flow:process-dictation", async (_event, payload) => {
  try {
    const result = await callDictationApi(payload);
    const textToPaste = result.polishedText || result.rawTranscript || "";
    let pasteError = "";

    if (baseSettings.autoPaste && textToPaste) {
      try {
        await pasteText(textToPaste);
      } catch (error) {
        pasteError = error instanceof Error ? error.message : "Paste automation failed.";
      }
    }

    broadcastUiState({
      isRecording: false,
      micStatus: getMicrophoneAccessStatus().message,
      mode: pasteError ? "error" : "done",
      polishedText: textToPaste,
      provider: result.provider,
      rawTranscript: result.rawTranscript,
      status: pasteError || (baseSettings.autoPaste ? "Pasted back into your app." : `Transcribed with ${result.provider}.`)
    });

    return {
      ...result,
      pasteError
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dictation failed.";

    broadcastUiState({
      isRecording: false,
      micStatus: getMicrophoneAccessStatus().message,
      mode: "error",
      status: message
    });

    return {
      error: message,
      ok: false
    };
  } finally {
    lastCapturedContext = null;
  }
});
