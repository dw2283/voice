const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flow", {
  checkForUpdates: () => ipcRenderer.invoke("flow:check-for-updates"),
  getSettings: () => ipcRenderer.invoke("flow:get-settings"),
  getContext: () => ipcRenderer.invoke("flow:get-context"),
  getMicrophoneStatus: () => ipcRenderer.invoke("flow:get-microphone-status"),
  ensureMicrophoneAccess: () => ipcRenderer.invoke("flow:ensure-microphone-access"),
  getUiState: () => ipcRenderer.invoke("flow:get-ui-state"),
  updateUiState: (patch) => ipcRenderer.invoke("flow:update-ui-state", patch),
  showDashboard: () => ipcRenderer.invoke("flow:show-dashboard"),
  hideDashboard: () => ipcRenderer.invoke("flow:hide-dashboard"),
  installUpdate: () => ipcRenderer.invoke("flow:install-update"),
  resetApiConfig: () => ipcRenderer.invoke("flow:reset-api-config"),
  saveApiConfig: (payload) => ipcRenderer.invoke("flow:save-api-config", payload),
  toggleDictation: () => ipcRenderer.invoke("flow:toggle-dictation"),
  openExternalUrl: (url) => ipcRenderer.invoke("flow:open-external-url", url),
  processDictation: (payload) => ipcRenderer.invoke("flow:process-dictation", payload),
  onSettings: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("flow:settings", listener);

    return () => {
      ipcRenderer.removeListener("flow:settings", listener);
    };
  },
  onUiState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("flow:ui-state", listener);

    return () => {
      ipcRenderer.removeListener("flow:ui-state", listener);
    };
  },
  onHotkeyToggle: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("flow:hotkey-toggle", listener);

    return () => {
      ipcRenderer.removeListener("flow:hotkey-toggle", listener);
    };
  }
});
