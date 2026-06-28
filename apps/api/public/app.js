const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const rawOutputEl = document.getElementById("rawOutput");
const polishedOutputEl = document.getElementById("polishedOutput");
const debugTranscriptEl = document.getElementById("debugTranscript");
const appNameEl = document.getElementById("appName");
const userIntentEl = document.getElementById("userIntent");
const dictionaryHintsEl = document.getElementById("dictionaryHints");
const recordButton = document.getElementById("recordButton");
const submitDebugButton = document.getElementById("submitDebugButton");
const applyButton = document.getElementById("applyButton");
const targetBoxEl = document.getElementById("targetBox");

let mediaRecorder = null;
let mediaStream = null;
let chunks = [];
let isRecording = false;
let latestPolishedText = "";

function setStatus(message) {
  statusEl.textContent = message;
}

function setMeta(message) {
  metaEl.textContent = message;
}

function setRecordingState(nextValue) {
  isRecording = nextValue;
  recordButton.dataset.recording = String(nextValue);
  recordButton.textContent = nextValue ? "Stop recording" : "Start recording";
}

function getPreferredRecordingMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

  return candidates.find((mimeType) => MediaRecorder.isTypeSupported?.(mimeType)) || "";
}

async function requestMicrophoneAccess() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not expose microphone access. Try Chrome, Safari, or the desktop app.");
  }

  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false
  });
}

function getContext() {
  const dictionaryHints = dictionaryHintsEl.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    platform: "web-playground",
    appName: appNameEl.value,
    selectedText: "",
    surroundingText: targetBoxEl.value,
    dictionaryHints
  };
}

function updateOutputs(result) {
  rawOutputEl.textContent = result.rawTranscript || "No transcript returned.";
  polishedOutputEl.textContent = result.polishedText || "No polished text returned.";
  latestPolishedText = result.polishedText || "";
  const polishModel = result.modelInfo?.polish === "disabled" ? "disabled" : result.modelInfo?.polish ?? "unknown";
  setMeta(
    `Provider: ${result.provider}. Transcribe model: ${result.modelInfo?.transcribe ?? "unknown"}. Polish model: ${polishModel}.`
  );
}

async function callDictationApi(payload) {
  const response = await fetch("/v1/dictate", {
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
      // Keep non-JSON API errors readable in the playground.
    }

    throw new Error(message || `Request failed: ${response.status}`);
  }

  const json = await response.json();
  return json.result;
}

async function loadHealth() {
  const response = await fetch("/health");

  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }

  return response.json();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => {
      const result = reader.result;

      if (typeof result !== "string") {
        reject(new Error("Unexpected audio reader result."));
        return;
      }

      const [, base64 = ""] = result.split(",");
      resolve(base64);
    };

    reader.onerror = () => reject(reader.error ?? new Error("Audio read failed."));
    reader.readAsDataURL(blob);
  });
}

async function ensureMediaStream() {
  if (!mediaStream) {
    mediaStream = await requestMicrophoneAccess();
  }

  return mediaStream;
}

async function startRawAudioRecording(stream = null) {
  mediaStream = stream ?? (await ensureMediaStream());
  chunks = [];
  const mimeType = getPreferredRecordingMimeType();
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  mediaRecorder.start(250);
  setRecordingState(true);
  setStatus("Recording audio for backend transcription. Stop when you finish speaking.");
  setMeta("Transcription: raw audio to local/server model. Polish: optional server-side cleanup.");
}

async function startRecording() {
  let permissionStream = null;

  setStatus("Requesting microphone access...");

  try {
    permissionStream = await requestMicrophoneAccess();
  } catch (error) {
    setRecordingState(false);
    const detail =
      error instanceof Error && error.message ? `${error.message.replace(/[.\\s]+$/, "")}. ` : "";
    setStatus(`${detail}Allow microphone access for 127.0.0.1 and try again.`);
    setMeta("Recording is blocked until microphone permission is granted.");
    return;
  }

  await startRawAudioRecording(permissionStream);
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    return;
  }

  setStatus("Uploading audio and waiting for dictation result...");

  const blob = await new Promise((resolve) => {
    mediaRecorder.onstop = () => {
      resolve(new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" }));
    };
    mediaRecorder.stop();
  });

  setRecordingState(false);

  try {
    if (blob.size === 0) {
      throw new Error("No microphone audio was captured. Speak, then stop recording.");
    }

    const result = await callDictationApi({
      audioBase64: await blobToBase64(blob),
      mimeType: blob.type || "audio/webm",
      context: getContext(),
      userIntent: userIntentEl.value,
      finalOnly: true
    });

    updateOutputs(result);
    setStatus("Finished. Use Apply polished text to mimic paste-back.");
  } finally {
    mediaRecorder = null;
    chunks = [];
  }
}

async function submitDebugTranscript() {
  setStatus("Sending rough transcript through the dictation pipeline...");

  const result = await callDictationApi({
    debugTranscript: debugTranscriptEl.value,
    context: getContext(),
    userIntent: userIntentEl.value,
    finalOnly: true
  });

  updateOutputs(result);
  setStatus("Finished. The output text is ready to apply.");
}

function applyPolishedText() {
  if (!latestPolishedText) {
    setStatus("No output text yet. Record or submit a debug transcript first.");
    return;
  }

  targetBoxEl.value = latestPolishedText;
  targetBoxEl.focus();
  setStatus("Applied polished text to the target box.");
}

recordButton.addEventListener("click", async () => {
  try {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  } catch (error) {
    setRecordingState(false);
    setStatus(error instanceof Error ? error.message : "Recording failed.");
  }
});

submitDebugButton.addEventListener("click", async () => {
  try {
    await submitDebugTranscript();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Debug submission failed.");
  }
});

applyButton.addEventListener("click", () => {
  applyPolishedText();
});

setMeta("Mock provider is the default until we wire a real transcription backend.");

try {
  const health = await loadHealth();
  setMeta(`API provider: ${health.provider}. Record to transcribe locally when supported, then optionally polish on the server.`);
} catch (error) {
  setMeta(error instanceof Error ? error.message : "Unable to load API health.");
}
