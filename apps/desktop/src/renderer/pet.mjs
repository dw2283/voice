const flowApi = window.flow;
const petButton = document.getElementById("petButton");
const petLabelEl = document.getElementById("petLabel");
const statusPillEl = document.getElementById("statusPill");

let mediaRecorder = null;
let mediaStream = null;
let audioContext = null;
let audioSource = null;
let analyserNode = null;
let audioLevelFrame = 0;
let audioLevelData = null;
let smoothedVoiceLevel = 0;
let detectedSpeech = false;
let lastSpeechAt = 0;
let autoStopInFlight = false;
let chunks = [];
let isRecording = false;
let recordingStartedAt = 0;
const speechLevelThreshold = 0.075;
let autoStopAfterSilenceMs = 650;
let autoStopMaxInitialSilenceMs = 8000;
let minimumAutoStopRecordingMs = 700;
let startRecordingPromise = null;
let settings = {
  autoStopAfterSilenceMs,
  autoStopMaxInitialSilenceMs,
  holdKey: "control",
  hotkey: "CommandOrControl+Shift+Space",
  triggerLabel: "Control (hold)",
  triggerMode: "fn_hold",
  minimumAutoStopRecordingMs,
  preferBrowserSpeechRecognition: false,
  transcribeModel: "",
  transcribeProvider: "mock"
};
let uiState = {
  mode: "idle",
  status: "Hold control to dictate.",
  micStatus: "Microphone status is loading...",
  rawTranscript: "No transcript yet.",
  polishedText: "No converted text yet.",
  provider: "unknown",
  isRecording: false,
  dashboardVisible: false
};
let holdToTalkSession = false;
let stopAfterPendingStart = false;

function prettyHotkey(value) {
  return value
    .replace("CommandOrControl", navigator.platform.includes("Mac") ? "Cmd" : "Ctrl")
    .replaceAll("Alt", navigator.platform.includes("Mac") ? "Opt" : "Alt")
    .replaceAll("+", " + ");
}

function getHoldKeyInstructionText() {
  const normalized = String(settings.holdKey ?? "control").trim().toLowerCase();

  if (normalized === "fn") {
    return "fn";
  }

  if (["control", "option", "shift", "command"].includes(normalized)) {
    return normalized;
  }

  return "control";
}

function compactText(value, maxLength = 28) {
  const normalized = (value || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function getNumberSetting(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function getModeCopy(state) {
  const transcriptPreview =
    state.rawTranscript && state.rawTranscript !== "No transcript yet." && state.rawTranscript !== "Listening..."
      ? compactText(state.rawTranscript)
      : "";
  const polishedPreview =
    state.polishedText && state.polishedText !== "No converted text yet."
      ? compactText(state.polishedText)
      : "";

  if (state.mode === "listening") {
    return {
      detail: transcriptPreview || compactText(state.status, 34) || "Speak. I’ll paste when you pause.",
      title: "Listening"
    };
  }

  if (state.mode === "arming") {
    return {
      detail: compactText(state.status, 34) || "Getting the microphone ready...",
      title: "Starting"
    };
  }

  if (state.mode === "processing") {
    return {
      detail: polishedPreview || transcriptPreview || compactText(state.status, 34) || "Cleaning up your words.",
      title: polishedPreview ? "Polishing" : transcriptPreview ? "Transcript" : "Working"
    };
  }

  if (state.mode === "done") {
    return {
      detail: compactText(state.status, 34) || "Pasted into your app.",
      title: polishedPreview && transcriptPreview && polishedPreview !== transcriptPreview ? "Polished" : "Pasted"
    };
  }

  if (state.mode === "error") {
    return {
      detail: compactText(state.status, 30) || "Something went wrong.",
      title: "Retry"
    };
  }

  return {
    detail: compactText(state.status, 34) || `Trigger: ${settings.triggerLabel || prettyHotkey(settings.hotkey)}`,
    title: "Voice"
  };
}

function setVisualState(state) {
  const mode = state.mode || "idle";
  const copy = getModeCopy(state);
  petButton.dataset.mode = mode;
  petLabelEl.textContent = copy.title;
  statusPillEl.textContent = copy.detail;

  if (mode !== "listening") {
    setVoiceLevel(0);
  }
}

async function publishState(patch) {
  uiState = { ...uiState, ...patch };
  setVisualState(uiState);

  if (flowApi) {
    await flowApi.updateUiState(patch);
  }
}

async function publishRecordingError(error) {
  isRecording = false;
  autoStopInFlight = false;
  stopVoiceMeter();
  await publishState({
    mode: "error",
    status: error instanceof Error ? error.message : "Voice ran into a snag while dictating.",
    isRecording: false
  });
}

function getPreferredRecordingMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

  return candidates.find((mimeType) => MediaRecorder.isTypeSupported?.(mimeType)) || "";
}

async function ensureMediaStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Media capture is unavailable in this Electron build.");
  }

  if (!mediaStream) {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });
  }

  return mediaStream;
}

