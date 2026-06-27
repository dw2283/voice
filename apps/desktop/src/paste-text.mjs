import { clipboard } from "electron";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pasteRestoreDelayMs = 900;
const pasteAutomationTimeoutMs = 5000;

function formatAutomationError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (/assistive|accessibility|not allowed|System Events/i.test(message)) {
    return "macOS blocked paste automation. Enable Accessibility for Electron in System Settings > Privacy & Security > Accessibility.";
  }

  return `Paste automation failed: ${message}`;
}

export async function pasteText(text) {
  const previousClipboard = clipboard.readText();
  clipboard.writeText(text);

  try {
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
      "-e",
      "delay 0.12"
    ], {
      timeout: pasteAutomationTimeoutMs
    });
  } catch (error) {
    throw new Error(formatAutomationError(error));
  } finally {
    await delay(pasteRestoreDelayMs);
    clipboard.writeText(previousClipboard);
  }
}
