const flowApi = window.flow;
const apiBaseUrlInput = document.getElementById("apiBaseUrlInput");
const apiConfigForm = document.getElementById("apiConfigForm");
const apiTokenInput = document.getElementById("apiTokenInput");
const checkUpdatesButton = document.getElementById("checkUpdatesButton");
const connectionStatusEl = document.getElementById("connectionStatus");
const hideButton = document.getElementById("hideButton");
const hotkeyStatusTextEl = document.getElementById("hotkeyStatusText");
const hotkeyValueEl = document.getElementById("hotkeyValue");
const installUpdateButton = document.getElementById("installUpdateButton");
const micValueEl = document.getElementById("micValue");
const modeValueEl = document.getElementById("modeValue");
const openApiButton = document.getElementById("openApiButton");
const polishedTextEl = document.getElementById("polishedText");
const providerValueEl = document.getElementById("providerValue");
const rawTextEl = document.getElementById("rawText");
const resetConfigButton = document.getElementById("resetConfigButton");
const savedRouteValueEl = document.getElementById("savedRouteValue");
const savedTokenValueEl = document.getElementById("savedTokenValue");
const secureStorageTextEl = document.getElementById("secureStorageText");
const settingsErrorTextEl = document.getElementById("settingsErrorText");
const statusTextEl = document.getElementById("statusText");
const toggleDictationButton = document.getElementById("toggleDictationButton");
const updateStatusTextEl = document.getElementById("updateStatusText");

let settings = null;
let uiState = null;

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

function updateConnectionPanel() {
  const configured = Boolean(settings?.apiConfigured);
  connectionStatusEl.dataset.ready = String(configured);
  connectionStatusEl.textContent = configured
    ? "Voice Flow is connected and ready to dictate."
    : "Voice Flow needs an API route and token before dictation can start.";

  savedRouteValueEl.textContent = settings?.apiBaseUrl || "Not configured.";
  savedTokenValueEl.textContent = settings?.hasApiToken ? settings.apiTokenMasked || "Stored securely." : "Not configured.";
  secureStorageTextEl.textContent = settings?.secureStorageMessage || "Tokens are encrypted with macOS secure storage when available.";
  settingsErrorTextEl.textContent = settings?.settingsError || "No settings errors.";

  if (settings) {
    apiBaseUrlInput.placeholder = settings.isPackaged ? "https://your-api.example.com" : "http://127.0.0.1:8000";
    apiTokenInput.placeholder = settings.hasApiToken
      ? `Stored securely as ${settings.apiTokenMasked || "saved token"}`
      : "Paste your service token";
  }
}

function updateButtons() {
  const configured = Boolean(settings?.apiConfigured);
  const processing = uiState?.mode === "processing";
  const recording = Boolean(uiState?.isRecording);

  toggleDictationButton.disabled = !flowApi || processing || !configured;
  toggleDictationButton.textContent = recording ? "Stop dictation" : configured ? "Start dictation" : "Connect API first";
  hideButton.disabled = !flowApi;
  openApiButton.disabled = !flowApi || !settings?.apiBaseUrl;
  checkUpdatesButton.disabled = !flowApi || !settings?.canCheckForUpdates;
  installUpdateButton.disabled = !flowApi || settings?.updateStatus !== "downloaded";
}

function applyState(nextState) {
  uiState = nextState;
  modeValueEl.textContent = formatMode(nextState.mode);
  providerValueEl.textContent = nextState.provider || settings?.transcribeProvider || "Unknown";
  micValueEl.textContent = nextState.micStatus || "Unknown";
  statusTextEl.textContent = nextState.status || "Waiting for the pet.";
  hotkeyStatusTextEl.textContent = nextState.hotkeyStatus || "Trigger status is unavailable.";
  rawTextEl.textContent = nextState.rawTranscript || "No transcript yet.";
  polishedTextEl.textContent = nextState.polishedText || "No polished output yet.";
  updateButtons();
}

function formatUpdateStatus() {
  if (!settings) {
    return "Update status unavailable.";
  }

  if (settings.updateStatus === "downloaded") {
    return settings.updateMessage || "A new beta build is ready to install.";
  }

  if (settings.updateStatus === "disabled") {
    return settings.updateMessage || "Auto-update is only available in packaged beta builds.";
  }

  if (settings.updateStatus === "downloading" && Number.isFinite(settings.updateProgress)) {
    return `${settings.updateMessage} (${settings.updateProgress}%)`;
  }

  return settings.updateMessage || "Waiting to check for updates.";
}

function applySettings(nextSettings, { preserveDraft = false } = {}) {
  settings = nextSettings;

  if (!preserveDraft) {
    apiBaseUrlInput.value = nextSettings.apiBaseUrl || "";
    apiTokenInput.value = "";
  }

  hotkeyValueEl.textContent = nextSettings.triggerLabel || formatHotkey(nextSettings.hotkey);
  updateStatusTextEl.textContent = formatUpdateStatus();
  updateConnectionPanel();
  updateButtons();
}

function setPreviewMode() {
  modeValueEl.textContent = "Preview";
  providerValueEl.textContent = "Unavailable";
  micValueEl.textContent = "Unavailable";
  hotkeyValueEl.textContent = "Unavailable";
  statusTextEl.textContent = "This dashboard renderer was opened directly in a browser tab. Launch the Electron desktop app instead.";
  hotkeyStatusTextEl.textContent = "Trigger diagnostics are only available inside the Electron dashboard.";
  rawTextEl.textContent = "Dashboard data comes from Electron IPC state.";
  polishedTextEl.textContent = "Start the desktop app with `npm run dev:desktop`.";
  connectionStatusEl.textContent = "Preview mode cannot save API settings.";
  secureStorageTextEl.textContent = "Secure token storage is only available inside the Electron app.";
  settingsErrorTextEl.textContent = "Electron IPC is unavailable in preview mode.";
  updateStatusTextEl.textContent = "Auto-update is unavailable in preview mode.";
  toggleDictationButton.disabled = true;
  hideButton.disabled = true;
  openApiButton.disabled = true;
  checkUpdatesButton.disabled = true;
  installUpdateButton.disabled = true;
  resetConfigButton.disabled = true;
  apiBaseUrlInput.disabled = true;
  apiTokenInput.disabled = true;
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
}

async function checkForUpdates() {
  const snapshot = await flowApi.checkForUpdates();
  applySettings(snapshot, { preserveDraft: true });
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

  openApiButton.addEventListener("click", () => {
    if (settings?.apiBaseUrl) {
      void flowApi.openExternalUrl(settings.apiBaseUrl);
    }
  });

  checkUpdatesButton.addEventListener("click", () => {
    void checkForUpdates().catch((error) => {
      updateStatusTextEl.textContent = error instanceof Error ? error.message : "Update check failed.";
    });
  });

  installUpdateButton.addEventListener("click", () => {
    void installUpdate().catch((error) => {
      updateStatusTextEl.textContent = error instanceof Error ? error.message : "Update install failed.";
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

  applySettings(await flowApi.getSettings());
  applyState(await flowApi.getUiState());
}

void init();
