import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
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
import electronUpdater from "electron-updater";
import { createDesktopConfigStore } from "./config-store.mjs";
import { getActiveContext } from "./macos-context.mjs";
import { pasteText } from "./paste-text.mjs";
import { installRuntimeGuards } from "../../../packages/shared/src/runtime-guards.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { autoUpdater } = electronUpdater;
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
let fallbackHotkeyActive = false;
let triggerDiagnosticsInterval = null;
let triggerDiagnosticsRefreshInFlight = false;
let lastObservedAccessibilityTrusted = null;
const expectedFnKeyListenerExits = new WeakSet();
const petWindowSize = {
  width: 154,
  height: 64
};
const configuredTriggerMode = normalizeTriggerMode(process.env.FLOW_TRIGGER_MODE ?? (isMac ? "fn_hold" : "hotkey"));
const configuredHoldKey = normalizeHoldKey(process.env.FLOW_HOLD_KEY ?? "control");
const configuredHoldKeyLabel = formatHoldKeyLabel(configuredHoldKey);
const configuredHoldDelayMs = getNumberEnv(
  "FLOW_HOLD_TRIGGER_DELAY_MS",
  configuredHoldKey === "fn" ? 0 : 180,
  0,
  1000
);
const configuredHotkey = process.env.FLOW_HOTKEY ?? "CommandOrControl+Shift+Space";
const configuredHotkeyLabel = formatAcceleratorLabel(configuredHotkey);
const baseSettings = {
  autoPaste: (process.env.FLOW_AUTO_PASTE ?? "true").toLowerCase() === "true",
  autoStopAfterSilenceMs: getNumberEnv("FLOW_AUTO_STOP_SILENCE_MS", 650, 350, 2000),
  autoStopMaxInitialSilenceMs: getNumberEnv("FLOW_AUTO_STOP_MAX_INITIAL_SILENCE_MS", 8000, 3000, 15000),
  holdKey: configuredHoldKey,
  holdTriggerDelayMs: configuredHoldDelayMs,
  hotkey: configuredHotkey,
  minimumAutoStopRecordingMs: getNumberEnv("FLOW_MIN_RECORDING_MS", 700, 250, 2000),
  preferBrowserSpeechRecognition:
    (process.env.FLOW_PREFER_BROWSER_SPEECH_RECOGNITION ?? "false").toLowerCase() === "true",
  transcribeModel: process.env.FLOW_TRANSCRIBE_MODEL ?? "",
  transcribeProvider: process.env.FLOW_TRANSCRIBE_PROVIDER ?? "mock",
  triggerLabel: configuredTriggerMode === "fn_hold" && isMac ? `${configuredHoldKeyLabel} (hold)` : configuredHotkeyLabel,
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
  polishedText: "No converted text yet.",
  provider: "unknown",
  isRecording: false,
  resultStage: "idle",
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

function normalizeTriggerMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (!normalized) {
    return isMac ? "fn_hold" : "hotkey";
  }

  if (normalized === "hold") {
    return "fn_hold";
  }

  return normalized;
}

function normalizeHoldKey(value) {
  const normalized = String(value ?? "control").trim().toLowerCase();

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

  return "control";
}

