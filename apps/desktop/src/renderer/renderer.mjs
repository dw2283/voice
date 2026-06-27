const flowApi = window.flow;
const hideButton = document.getElementById("hideButton");
const openPlaygroundButton = document.getElementById("openPlaygroundButton");
const modeValueEl = document.getElementById("modeValue");
const providerValueEl = document.getElementById("providerValue");
const micValueEl = document.getElementById("micValue");
const hotkeyValueEl = document.getElementById("hotkeyValue");
const statusTextEl = document.getElementById("statusText");
const rawTextEl = document.getElementById("rawText");
const polishedTextEl = document.getElementById("polishedText");

function formatMode(mode) {
  if (!mode) {
    return "Idle";
  }

  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function applyState(state) {
  modeValueEl.textContent = formatMode(state.mode);
  providerValueEl.textContent = state.provider || "Unknown";
  micValueEl.textContent = state.micStatus || "Unknown";
  statusTextEl.textContent = state.status || "Waiting for the pet.";
  rawTextEl.textContent = state.rawTranscript || "No transcript yet.";
  polishedTextEl.textContent = state.polishedText || "No polished output yet.";
}

function formatHotkey(value) {
  if (!value) {
    return "Unknown";
  }

  return value.replace("CommandOrControl", navigator.platform.includes("Mac") ? "Cmd" : "Ctrl").replaceAll("Alt", "Opt");
}

async function init() {
  if (!flowApi) {
    modeValueEl.textContent = "Preview";
    providerValueEl.textContent = "Unavailable";
    micValueEl.textContent = "Unavailable";
    hotkeyValueEl.textContent = "Unavailable";
    statusTextEl.textContent = "This dashboard renderer was opened directly in a browser tab. Launch the Electron desktop app instead.";
    rawTextEl.textContent = "Dashboard data comes from Electron IPC state.";
    polishedTextEl.textContent = "Start the desktop app with `npm run dev:desktop`.";
    hideButton.disabled = true;
    openPlaygroundButton.disabled = true;
    return;
  }

  hideButton.addEventListener("click", () => {
    void flowApi.hideDashboard();
  });

  openPlaygroundButton.addEventListener("click", () => {
    void flowApi.openExternalUrl("http://127.0.0.1:8000/");
  });

  hotkeyValueEl.textContent = formatHotkey((await flowApi.getSettings()).hotkey);
  flowApi.onUiState((state) => {
    applyState(state);
  });

  applyState(await flowApi.getUiState());
}

void init();
