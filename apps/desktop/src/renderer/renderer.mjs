const flowApi = window.flow;
const apiBaseUrlInput = document.getElementById("apiBaseUrlInput");
const apiConfigForm = document.getElementById("apiConfigForm");
const apiTokenInput = document.getElementById("apiTokenInput");
const appPathValueEl = document.getElementById("appPathValue");
const appPathHintEl = document.getElementById("appPathHint");
const accessibilityActionButton = document.getElementById("accessibilityActionButton");
const accessibilityValueEl = document.getElementById("accessibilityValue");
const connectionStatusEl = document.getElementById("connectionStatus");
const dashboardShellEl = document.getElementById("dashboardShell");
const fnListenerValueEl = document.getElementById("fnListenerValue");
const hideButton = document.getElementById("hideButton");
const hotkeyValueEl = document.getElementById("hotkeyValue");
const holdHintKeyEl = document.getElementById("holdHintKey");
const micValueEl = document.getElementById("micValue");
const modeValueEl = document.getElementById("modeValue");
const moveToApplicationsButton = document.getElementById("moveToApplicationsButton");
const polishedTextEl = document.getElementById("polishedText");
const refreshTriggerButton = document.getElementById("refreshTriggerButton");
const resetConfigButton = document.getElementById("resetConfigButton");
const resultStatePillEl = document.getElementById("resultStatePill");
const restartHintEl = document.getElementById("restartHint");
const savedRouteValueEl = document.getElementById("savedRouteValue");
const savedTokenValueEl = document.getElementById("savedTokenValue");
const secureStorageTextEl = document.getElementById("secureStorageText");
const settingsBackdropEl = document.getElementById("settingsBackdrop");
const settingsCloseButton = document.getElementById("settingsCloseButton");
const settingsErrorTextEl = document.getElementById("settingsErrorText");
const settingsDrawerEl = document.getElementById("settingsDrawer");
const settingsToggleButton = document.getElementById("settingsToggleButton");
const statusTextEl = document.getElementById("statusText");
const toggleDictationButton = document.getElementById("toggleDictationButton");
const triggerDetailTextEl = document.getElementById("triggerDetailText");
const triggerModeValueEl = document.getElementById("triggerModeValue");
const triggerStatusValueEl = document.getElementById("triggerStatusValue");

let settings = null;
let uiState = null;
let settingsDrawerOpen = false;
let diagnosticsPollTimer = null;

