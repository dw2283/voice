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
const expectedPhrase = "voice flow hotkey smoke";
const preflightOnly = process.argv.includes("--preflight-only");
const resultPath = path.join(cacheDir, "hotkey-smoke-result.json");
const timeoutMs = 25000;
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

async function readTextEditDocument() {
  return runAppleScript([
    'tell application "TextEdit"',
    "if (count of documents) is 0 then return \"\"",
    "return text of front document",
    "end tell"
  ]);
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

async function runPreflight() {
  try {
    await execFileAsync("npm", ["run", "voice:doctor"], {
      cwd: repoRoot,
      timeout: 30000
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    const detail = output ? `\n\n${output}` : "";

    throw new Error(`VoiceKit is not ready for the hotkey smoke test. Run \`npm run voice:restart\`, then try again.${detail}`);
  }

  if (!(await commandExists("say"))) {
    throw new Error("macOS command `say` is required for the hotkey smoke test.");
  }
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function writeResult(result) {
  await ensureRuntimeDirs();
  await fs.writeFile(
    resultPath,
    `${JSON.stringify(
      {
        expectedPhrase,
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

async function waitForText() {
  const normalizedExpected = normalize(expectedPhrase);
  const startedAt = Date.now();
  let lastText = "";

  while (Date.now() - startedAt < timeoutMs) {
    lastText = await readTextEditDocument();

    if (normalize(lastText).includes(normalizedExpected)) {
      return lastText;
    }

    await sleep(750);
  }

  return lastText;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Trigger smoke test is macOS-only because it uses TextEdit, System Events, and the desktop trigger.");
  }

  if (!(await commandExists("osascript"))) {
    throw new Error("macOS command `osascript` is required for the hotkey smoke test.");
  }

  console.log("Checking VoiceKit health before hotkey smoke...");
  await runPreflight();
  console.log("PASS Preflight: VoiceKit is running.");
  console.log("");

  if (preflightOnly) {
    await writeResult({
      status: "pass"
    });
    console.log("PASS Hotkey smoke preflight only");
    console.log(`PASS Result: ${resultPath}`);
    return;
  }

  if (triggerMode === "fn_hold") {
    throw new Error(
      `Automated trigger smoke only supports \`FLOW_TRIGGER_MODE=hotkey\`. The current trigger is \`${triggerLabel}\`, so use \`npm run voice:manual-check\` for the real verification flow.`
    );
  }

  await prepareTextEditDocument();

  console.log("Trigger VoiceKit smoke test");
  console.log(`Speaking through macOS say: "${expectedPhrase}"`);
  console.log(`This uses the configured trigger (${triggerLabel}). Keep speakers and microphone usable.`);
  console.log("");

  await pressHotkey();
  await sleep(1000);
  await execFileAsync("say", [expectedPhrase], {
    timeout: 15000
  });
  await sleep(500);
  await pressHotkey();

  const pastedText = await waitForText();
  const normalizedText = normalize(pastedText);
  const normalizedExpected = normalize(expectedPhrase);

  if (!normalizedText.includes(normalizedExpected)) {
    await writeResult({
      pastedText,
      status: "fail"
    });
    throw new Error(`Hotkey smoke failed. Expected TextEdit to include "${expectedPhrase}", got "${pastedText}".`);
  }

  await writeResult({
    pastedText,
    status: "pass"
  });

  console.log("PASS Hotkey smoke test");
  console.log("PASS Target app: TextEdit");
  console.log(`PASS Expected phrase: ${expectedPhrase}`);
  console.log(`PASS Pasted text: ${pastedText}`);
  console.log(`PASS Result: ${resultPath}`);
}

process.once("SIGINT", () => {
  void (async () => {
    try {
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