function formatHoldKeyLabel(value) {
  const normalized = normalizeHoldKey(value);

  if (normalized === "fn") {
    return "Fn";
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getHoldKeyInstructionText() {
  return configuredHoldKey === "fn" ? "fn" : configuredHoldKeyLabel.toLowerCase();
}

function getHoldListenerPrefix() {
  return `${configuredHoldKeyLabel} hold listener`;
}

function getHoldListenerActiveMessage() {
  return `${getHoldListenerPrefix()} is active.`;
}

function getHoldListenerPermissionMessage() {
  return `${getHoldListenerPrefix()} needs Accessibility permission in System Settings > Privacy & Security > Accessibility.`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getPackagedAppBundlePath() {
  if (!app.isPackaged) {
    return "";
  }

  return path.resolve(process.execPath, "..", "..", "..");
}

function getRecommendedApplicationsPath() {
  const bundlePath = getPackagedAppBundlePath();

  if (!bundlePath) {
    return "";
  }

  return path.join("/Applications", path.basename(bundlePath));
}

function getEffectiveTriggerMode() {
  if (baseSettings.triggerMode === "fn_hold" && isMac && fallbackHotkeyActive) {
    return "hotkey";
  }

  return baseSettings.triggerMode;
}

function getEffectiveTriggerLabel() {
  return getEffectiveTriggerMode() === "hotkey" ? configuredHotkeyLabel : baseSettings.triggerLabel;
}

function roundTimingMs(value) {
  return Number(value.toFixed(1));
}

function getAccessibilityTrusted() {
  if (!isMac || baseSettings.triggerMode !== "fn_hold") {
    return null;
  }

  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return null;
  }
}

function getTriggerDiagnostics() {
  const accessibilityTrusted = getAccessibilityTrusted();
  const packagedBundlePath = getPackagedAppBundlePath();
  const inApplicationsFolder = Boolean(isMac && app.isPackaged && app.isInApplicationsFolder());
  const recommendedApplicationsPath = getRecommendedApplicationsPath();
  const helperBinaryPath = getFnKeyListenerBinaryPath();

  return {
    accessibilityTrusted,
    appBundlePath: packagedBundlePath,
    canMoveToApplications: Boolean(isMac && app.isPackaged && !inApplicationsFolder),
    effectiveTriggerLabel: getEffectiveTriggerLabel(),
    effectiveTriggerMode: getEffectiveTriggerMode(),
    fnListenerRunning: Boolean(fnKeyListenerProcess),
    holdKey: configuredHoldKey,
    holdKeyLabel: configuredHoldKeyLabel,
    helperBinaryExists: existsSync(helperBinaryPath),
    helperBinaryPath,
    inApplicationsFolder,
    packagedBundlePath,
    recommendedApplicationsPath,
    stableInstallRecommended: Boolean(isMac && app.isPackaged && !inApplicationsFolder),
    usingFallbackHotkey: fallbackHotkeyActive
  };
}

function createTraceId() {
  return `vf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeClientTimings(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entries = Object.entries(value).filter(([, entryValue]) => Number.isFinite(entryValue));

  if (entries.length === 0) {
    return null;
  }

  return Object.fromEntries(entries.map(([key, entryValue]) => [key, roundTimingMs(entryValue)]));
}

function logTiming(event, payload) {
  console.info(`Voice Flow timing ${JSON.stringify({
    event,
    scope: "desktop-main",
    ...payload
  })}`);
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
    triggerDiagnostics: getTriggerDiagnostics(),
    triggerFallbackActive: fallbackHotkeyActive,
    triggerLabel: getEffectiveTriggerLabel(),
    triggerMode: getEffectiveTriggerMode(),
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
    if (fallbackHotkeyActive) {
      return `Press ${configuredHotkeyLabel} to dictate.`;
    }

    return `Hold ${getHoldKeyInstructionText()} to dictate.`;
  }

  return `Press ${configuredHotkeyLabel} to dictate.`;
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
    triggerFallbackActive: fallbackHotkeyActive,
    triggerLabel: getEffectiveTriggerLabel(),
    triggerMode: getEffectiveTriggerMode(),
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
  let response;

  try {
    response = await fetch(`${apiBaseUrl}/v1/dictate`, {
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Unknown network error.";
    throw new Error(`Could not reach the Voice Flow API at ${apiBaseUrl}. Make sure the backend is running and the API Base URL is correct. (${message})`);
  }

  if (!response.ok) {
    throw new Error(await extractApiErrorMessage(response));
  }

  const json = await response.json();
  return json.result;
}

async function extractApiErrorMessage(response) {
  const errorText = await response.text();
  let message = errorText;

  try {
    message = JSON.parse(errorText).error || errorText;
  } catch {
    // The API normally returns JSON errors, but keep plain text readable too.
  }

  return message || `Dictation API error: ${response.status}`;
}

function parseSseEventBlock(block) {
  const trimmed = block.trim();

  if (!trimmed) {
    return null;
  }

  const dataLines = [];

  for (const line of trimmed.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join("\n");

  if (rawData === "[DONE]") {
    return null;
  }

  return JSON.parse(rawData);
}

async function consumeSseStream(stream, onEvent) {
  if (!stream) {
    throw new Error("Streaming response body was empty.");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), {
      stream: !done
    });
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let separatorIndex = buffer.indexOf("\n\n");

    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const payload = parseSseEventBlock(block);

      if (payload) {
        await onEvent(payload);
      }

      separatorIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }

  const trailing = parseSseEventBlock(buffer);

  if (trailing) {
    await onEvent(trailing);
  }
}

async function callDictationApiStream(payload, { onEvent } = {}) {
  const { apiBaseUrl, apiToken } = desktopConfigStore.getApiCredentials();
  let response;

  try {
    response = await fetch(`${apiBaseUrl}/v1/dictate/stream`, {
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Unknown network error.";
    throw new Error(`Could not reach the Voice Flow API at ${apiBaseUrl}. Make sure the backend is running and the API Base URL is correct. (${message})`);
  }

  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      return callDictationApi(payload);
    }

    throw new Error(await extractApiErrorMessage(response));
  }

  let finalResult = null;
  let streamedError = "";

  await consumeSseStream(response.body, async (event) => {
    await onEvent?.(event);

    if (event.type === "dictation.completed" && event.result) {
      finalResult = event.result;
      return;
    }

    if (event.type === "dictation.error") {
      streamedError = event.error || "Voice Flow streaming request failed.";
    }
  });

  if (streamedError) {
    throw new Error(streamedError);
  }

  if (!finalResult) {
    throw new Error("Voice Flow API stream ended before returning a final result.");
  }

  return finalResult;
}

function sendDictationAction(payload) {
  petWindow?.webContents.send("flow:hotkey-toggle", payload);
}

async function handleConfiguredHotkeyTrigger() {
  if (uiState.mode === "processing") {
    return;
  }

  if (uiState.isRecording) {
    triggerDictationStop({
      source: fallbackHotkeyActive ? "hotkey-fallback" : "hotkey"
    });
    return;
  }

  await triggerDictationStart({
    holdToTalk: false,
    source: fallbackHotkeyActive ? "hotkey-fallback" : "hotkey"
  });
}

function ensureConfiguredHotkeyRegistered() {
  if (globalShortcut.isRegistered(baseSettings.hotkey)) {
    return true;
  }

  return globalShortcut.register(baseSettings.hotkey, () => {
    const triggeredAt = recordTriggerActivity(
      fallbackHotkeyActive
        ? `Fallback hotkey is active. Last trigger: ${new Date().toISOString()}`
        : `Hotkey is active. Last trigger: ${new Date().toISOString()}`
    );

    console.log(
      `Voice Flow ${fallbackHotkeyActive ? "fallback hotkey" : "hotkey"} triggered (${baseSettings.hotkey}) at ${triggeredAt}`
    );

    void handleConfiguredHotkeyTrigger();
  });
}

function unregisterConfiguredHotkey() {
  if (!globalShortcut.isRegistered(baseSettings.hotkey)) {
    return;
  }

  globalShortcut.unregister(baseSettings.hotkey);
}

function syncTriggerStatus(statusMessage, registered, { idleStatusOverride = "" } = {}) {
  const patch = {
    hotkeyRegistered: registered,
    hotkeyStatus: statusMessage
  };

  if (uiState.mode === "idle") {
    patch.status = idleStatusOverride || getIdleStatusText();
  }

  broadcastUiState(patch);
  broadcastSettings();
}

function activateHotkeyFallback(reasonMessage) {
  let registered = false;

  try {
    registered = ensureConfiguredHotkeyRegistered() && globalShortcut.isRegistered(baseSettings.hotkey);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown hotkey registration error.";
    fallbackHotkeyActive = false;
    syncTriggerStatus(`${reasonMessage} Fallback hotkey registration failed: ${message}`, false);
    return;
  }

  fallbackHotkeyActive = registered;

  syncTriggerStatus(
    registered
      ? `${reasonMessage} Fallback hotkey active: ${configuredHotkeyLabel}.`
      : `${reasonMessage} Fallback hotkey could not be registered. macOS may already be using ${configuredHotkeyLabel}.`,
    registered,
    {
      idleStatusOverride: registered ? "" : reasonMessage
    }
  );
}

function deactivateHotkeyFallback(statusMessage) {
  if (fallbackHotkeyActive) {
    unregisterConfiguredHotkey();
  }

  fallbackHotkeyActive = false;
  syncTriggerStatus(statusMessage, true);
}

function requestAccessibilityPrompt() {
  if (!isMac || baseSettings.triggerMode !== "fn_hold") {
    return false;
  }

  try {
    return systemPreferences.isTrustedAccessibilityClient(true);
  } catch {
    return false;
  }
}

async function restartFnKeyListener() {
  stopFnKeyListener();
  await startFnKeyListener();
}

async function refreshTriggerDiagnostics({ restartListener = false } = {}) {
  if (triggerDiagnosticsRefreshInFlight) {
    return getSettingsSnapshot();
  }

  triggerDiagnosticsRefreshInFlight = true;

  try {
    const accessibilityTrusted = getAccessibilityTrusted();
    lastObservedAccessibilityTrusted = accessibilityTrusted;

    if (baseSettings.triggerMode === "fn_hold" && isMac) {
      if (restartListener || (accessibilityTrusted && fallbackHotkeyActive)) {
        await restartFnKeyListener();
      } else if (accessibilityTrusted && !fnKeyListenerProcess) {
        await startFnKeyListener();
      } else if (accessibilityTrusted === false && !fallbackHotkeyActive) {
        activateHotkeyFallback(getHoldListenerPermissionMessage());
      }
    }

    broadcastSettings();
    return getSettingsSnapshot();
  } finally {
    triggerDiagnosticsRefreshInFlight = false;
  }
}

function startTriggerDiagnosticsMonitor() {
  if (!isMac || baseSettings.triggerMode !== "fn_hold" || triggerDiagnosticsInterval) {
    return;
  }

  triggerDiagnosticsInterval = setInterval(() => {
    const accessibilityTrusted = getAccessibilityTrusted();

    if (accessibilityTrusted === lastObservedAccessibilityTrusted) {
      return;
    }

    lastObservedAccessibilityTrusted = accessibilityTrusted;

    if (accessibilityTrusted) {
      void refreshTriggerDiagnostics({
        restartListener: true
      });
      return;
    }

    if (!fallbackHotkeyActive) {
      activateHotkeyFallback(getHoldListenerPermissionMessage());
    }
  }, 2500);
}

function stopTriggerDiagnosticsMonitor() {
  if (!triggerDiagnosticsInterval) {
    return;
  }

  clearInterval(triggerDiagnosticsInterval);
  triggerDiagnosticsInterval = null;
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
    throw new Error("Hold-key helper is missing. Run npm run build:fn-listener or rebuild the packaged app.");
  }
}

function handleFnKeyListenerMessage(rawLine) {
  let payload;

  try {
    payload = JSON.parse(rawLine);
  } catch {
    console.warn(`Voice Flow hold listener emitted invalid JSON: ${rawLine}`);
    return;
  }

  if (payload.event === "status") {
    const trusted = Boolean(payload.accessibilityTrusted);
    const message =
      payload.message ||
      (trusted
        ? getHoldListenerActiveMessage()
        : getHoldListenerPermissionMessage());

    if (trusted) {
      deactivateHotkeyFallback(message);
      return;
    }

    activateHotkeyFallback(message);
    return;
  }

  if (payload.event !== "hold" && payload.event !== "fn") {
    return;
  }

  if (payload.phase === "down") {
    if (fnHoldPressed) {
      return;
    }

    fnHoldPressed = true;
    const triggeredAt = recordTriggerActivity(payload.message || getHoldListenerActiveMessage());
    console.log(`Voice Flow ${configuredHoldKey} trigger down at ${triggeredAt}`);
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
    console.log(`Voice Flow ${configuredHoldKey} trigger released`);

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
    const message = error instanceof Error ? error.message : `${getHoldListenerPrefix()} setup failed.`;

    console.error(`Voice Flow failed to prepare ${getHoldListenerPrefix()}: ${message}`);
    activateHotkeyFallback(`${getHoldListenerPrefix()} setup failed: ${message}`);
    return;
  }

  const helperArgs = ["--hold-key", configuredHoldKey, "--hold-delay-ms", String(configuredHoldDelayMs)];
  const child = spawn(binaryPath, helperArgs, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  fnKeyListenerProcess = child;
  const reader = readline.createInterface({
    input: child.stdout
  });
  fnKeyListenerReader = reader;

  reader.on("line", (line) => {
    handleFnKeyListenerMessage(line);
  });

  child.stderr.on("data", (chunk) => {
    console.warn(`Voice Flow hold listener stderr: ${chunk.toString().trim()}`);
  });

  child.on("exit", (code, signal) => {
    const expectedExit = expectedFnKeyListenerExits.has(child);
    expectedFnKeyListenerExits.delete(child);
    reader.close();

    if (fnKeyListenerReader === reader) {
      fnKeyListenerReader = null;
    }

    if (fnKeyListenerProcess === child) {
      fnKeyListenerProcess = null;
      fnHoldPressed = false;
    }

    if (isQuitting || expectedExit) {
      return;
    }

    if (fnKeyListenerProcess && fnKeyListenerProcess !== child) {
      return;
    }

    const detail = `${getHoldListenerPrefix()} exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"}).`;
    console.error(detail);
    activateHotkeyFallback(detail);
  });
}

