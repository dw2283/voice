import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "./process-utils.mjs";

const execFileAsync = promisify(execFile);

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
}

async function readAndCloseTextEditDocument() {
  return runAppleScript([
    'tell application "TextEdit"',
    "set pastedText to text of front document",
    "close front document saving no",
    "return pastedText",
    "end tell"
  ]);
}

async function runElectronPaste(text) {
  const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");
  const helperPath = path.join(repoRoot, "scripts", "paste-smoke-electron-app");

  await fs.access(electronBin);
  try {
    await execFileAsync(electronBin, [helperPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        VOICE_FLOW_PASTE_SMOKE_TEXT: text
      },
      timeout: 20000
    });
  } catch (error) {
    const stderr = error.stderr ? `\n${error.stderr}` : "";
    const stdout = error.stdout ? `\n${error.stdout}` : "";
    throw new Error(`Electron paste helper failed.${stdout}${stderr || ` ${error.message}`}`);
  }
}

if (process.platform !== "darwin") {
  throw new Error("Paste smoke test is macOS-only because paste-back uses osascript and System Events.");
}

if (!(await commandExists("osascript"))) {
  throw new Error("macOS command `osascript` is required for the paste smoke test.");
}

const marker = `VoiceKit paste smoke ${new Date().toISOString()}`;

await prepareTextEditDocument();

try {
  await runElectronPaste(marker);
  const pastedText = await readAndCloseTextEditDocument();

  if (!pastedText.includes(marker)) {
    throw new Error(`Paste smoke test failed. Expected TextEdit to contain "${marker}", got "${pastedText}".`);
  }

  console.log("PASS Paste-back smoke test");
  console.log(`PASS Target app: TextEdit`);
  console.log(`PASS Pasted text: ${marker}`);
} catch (error) {
  try {
    await readAndCloseTextEditDocument();
  } catch {
    // Best-effort cleanup: do not mask the original paste failure.
  }

  throw error;
}