function setVoiceLevel(value) {
  const clamped = Math.min(Math.max(value, 0), 1);
  petButton.style.setProperty("--voice-level", clamped.toFixed(3));
}

function stopVoiceMeter() {
  if (audioLevelFrame) {
    cancelAnimationFrame(audioLevelFrame);
    audioLevelFrame = 0;
  }

  if (audioContext && audioContext.state !== "closed") {
    void audioContext.close();
  }

  audioContext = null;
  audioSource = null;
  analyserNode = null;
  audioLevelData = null;
  smoothedVoiceLevel = 0;
  detectedSpeech = false;
  lastSpeechAt = 0;
  setVoiceLevel(0);
}

async function startVoiceMeter(stream) {
  stopVoiceMeter();

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    return;
  }

  try {
    audioContext = new AudioContextClass();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    audioSource = audioContext.createMediaStreamSource(stream);
    audioSource.connect(analyserNode);
    audioLevelData = new Uint8Array(analyserNode.fftSize);

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    updateVoiceMeter();
  } catch {
    stopVoiceMeter();
  }
}

function updateVoiceMeter() {
  if (!analyserNode || !audioLevelData || !isRecording) {
    setVoiceLevel(0);
    return;
  }

  analyserNode.getByteTimeDomainData(audioLevelData);

  let sum = 0;

  for (const value of audioLevelData) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }

  const rms = Math.sqrt(sum / audioLevelData.length);
  const nextLevel = Math.min(1, rms * 4.5);
  const now = Date.now();

  if (nextLevel >= speechLevelThreshold) {
    detectedSpeech = true;
    lastSpeechAt = now;
  }

  smoothedVoiceLevel = smoothedVoiceLevel * 0.68 + nextLevel * 0.32;
  setVoiceLevel(smoothedVoiceLevel);

  const recordingDuration = now - recordingStartedAt;
  const silenceAfterSpeech = detectedSpeech && now - lastSpeechAt >= autoStopAfterSilenceMs;
  const initialSilenceExpired = !detectedSpeech && recordingDuration >= autoStopMaxInitialSilenceMs;
  const allowAutoStop = !holdToTalkSession;

  if (
    allowAutoStop &&
    !autoStopInFlight &&
    recordingDuration >= minimumAutoStopRecordingMs &&
    (silenceAfterSpeech || initialSilenceExpired)
  ) {
    autoStopInFlight = true;
    void stopRecording({
      reason: silenceAfterSpeech ? "silence" : "initial-silence"
    }).catch((error) => {
      void publishRecordingError(error);
    });
    return;
  }

  audioLevelFrame = requestAnimationFrame(updateVoiceMeter);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => {
      const result = reader.result;

      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"));
        return;
      }

      const [, base64 = ""] = result.split(",");
      resolve(base64);
    };

    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio blob"));
    reader.readAsDataURL(blob);
  });
}

async function startRecording({ holdToTalk = false } = {}) {
  if (startRecordingPromise) {
    return startRecordingPromise;
  }

  startRecordingPromise = (async () => {
    try {
      const access = await flowApi.ensureMicrophoneAccess();

      if (access.status !== "granted") {
        throw new Error(access.message || "Microphone access is required.");
      }

      if (!window.MediaRecorder) {
        throw new Error("MediaRecorder is unavailable in this Electron build.");
      }

      await publishState({
        micStatus: access.message
      });

      const stream = await ensureMediaStream();
      chunks = [];
      const mimeType = getPreferredRecordingMimeType();
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.start(250);
      isRecording = true;
      holdToTalkSession = holdToTalk;
      autoStopInFlight = false;
      detectedSpeech = false;
      lastSpeechAt = 0;
      recordingStartedAt = Date.now();
      await startVoiceMeter(stream);
      await publishState({
        mode: "listening",
        status: holdToTalk
          ? `Voice is listening. Release ${getHoldKeyInstructionText()} and I’ll paste what you said.`
          : "Voice is listening. Pause briefly and I’ll paste automatically.",
        polishedText: "",
        rawTranscript: "Listening...",
        isRecording: true
      });

      if (holdToTalk && stopAfterPendingStart && isRecording) {
        stopAfterPendingStart = false;
        await stopRecording();
      }
    } catch (error) {
      isRecording = false;
      holdToTalkSession = false;
      autoStopInFlight = false;
      stopAfterPendingStart = false;
      stopVoiceMeter();
      mediaRecorder = null;
      chunks = [];
      recordingStartedAt = 0;
      throw error;
    }
  })();

  try {
    await startRecordingPromise;
  } finally {
    startRecordingPromise = null;
  }
}