function stopFnKeyListener() {
  if (!fnKeyListenerProcess) {
    return;
  }

  expectedFnKeyListenerExits.add(fnKeyListenerProcess);
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
    registered = ensureConfiguredHotkeyRegistered();
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
  fallbackHotkeyActive = false;

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
  startTriggerDiagnosticsMonitor();
  registerHotkey();
  refreshIdleUiState();
  initializeAutoUpdates();

  if (!desktopConfigStore.isConfigured()) {
    showDashboard();
  }

  app.on("activate", () => {
    void startFnKeyListener();
    startTriggerDiagnosticsMonitor();

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
  stopTriggerDiagnosticsMonitor();
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  isQuitting = true;
  clearPetHideTimer();
  stopFnKeyListener();
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
ipcMain.handle("flow:refresh-trigger-diagnostics", async (_event, payload = {}) => {
  return refreshTriggerDiagnostics({
    restartListener: Boolean(payload.restartListener)
  });
});
ipcMain.handle("flow:open-accessibility-settings", async () => {
  if (!isMac) {
    return false;
  }

  requestAccessibilityPrompt();

  try {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    return true;
  } catch {
    const errorMessage = await shell.openPath("/System/Applications/System Settings.app");
    return errorMessage === "";
  }
});
ipcMain.handle("flow:move-to-applications", async () => {
  if (!isMac || !app.isPackaged || app.isInApplicationsFolder()) {
    return false;
  }

  const accepted = await dialog.showMessageBox({
    buttons: ["Move to Applications", "Cancel"],
    cancelId: 1,
    defaultId: 0,
    detail:
      "Installing Voice Flow in Applications makes macOS Accessibility permission far more stable, especially after app rebuilds and relaunches.",
    message: "Move Voice Flow to Applications?",
    type: "question"
  });

  if (accepted.response !== 0) {
    return false;
  }

  const moved = app.moveToApplicationsFolder({
    conflictHandler: () => true
  });

  return moved;
});
ipcMain.handle("flow:process-dictation", async (_event, payload) => {
  const startedAt = performance.now();
  const traceId = typeof payload?.traceId === "string" && payload.traceId.trim() ? payload.traceId.trim() : createTraceId();
  const clientTimings = normalizeClientTimings(payload?.clientTimings);
  const streamState = {
    polishedText: "",
    provider: "unknown",
    rawTranscript: ""
  };
  const requestPayload = {
    ...payload,
    traceId
  };
  const pasteState = {
    clipboardRestoreDeferredMs: 0,
    ms: 0,
    stage: "none",
    text: ""
  };

  delete requestPayload.clientTimings;

  async function pasteIfNeeded(text, stage) {
    if (!baseSettings.autoPaste || !text || pasteState.stage !== "none") {
      return false;
    }

    const pasteStartedAt = performance.now();
    const pasteResult = await pasteText(text);
    pasteState.clipboardRestoreDeferredMs = pasteResult?.clipboardRestoreDeferredMs ?? 0;
    pasteState.ms = performance.now() - pasteStartedAt;
    pasteState.stage = stage;
    pasteState.text = text;
    return true;
  }

  try {
    const apiStartedAt = performance.now();
    const result = await callDictationApiStream(requestPayload, {
      onEvent: async (event) => {
        if (!event || typeof event !== "object") {
          return;
        }

        if (typeof event.provider === "string" && event.provider.trim()) {
          streamState.provider = event.provider;
        }

        if (typeof event.rawTranscript === "string" && event.rawTranscript.trim()) {
          streamState.rawTranscript = event.rawTranscript;
        }

        if (typeof event.polishedText === "string" && event.polishedText.trim()) {
          streamState.polishedText = event.polishedText;
        }

        if (event.type === "dictation.started") {
          broadcastUiState({
            isRecording: false,
            mode: "processing",
            provider: streamState.provider,
            resultStage: "working",
            status: "Uploading your audio..."
          });
          return;
        }

        if (event.type === "transcribe.started") {
          broadcastUiState({
            isRecording: false,
            mode: "processing",
            provider: streamState.provider,
            resultStage: "working",
            status: "Transcribing your speech..."
          });
          return;
        }

        if (event.type === "transcribe.completed") {
          const rawTranscript = streamState.rawTranscript || "";
          let rawPasted = false;

          if (rawTranscript) {
            try {
              rawPasted = await pasteIfNeeded(rawTranscript, "raw");
            } catch {
              rawPasted = false;
            }
          }

          broadcastUiState({
            isRecording: false,
            mode: "processing",
            polishedText: "",
            provider: streamState.provider,
            rawTranscript: rawTranscript || uiState.rawTranscript,
            resultStage: rawTranscript ? "raw" : "working",
            status: rawPasted
              ? "Raw transcript pasted. Polishing in the background..."
              : "Transcript ready. Refining your words..."
          });
          return;
        }

        if (event.type === "polish.started") {
          broadcastUiState({
            isRecording: false,
            mode: "processing",
            polishedText: streamState.polishedText || streamState.rawTranscript || uiState.polishedText,
            provider: streamState.provider,
            rawTranscript: streamState.rawTranscript || uiState.rawTranscript,
            resultStage: streamState.polishedText ? "polishing" : streamState.rawTranscript ? "raw" : "working",
            status: pasteState.stage === "raw"
              ? "Raw transcript pasted. Polishing in the background..."
              : "Polishing your words..."
          });
          return;
        }

        if (event.type === "polish.delta" || event.type === "polish.completed" || event.type === "polish.disabled") {
          const nextPolishedText = streamState.polishedText || streamState.rawTranscript || uiState.polishedText;

          broadcastUiState({
            isRecording: false,
            mode: "processing",
            polishedText: nextPolishedText,
            provider: streamState.provider,
            rawTranscript: streamState.rawTranscript || uiState.rawTranscript,
            resultStage:
              event.type === "polish.completed" || event.type === "polish.disabled"
                ? "polished"
                : streamState.polishedText
                  ? "polishing"
                  : "raw",
            status:
              event.type === "polish.completed" || event.type === "polish.disabled"
                ? pasteState.stage === "raw"
                  ? "Polished result ready in Voice Flow."
                  : "Finishing up..."
                : pasteState.stage === "raw"
                  ? "Raw transcript pasted. Polishing in the background..."
                  : "Polishing your words..."
          });
        }
      }
    });
    const apiMs = performance.now() - apiStartedAt;
    const textToPaste = result.polishedText || result.rawTranscript || "";
    let pasteError = "";

    if (baseSettings.autoPaste && textToPaste && pasteState.stage === "none") {
      try {
        await pasteIfNeeded(textToPaste, "final");
      } catch (error) {
        pasteError = error instanceof Error ? error.message : "Paste automation failed.";
      }
    }

    const polishedDiffersFromRaw =
      Boolean(result.rawTranscript) &&
      Boolean(textToPaste) &&
      textToPaste.trim() !== result.rawTranscript.trim();
    const finalStatus = pasteError
      ? pasteError
      : pasteState.stage === "raw"
        ? polishedDiffersFromRaw
          ? "Raw transcript pasted. Polished result is ready in Voice Flow."
          : "Raw transcript pasted into your app."
        : baseSettings.autoPaste
          ? "Pasted back into your app."
          : `Transcribed with ${result.provider}.`;

    logTiming("dictation.completed", {
      apiMs: roundTimingMs(apiMs),
      autoPaste: baseSettings.autoPaste,
      clientTimings,
      clipboardRestoreDeferredMs: pasteState.clipboardRestoreDeferredMs,
      pasteError,
      pasteMs: roundTimingMs(pasteState.ms),
      pasteStage: pasteState.stage,
      provider: result.provider,
      totalMs: roundTimingMs(performance.now() - startedAt),
      traceId
    });

    broadcastUiState({
      isRecording: false,
      micStatus: getMicrophoneAccessStatus().message,
      mode: pasteError ? "error" : "done",
      polishedText: textToPaste,
      provider: result.provider,
      resultStage: polishedDiffersFromRaw ? "polished" : result.rawTranscript ? "raw" : "idle",
      rawTranscript: result.rawTranscript,
      status: finalStatus
    });

    return {
      ...result,
      pasteError,
      traceId
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dictation failed.";

    logTiming("dictation.failed", {
      clientTimings,
      error: message,
      totalMs: roundTimingMs(performance.now() - startedAt),
      traceId
    });

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
