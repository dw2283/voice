import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getActiveContext() {
  const appNameScript = `
    tell application "System Events"
      set frontApp to first application process whose frontmost is true
      return name of frontApp
    end tell
  `;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", appNameScript]);

    return {
      platform: "macos",
      appName: stdout.trim(),
      selectedText: "",
      surroundingText: "",
      dictionaryHints: []
    };
  } catch {
    return {
      platform: "macos",
      appName: "unknown",
      selectedText: "",
      surroundingText: "",
      dictionaryHints: []
    };
  }
}
