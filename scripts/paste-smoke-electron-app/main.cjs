const { app } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

async function activateTextEdit() {
  await execFileAsync("osascript", [
    "-e",
    'tell application "TextEdit"',
    "-e",
    "activate",
    "-e",
    "end tell",
    "-e",
    'tell application "System Events"',
    "-e",
    'repeat until exists (first application process whose frontmost is true and name is "TextEdit")',
    "-e",
    "delay 0.05",
    "-e",
    "end repeat",
    "-e",
    "end tell",
    "-e",
    "delay 0.2"
  ], {
    timeout: 5000
  });
}

async function main() {
  await app.whenReady();
  const text = process.env.VOICE_FLOW_PASTE_SMOKE_TEXT ?? "";

  if (!text) {
    throw new Error("VOICE_FLOW_PASTE_SMOKE_TEXT is required.");
  }

  const { pasteText } = await import("../../apps/desktop/src/paste-text.mjs");

  await activateTextEdit();
  await pasteText(text);
}

main()
  .then(() => {
    app.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    app.exit(1);
  });
