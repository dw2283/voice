import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getActiveContext() {
  const appContextScript = `
    tell application "System Events"
      set frontApp to first application process whose frontmost is true
      set appName to name of frontApp

      try
        set windowPosition to position of front window of frontApp
        set windowSize to size of front window of frontApp
        return appName & "|" & (item 1 of windowPosition as string) & "|" & (item 2 of windowPosition as string) & "|" & (item 1 of windowSize as string) & "|" & (item 2 of windowSize as string)
      on error
        return appName & "|"
      end try
    end tell
  `;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", appContextScript]);
    const [appName = "unknown", x, y, width, height] = stdout.trim().split("|");
    const hasWindowBounds = [x, y, width, height].every((value) => value !== undefined && value !== "");

    return {
      platform: "macos",
      appName: appName.trim() || "unknown",
      selectedText: "",
      surroundingText: "",
      dictionaryHints: [],
      windowBounds: hasWindowBounds
        ? {
            x: Number(x),
            y: Number(y),
            width: Number(width),
            height: Number(height)
          }
        : null
    };
  } catch {
    return {
      platform: "macos",
      appName: "unknown",
      selectedText: "",
      surroundingText: "",
      dictionaryHints: [],
      windowBounds: null
    };
  }
}
