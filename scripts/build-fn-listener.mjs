import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "./process-utils.mjs";

const execFileAsync = promisify(execFile);
const sourcePath = path.join(repoRoot, "apps", "desktop", "src", "fn-key-listener.m");
const outputDir = path.join(repoRoot, "apps", "desktop", "build", "bin");
const outputPath = path.join(outputDir, "voice-flow-fn-listener");
const tempDir = path.join(outputDir, ".tmp");
const requestedArchitectures = (process.env.VOICE_FLOW_FN_LISTENER_ARCHS ?? "arm64,x86_64")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function normalizeArchitecture(value) {
  if (value === "x64") {
    return "x86_64";
  }

  return value;
}

async function compileArchitecture(architecture) {
  const normalizedArchitecture = normalizeArchitecture(architecture);
  const targetPath = path.join(tempDir, `voice-flow-fn-listener-${normalizedArchitecture}`);

  await execFileAsync(
    "clang",
    [
      sourcePath,
      "-arch",
      normalizedArchitecture,
      "-fobjc-arc",
      "-framework",
      "Cocoa",
      "-framework",
      "ApplicationServices",
      "-o",
      targetPath
    ],
    {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024 * 8,
      timeout: 120000
    }
  );

  return targetPath;
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("Skipping fn listener build because this helper is macOS-only.");
    return;
  }

  await fs.mkdir(tempDir, { recursive: true });

  const builtArchitectures = [];

  for (const architecture of requestedArchitectures) {
    builtArchitectures.push(await compileArchitecture(architecture));
  }

  await fs.mkdir(outputDir, { recursive: true });

  if (builtArchitectures.length === 1) {
    await fs.copyFile(builtArchitectures[0], outputPath);
  } else {
    await execFileAsync(
      "lipo",
      ["-create", ...builtArchitectures, "-output", outputPath],
      {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024 * 8,
        timeout: 120000
      }
    );
  }

  await fs.chmod(outputPath, 0o755);
  console.log(`Built fn listener: ${outputPath}`);
}

await main();
