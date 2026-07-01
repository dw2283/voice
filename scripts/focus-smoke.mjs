import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildAppleScriptHotkeyLines,
  buildVoiceEnv,
  cacheDir,
  ensureRuntimeDirs,
  getHoldKey,
  getTriggerLabel,
  getTriggerMode,
  readEnvFile,
  repoRoot,
  sleep
} from "./process-utils.mjs";

const execFileAsync = promisify(execFile);
const resultPath = path.join(cacheDir, "focus-smoke-result.json");
const runtimeStatePath = path.join(cacheDir, "desktop-runtime-state.json");
const preflightOnly = process.argv.includes("--preflight-only");
const voiceEnv = buildVoiceEnv(await readEnvFile());
const holdKey = getHoldKey(voiceEnv);
const triggerMode = getTriggerMode(voiceEnv);
const hotkey = voiceEnv.FLOW_HOTKEY;
const triggerLabel = getTriggerLabel({
  holdKey,
  hotkey,
  triggerMode
});

let documentOpen = false;
let resultWritten = false;

async function commandExists(command) {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function runAppleScript(lines) {
  const args = lines.flatMap((line) => ["-e", line]);
  const { stdout } = await execFileAsync("osascript", args, {
    timeout: 10000
  });

  return stdout.trim();
}

async function getFrontmostApp() {
  return runAppleScript([
    'tell application "System Events"',
    "set frontApp to first application process whose frontmost is true",
    "return name of frontApp",
    "end tell"
  ]);
}

async function prepareTextEditDocument() {
  await runAppleScript([
    'tell application "TextEdit"',
    "activate",
    "make new document with properties {text:\"\"}",
    "end tell",
    "delay 0.3"
  ]);
  documentOpen = true;
}

async function closeTextEditDocument() {
  if (!documentOpen) {
    return;
  }

  await runAppleScript([
    'tell application "TextEdit"',
    "if (count of documents) is 0 then return",
    "close front document saving no",
    "end tell"
  ]);
  documentOpen = false;
}

async function pressHotkey() {
  await runAppleScript(buildAppleScriptHotkeyLines(hotkey));
}

async function readRuntimeState() {
  try {
    return JSON.parse(await fs.readFile(runtimeStatePath, "utf8"));
  } catch {
    return null;
  }
}

async function waitForRuntimeState(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastState = await readRuntimeState();

    if (lastState && predicate(lastState)) {
      return lastState;
    }

    await sleep(150);
  }

  throw new Error(`Timed out waiting for ${label}. Last runtime state: ${JSON.stringify(lastState)}`);
}

async function runPreflight() {
  try {
    await execFileAsync("npm", ["run", "voice:doctor"], {
      cwd: repoRoot,
      timeout: 30000
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    const detail = output ? `\n\n${output}` : "";

    throw new Error(`Voice Flow is not ready for the focus smoke test. Run \`npm run voice:restart\`, then try again.${detail}`);
  }

  if (!(await commandExists("osascript"))) {
    throw new Error("macOS command `osascript` is required for the focus smoke test.");
  }
}

async function writeResult(result) {
  await ensureRuntimeDirs();
  await fs.writeFile(
    resultPath,
    `${JSON.stringify(
      {
        mode: preflightOnly ? "preflight-only" : "full",
        timestamp: new Date().toISOString(),
        ...result
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  resultWritten = true;
}

async function stopIfStillRecording() {
  if (triggerMode === "fn_hold") {
    return;
  }

  const state = await readRuntimeState();

  if (state?.isRecording || state?.mode === "listening") {
    await pressHotkey();
    await sleep(1000);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Focus smoke test is macOS-only because it uses TextEdit, System Events, and the desktop trigger.");
  }

  console.log("Checking Voice Flow health before focus smoke...");
  await runPreflight();
  console.log("PASS Preflight: Voice Flow is running.");
  console.log("");

  if (preflightOnly) {
    await writeResult({
      status: "pass"
    });
    console.log("PASS Focus smoke preflight only");
    console.log(`PASS Result: ${resultPath}`);
    return;
  }

  if (triggerMode === "fn_hold") {
    throw new Error(
      `Focus smoke only supports \`FLOW_TRIGGER_MODE=hotkey\`. The current trigger is \`${triggerLabel}\`, so use \`npm run voice:manual-check\` for the real verification flow.`
    );
  }

  await prepareTextEditDocument();

  const beforeHotkeyApp = await getFrontmostApp();
  console.log("Focus smoke test");
  console.log(`Frontmost before trigger: ${beforeHotkeyApp}`);
  console.log(`Pressing the configured trigger (${triggerLabel}) and checking that TextEdit keeps focus.`);
  console.log("");

  await pressHotkey();
  let recordingState = null;

  try {
    recordingState = await waitForRuntimeState(
      (state) => state.isRecording || state.mode === "listening",
      8000,
      "Lupi to enter listening mode"
    );
  } catch (error) {
    const runtimeState = await readRuntimeState();
    await writeResult({
      beforeHotkeyApp,
      failureKind: "synthetic-hotkey-not-observed",
      runtimeState,
      status: "fail"
    });
    throw new Error(
      [
        `Focus smoke could not observe Voice Flow listening after an AppleScript-generated ${triggerLabel}.`,
        "macOS or Electron may ignore synthetic trigger events.",
        "Use `npm run voice:manual-check` with a physical keypress for authoritative evidence.",
        error instanceof Error ? error.message : String(error)
      ].join(" ")
    );
  }

  const afterStartApp = await getFrontmostApp();

  await pressHotkey();
  const finalState = await waitForRuntimeState(
    (state) => !state.isRecording && state.mode !== "processing",
    45000,
    "Lupi to stop listening"
  );
  const afterStopApp = await getFrontmostApp();

  if (beforeHotkeyApp !== "TextEdit" || afterStartApp !== "TextEdit") {
    await writeResult({
      afterStartApp,
      afterStopApp,
      beforeHotkeyApp,
      finalState,
      recordingState,
      status: "fail"
    });
    throw new Error(`Focus smoke failed. Expected TextEdit to stay frontmost, got before="${beforeHotkeyApp}", afterStart="${afterStartApp}".`);
  }

  await writeResult({
    afterStartApp,
    afterStopApp,
    beforeHotkeyApp,
    finalState,
    recordingState,
    status: "pass"
  });

  console.log("PASS Focus smoke test");
  console.log("PASS Target app before trigger: TextEdit");
  console.log("PASS Target app after trigger: TextEdit");
  console.log(`PASS Captured app: ${recordingState.capturedAppName || "unknown"}`);
  console.log(`PASS Result: ${resultPath}`);
}

process.once("SIGINT", () => {
  void (async () => {
    try {
      await stopIfStillRecording();
      await closeTextEditDocument();
      await writeResult({
        error: "Interrupted by SIGINT.",
        status: "interrupted"
      });
    } finally {
      process.exit(130);
    }
  })();
});

try {
  await main();
} catch (error) {
  await stopIfStillRecording();
  if (!resultWritten) {
    await writeResult({
      error: error instanceof Error ? error.message : String(error),
      status: "fail"
    });
  }
  throw error;
} finally {
  await closeTextEditDocument();
}