async function stopRecording({ reason = "manual" } = {}) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    return;
  }

  const stopStartedAt = performance.now();
  isRecording = false;
  stopVoiceMeter();
  await publishState({
    mode: "processing",
    status: "Voice is transcribing your audio locally...",
    isRecording: false
  });

  const blob = await new Promise((resolve) => {
    mediaRecorder.onstop = () => {
      resolve(new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" }));
    };
    mediaRecorder.stop();
  });
  const blobReadyAt = performance.now();

  try {
    if (reason === "initial-silence") {
      throw new Error(
        settings.triggerMode === "fn_hold"
          ? `I didn’t hear anything. Hold ${getHoldKeyInstructionText()} and start speaking right away.`
          : "I didn’t hear anything. Press the trigger and start speaking."
      );
    }

    if (Date.now() - recordingStartedAt < 450 || blob.size === 0) {
      throw new Error(
        settings.triggerMode === "fn_hold"
          ? `I did not catch enough audio. Hold ${getHoldKeyInstructionText()} a bit longer and speak clearly.`
          : "I did not catch enough audio. Speak, then pause briefly."
      );
    }

    const traceId = `vf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const audioBase64 = await blobToBase64(blob);
    const base64ReadyAt = performance.now();
    const context = await flowApi.getContext();
    const contextReadyAt = performance.now();

    await flowApi.processDictation({
      audioBase64,
      clientTimings: {
        audioBytes: blob.size,
        blobToBase64Ms: base64ReadyAt - blobReadyAt,
        getContextMs: contextReadyAt - base64ReadyAt,
        preApiMs: contextReadyAt - stopStartedAt,
        recordingMs: Date.now() - recordingStartedAt,
        stopToBlobMs: blobReadyAt - stopStartedAt
      },
      mimeType: blob.type || "audio/webm",
      context,
      finalOnly: true,
      traceId
    });
  } finally {
    holdToTalkSession = false;
    autoStopInFlight = false;
    mediaRecorder = null;
    chunks = [];
    recordingStartedAt = 0;
  }
}

async function toggleRecording() {
  try {
    if (isRecording) {
      await stopRecording();
      return;
    }

    if (startRecordingPromise) {
      stopAfterPendingStart = true;
      return;
    }

    await startRecording();
  } catch (error) {
    await publishRecordingError(error);
  }
}

async function handleHotkeyAction(payload = {}) {
  try {
    const action = payload.action ?? "toggle";

    if (action === "start") {
      if (payload.holdToTalk) {
        stopAfterPendingStart = false;
      }

      if (!isRecording) {
        await startRecording({
          holdToTalk: Boolean(payload.holdToTalk)
        });
      }
      return;
    }

    if (action === "stop") {
      if (isRecording) {
        await stopRecording();
        return;
      }

      if (startRecordingPromise) {
        stopAfterPendingStart = true;
      }
      return;
    }

    await toggleRecording();
  } catch (error) {
    await publishRecordingError(error);
  }
}

async function init() {
  if (!flowApi) {
    petButton.dataset.mode = "error";
    petLabelEl.textContent = "Preview";
    statusPillEl.textContent = "Launch through Electron.";
    petButton.disabled = true;
    return;
  }

  petButton.addEventListener("click", () => {
    void toggleRecording();
  });

  petButton.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void flowApi.showDashboard();
  });

  flowApi.onHotkeyToggle((payload) => {
    void handleHotkeyAction(payload);
  });

  flowApi.onUiState((state) => {
    uiState = state;
    setVisualState(state);
  });

  settings = await flowApi.getSettings();
  autoStopAfterSilenceMs = getNumberSetting(settings.autoStopAfterSilenceMs, autoStopAfterSilenceMs, 350, 2000);
  autoStopMaxInitialSilenceMs = getNumberSetting(
    settings.autoStopMaxInitialSilenceMs,
    autoStopMaxInitialSilenceMs,
    3000,
    15000
  );
  minimumAutoStopRecordingMs = getNumberSetting(settings.minimumAutoStopRecordingMs, minimumAutoStopRecordingMs, 250, 2000);
  uiState = await flowApi.getUiState();

  if (uiState.mode === "idle" && !uiState.status) {
    uiState.status =
      settings.triggerMode === "fn_hold"
        ? `Hold ${getHoldKeyInstructionText()} to dictate.`
        : `Press ${settings.triggerLabel || prettyHotkey(settings.hotkey)} to dictate.`;
  }

  setVisualState(uiState);
}

void init();
