import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("flow", {
  getSettings: () => ipcRenderer.invoke("flow:get-settings"),
  getContext: () => ipcRenderer.invoke("flow:get-context"),
  getMicrophoneStatus: () => ipcRenderer.invoke("flow:get-microphone-status"),
  ensureMicrophoneAccess: () => ipcRenderer.invoke("flow:ensure-microphone-access"),
  getUiState: () => ipcRenderer.invoke("flow:get-ui-state"),
  updateUiState: (patch) => ipcRenderer.invoke("flow:update-ui-state", patch),
  showDashboard: () => ipcRenderer.invoke("flow:show-dashboard"),
  hideDashboard: () => ipcRenderer.invoke("flow:hide-dashboard"),
  openExternalUrl: (url) => ipcRenderer.invoke("flow:open-external-url", url),
  processDictation: (payload) => ipcRenderer.invoke("flow:process-dictation", payload),
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
