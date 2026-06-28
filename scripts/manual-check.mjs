import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";
import {
  buildVoiceEnv,
  cacheDir,
  ensureRuntimeDirs,
  getTriggerLabel,
  getTriggerMode,
  readEnvFile,
  repoRoot,
  sleep
} from "./process-utils.mjs";

const execFileAsync = promisify(execFile);
const expectedPhrase = "voice flow manual check";
const preflightOnly = process.argv.includes("--preflight-only");
const waitForEnter = process.argv.includes("--wait-for-enter");
const resultPath = path.join(cacheDir, "manual-check-result.json");
const timeoutMs = 90000;
const voiceEnv = buildVoiceEnv(await readEnvFile());
const triggerMode = getTriggerMode(voiceEnv);
const hotkeyLabel = getTriggerLabel({
  hotkey: voiceEnv.FLOW_HOTKEY,
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

async function readAndCloseTextEditDocument() {
  const text = await readTextEditDocument();
  await closeTextEditDocument();

  return text;
}

async function readTextEditDocument() {
  const text = await runAppleScript([
    'tell application "TextEdit"',
    "if (count of documents) is 0 then return \"\"",
    "return text of front document",
    "end tell"
  ]);

  return text;
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

async function runPreflight() {
  try {
    await execFileAsync("npm", ["run", "voice:doctor"], {
      cwd: repoRoot,
      timeout: 30000
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    const detail = output ? `\n\n${output}` : "";

    throw new Error(`Voice Flow is not ready for the manual check. Run \`npm run voice:restart\`, then try again.${detail}`);
  }
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function waitForExpectedText() {
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

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Manual full-loop check is macOS-only because it uses TextEdit and the desktop trigger flow.");
  }

  if (!(await commandExists("osascript"))) {
    throw new Error("macOS command `osascript` is required for the manual full-loop check.");
  }

  console.log("Checking Voice Flow health before opening TextEdit...");
  await runPreflight();
  console.log("PASS Preflight: Voice Flow is running.");
  console.log("");

  if (preflightOnly) {
    await writeResult({
      status: "pass"
    });
    console.log("PASS Manual check preflight only");
    console.log(`PASS Result: ${resultPath}`);
    return;
  }

  await prepareTextEditDocument();

  console.log("Manual Voice Flow full-loop check");
  console.log("");
  console.log("1. Keep the new blank TextEdit document focused.");
  if (triggerMode === "fn_hold") {
    console.log(`2. Hold ${hotkeyLabel} while you speak, then release it to stop.`);
  } else {
    console.log(`2. Press ${hotkeyLabel} once to start Voice Flow.`);
  }
  console.log(`3. Say: \"${expectedPhrase}\"`);
  console.log(triggerMode === "fn_hold" ? "4. Release fn; Voice Flow should stop and paste automatically." : "4. Pause briefly; Voice Flow should stop and paste automatically.");
  if (waitForEnter) {
    console.log("5. Return here and press Enter.");
  } else {
    console.log("5. Stay in TextEdit; this script will auto-detect the pasted text.");
    console.log(`   Timeout: ${Math.round(timeoutMs / 1000)} seconds.`);
  }
  console.log("");

  let pastedText = "";

  if (waitForEnter) {
    const readline = createInterface({ input, output });

    try {
      await readline.question("Press Enter after the polished text appears in TextEdit...");
    } finally {
      readline.close();
    }

    pastedText = await readAndCloseTextEditDocument();
  } else {
    console.log("Watching TextEdit for the expected phrase...");
    pastedText = await waitForExpectedText();
    await closeTextEditDocument();
  }

  const normalizedText = normalize(pastedText);
  const normalizedExpected = normalize(expectedPhrase);

  if (!normalizedText.includes(normalizedExpected)) {
    await writeResult({
      pastedText,
      status: "fail"
    });
    throw new Error(`Manual full-loop check failed. Expected TextEdit to include "${expectedPhrase}", got "${pastedText}".`);
  }

  await writeResult({
    pastedText,
    status: "pass"
  });

  console.log("PASS Manual full-loop check");
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
  await closeTextEditDocument();
  if (!resultWritten) {
    await writeResult({
      error: error instanceof Error ? error.message : String(error),
      status: "fail"
    });
  }
  throw error;
}