function formatMode(mode) {
  if (!mode) {
    return "Idle";
  }

  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function formatHotkey(value) {
  if (!value) {
    return "Unknown";
  }

  return value.replace("CommandOrControl", navigator.platform.includes("Mac") ? "Cmd" : "Ctrl").replaceAll("Alt", "Opt");
}

function setSettingsDrawerOpen(nextOpen) {
  settingsDrawerOpen = Boolean(nextOpen);

  if (dashboardShellEl) {
    dashboardShellEl.dataset.settingsOpen = String(settingsDrawerOpen);
  }

  if (settingsDrawerEl) {
    settingsDrawerEl.setAttribute("aria-hidden", String(!settingsDrawerOpen));
  }

  if (settingsDrawerOpen) {
    startDiagnosticsPolling();
    return;
  }

  stopDiagnosticsPolling();
}

function openSettingsDrawer() {
  setSettingsDrawerOpen(true);
  void refreshTriggerDiagnostics({ restartListener: false }).catch(() => {});
}

function closeSettingsDrawer() {
  setSettingsDrawerOpen(false);
}

function startDiagnosticsPolling() {
  if (!flowApi || diagnosticsPollTimer) {
    return;
  }

  diagnosticsPollTimer = setInterval(() => {
    if (!settingsDrawerOpen) {
      return;
    }

    void refreshTriggerDiagnostics({ restartListener: false }).catch(() => {});
  }, 2500);
}

function stopDiagnosticsPolling() {
  if (!diagnosticsPollTimer) {
    return;
  }

  clearInterval(diagnosticsPollTimer);
  diagnosticsPollTimer = null;
}

function updateConnectionPanel() {
  const configured = Boolean(settings?.apiConfigured);
  connectionStatusEl.dataset.ready = String(configured);
  connectionStatusEl.textContent = configured
    ? "VoiceKit is connected and ready to dictate."
    : "VoiceKit needs an API route and token from your beta host before dictation can start.";

  savedRouteValueEl.textContent = settings?.apiBaseUrl || "Not configured.";
  savedTokenValueEl.textContent = settings?.hasApiToken ? settings.apiTokenMasked || "Stored securely." : "Not configured.";
  secureStorageTextEl.textContent = settings?.secureStorageMessage || "Tokens are encrypted with macOS secure storage when available.";
  settingsErrorTextEl.textContent = settings?.settingsError || "No settings errors.";
  settingsErrorTextEl.classList.toggle("alert", Boolean(settings?.settingsError));

  if (settings) {
    apiBaseUrlInput.placeholder = settings.isPackaged ? "https://your-api.example.com" : "http://127.0.0.1:8000";
    apiTokenInput.placeholder = settings.hasApiToken
      ? `Stored securely as ${settings.apiTokenMasked || "saved token"}`
      : "Paste your service token";
  }
}

function formatAccessibilityState(value) {
  if (value === true) {
    return "Granted";
  }

  if (value === false) {
    return "Not granted";
  }

  return "Unavailable";
}

function formatTriggerModeValue(mode) {
  if (mode === "fn_hold") {
    return "Hold key";
  }

  if (mode === "hotkey") {
    return "Hotkey fallback";
  }

  return "Unknown";
}

function updateTriggerDiagnosticsPanel() {
  const diagnostics = settings?.triggerDiagnostics || {};
  const packaged = Boolean(settings?.isPackaged);
  const stableInstall = Boolean(diagnostics.inApplicationsFolder);
  const canMove = Boolean(diagnostics.canMoveToApplications);
  const holdKeyLabel = diagnostics.holdKeyLabel || "Hold key";
  const holdKeyName = holdKeyLabel.toLowerCase();

  triggerModeValueEl.textContent = formatTriggerModeValue(diagnostics.effectiveTriggerMode);
  triggerStatusValueEl.textContent = diagnostics.effectiveTriggerLabel || settings?.triggerLabel || "Unknown";
  accessibilityValueEl.textContent = formatAccessibilityState(diagnostics.accessibilityTrusted);
  fnListenerValueEl.textContent = diagnostics.fnListenerRunning ? "Running" : "Stopped";

  appPathValueEl.textContent = diagnostics.packagedBundlePath || "Development build";
  appPathHintEl.textContent = packaged
    ? stableInstall
      ? "Installed in Applications. macOS permissions are much less likely to break."
      : `This build is outside Applications. Moving it makes ${holdKeyName} permission more stable across rebuilds and relaunches.`
    : `Development builds move around often, so ${holdKeyName} permission is less stable than an installed packaged app.`;

  restartHintEl.textContent = stableInstall
    ? `If you just changed Accessibility permission, use refresh once so VoiceKit can re-check ${holdKeyName} immediately.`
    : `Install this packaged build in Applications first, then re-enable Accessibility if ${holdKeyName} keeps falling back.`;

  triggerDetailTextEl.textContent = uiState?.hotkeyStatus || "Waiting for trigger diagnostics.";
  triggerDetailTextEl.classList.toggle("alert", Boolean(diagnostics.usingFallbackHotkey));

  accessibilityActionButton.disabled = !flowApi || !navigator.platform.includes("Mac");
  refreshTriggerButton.disabled = !flowApi || !navigator.platform.includes("Mac");
  moveToApplicationsButton.disabled = !flowApi || !canMove;
  moveToApplicationsButton.textContent = stableInstall ? "Already in Applications" : "Move to Applications";
}

function updateButtons() {
  const configured = Boolean(settings?.apiConfigured);
  const processing = uiState?.mode === "processing";
  const recording = Boolean(uiState?.isRecording);

  toggleDictationButton.disabled = !flowApi || processing || !configured;
  toggleDictationButton.textContent = recording ? "Stop dictation" : configured ? "Start dictation" : "Connect API first";
  hideButton.disabled = !flowApi;
}

function updateHoldHint() {
  if (!holdHintKeyEl || !settings) {
    return;
  }

  if (settings.triggerMode !== "fn_hold") {
    holdHintKeyEl.textContent = formatHotkey(settings.hotkey || "CommandOrControl+Shift+Space");
    return;
  }

  const holdKeyLabel =
    settings?.triggerDiagnostics?.holdKeyLabel ||
    String(settings.triggerLabel || "Control (hold)").replace(" (hold)", "");

  holdHintKeyEl.textContent = holdKeyLabel.toLowerCase();
}

function updateResultStatePill(mode, resultStage = "idle") {
  if (!resultStatePillEl) {
    return;
  }

  if (mode === "listening") {
    resultStatePillEl.dataset.state = "live";
    resultStatePillEl.textContent = "Listening";
    return;
  }

  if (mode === "processing" || mode === "arming") {
    resultStatePillEl.dataset.state = "busy";
    resultStatePillEl.textContent =
      resultStage === "raw"
        ? "Raw transcript"
        : resultStage === "polishing"
          ? "Polishing"
          : resultStage === "polished"
            ? "Polished"
            : "Working";
    return;
  }

  if (mode === "error") {
    resultStatePillEl.dataset.state = "error";
    resultStatePillEl.textContent = "Needs attention";
    return;
  }

  resultStatePillEl.dataset.state = "idle";
  resultStatePillEl.textContent = resultStage === "polished" ? "Polished" : resultStage === "raw" ? "Raw pasted" : "Paste ready";
}

function applyState(nextState) {
  uiState = nextState;
  if (dashboardShellEl) {
    dashboardShellEl.dataset.mode = nextState.mode || "idle";
  }
  modeValueEl.textContent = formatMode(nextState.mode);
  micValueEl.textContent = nextState.micStatus || "Unknown";
  statusTextEl.textContent = nextState.status || "Waiting for the pet.";
  const convertedText = nextState.polishedText || nextState.rawTranscript || "No converted text yet.";
  polishedTextEl.textContent = convertedText;
  polishedTextEl.dataset.empty = String(convertedText === "No converted text yet.");
  updateResultStatePill(nextState.mode, nextState.resultStage);
  updateTriggerDiagnosticsPanel();
  updateButtons();
}

function applySettings(nextSettings, { preserveDraft = false } = {}) {
  settings = nextSettings;

  if (!preserveDraft) {
    apiBaseUrlInput.value = nextSettings.apiBaseUrl || "";
    apiTokenInput.value = "";
  }

  hotkeyValueEl.textContent = nextSettings.triggerLabel || formatHotkey(nextSettings.hotkey);
  updateHoldHint();
  updateConnectionPanel();
  updateTriggerDiagnosticsPanel();
  updateButtons();

  if (!nextSettings.apiConfigured) {
    openSettingsDrawer();
  }
}

function setPreviewMode() {
  modeValueEl.textContent = "Preview";
  micValueEl.textContent = "Unavailable";
  hotkeyValueEl.textContent = "Unavailable";
  holdHintKeyEl.textContent = "control";
  statusTextEl.textContent = "This dashboard renderer was opened directly in a browser tab. Launch the Electron desktop app instead.";
  polishedTextEl.textContent = "Start the desktop app with `npm run dev:desktop`.";
  polishedTextEl.dataset.empty = "false";
  updateResultStatePill("idle", "idle");
  connectionStatusEl.textContent = "Preview mode cannot save API settings.";
  secureStorageTextEl.textContent = "Secure token storage is only available inside the Electron app.";
  settingsErrorTextEl.textContent = "Electron IPC is unavailable in preview mode.";
  triggerModeValueEl.textContent = "Preview";
  triggerStatusValueEl.textContent = "Unavailable";
  accessibilityValueEl.textContent = "Unavailable";
  fnListenerValueEl.textContent = "Unavailable";
  appPathValueEl.textContent = "Unavailable";
  appPathHintEl.textContent = "Install and launch the packaged app to test hold-key permissions.";
  restartHintEl.textContent = "Diagnostics actions are only available inside the Electron app.";
  triggerDetailTextEl.textContent = "Electron IPC is unavailable in preview mode.";
  toggleDictationButton.disabled = true;
  hideButton.disabled = true;
  settingsToggleButton.disabled = true;
  settingsCloseButton.disabled = true;
  accessibilityActionButton.disabled = true;
  moveToApplicationsButton.disabled = true;
  refreshTriggerButton.disabled = true;
  resetConfigButton.disabled = true;
  apiBaseUrlInput.disabled = true;
  apiTokenInput.disabled = true;
  openSettingsDrawer();
}

async function saveApiConfig(event) {
  event.preventDefault();

  const snapshot = await flowApi.saveApiConfig({
    apiBaseUrl: apiBaseUrlInput.value,
    apiToken: apiTokenInput.value
  });

  apiTokenInput.value = "";
  applySettings(snapshot);
}

async function resetApiConfig() {
  const snapshot = await flowApi.resetApiConfig();
  apiTokenInput.value = "";
  applySettings(snapshot);
  openSettingsDrawer();
}

async function checkForUpdates() {
  const snapshot = await flowApi.checkForUpdates();
  applySettings(snapshot, { preserveDraft: true });
}

async function refreshTriggerDiagnostics(options = {}) {
  const snapshot = await flowApi.refreshTriggerDiagnostics(options);
  applySettings(snapshot, {
    preserveDraft: document.activeElement === apiBaseUrlInput || document.activeElement === apiTokenInput
  });
}

async function openAccessibilitySettings() {
  await flowApi.openAccessibilitySettings();
  await refreshTriggerDiagnostics({
    restartListener: false
  });
}

async function moveToApplications() {
  moveToApplicationsButton.disabled = true;
  moveToApplicationsButton.textContent = "Moving…";
  await flowApi.moveToApplications();
}

async function installUpdate() {
  await flowApi.installUpdate();
}

async function init() {
  if (!flowApi) {
    setPreviewMode();
    return;
  }

  apiConfigForm.addEventListener("submit", (event) => {
    void saveApiConfig(event).catch((error) => {
      settingsErrorTextEl.textContent = error instanceof Error ? error.message : "Saving the API connection failed.";
    });
  });

  resetConfigButton.addEventListener("click", () => {
    void resetApiConfig().catch((error) => {
      settingsErrorTextEl.textContent = error instanceof Error ? error.message : "Resetting the saved connection failed.";
    });
  });

  toggleDictationButton.addEventListener("click", () => {
    void flowApi.toggleDictation();
  });

  hideButton.addEventListener("click", () => {
    void flowApi.hideDashboard();
  });

  settingsToggleButton.addEventListener("click", () => {
    setSettingsDrawerOpen(!settingsDrawerOpen);
  });

  settingsCloseButton.addEventListener("click", () => {
    closeSettingsDrawer();
  });

  settingsBackdropEl.addEventListener("click", () => {
    closeSettingsDrawer();
  });

  accessibilityActionButton.addEventListener("click", () => {
    void openAccessibilitySettings().catch((error) => {
      settingsErrorTextEl.textContent = error instanceof Error ? error.message : "Opening Accessibility settings failed.";
    });
  });

  refreshTriggerButton.addEventListener("click", () => {
    void refreshTriggerDiagnostics({ restartListener: true }).catch((error) => {
      settingsErrorTextEl.textContent = error instanceof Error ? error.message : "Refreshing hold-key diagnostics failed.";
    });
  });

  moveToApplicationsButton.addEventListener("click", () => {
    void moveToApplications().catch((error) => {
      settingsErrorTextEl.textContent = error instanceof Error ? error.message : "Moving VoiceKit to Applications failed.";
      updateTriggerDiagnosticsPanel();
    });
  });

  flowApi.onSettings((nextSettings) => {
    applySettings(nextSettings, {
      preserveDraft: document.activeElement === apiBaseUrlInput || document.activeElement === apiTokenInput
    });
  });

  flowApi.onUiState((state) => {
    applyState(state);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsDrawerOpen) {
      closeSettingsDrawer();
    }
  });

  startDiagnosticsPolling();

  applySettings(await flowApi.getSettings());
  applyState(await flowApi.getUiState());
}

void init();
