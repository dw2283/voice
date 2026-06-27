import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  buildVoiceEnv,
  cacheDir,
  ensureRuntimeDirs,
  isVoiceProcess,
  killPid,
  listProcesses,
  logsDir,
  pidDir,
  readEnvFile,
  repoRoot,
  sleep
} from "./process-utils.mjs";

async function createLogFd(fileName) {
  await ensureRuntimeDirs();
  return fs.openSync(path.join(logsDir, fileName), "w");
}

async function writePid(name, pid) {
  await fsPromises.writeFile(path.join(pidDir, `${name}.pid`), `${pid}\n`, "utf8");
}

async function spawnDetached(name, command, args, options = {}) {
  const logFd = await createLogFd(`${name}.log`);

  try {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      detached: true,
      env: options.env,
      stdio: ["ignore", logFd, logFd]
    });

    child.unref();
    await writePid(name, child.pid);
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

async function stopExistingVoiceProcesses() {
  const currentPid = process.pid;
  const candidates = (await listProcesses()).filter((processInfo) => {
    return processInfo.pid !== currentPid && isVoiceProcess(processInfo);
  });

  for (const processInfo of candidates) {
    await killPid(processInfo.pid, "SIGTERM");
  }

  if (candidates.length > 0) {
    await sleep(900);
  }

  const remaining = (await listProcesses()).filter((processInfo) => {
    return processInfo.pid !== currentPid && isVoiceProcess(processInfo);
  });

  for (const processInfo of remaining) {
    await killPid(processInfo.pid, "SIGKILL");
  }

  return candidates.length;
}

const envFile = await readEnvFile();
const env = buildVoiceEnv(envFile);
const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");

await ensureRuntimeDirs();
await fsPromises.mkdir(cacheDir, { recursive: true });

const stoppedCount = await stopExistingVoiceProcesses();
const apiPid = await spawnDetached("api", process.execPath, ["apps/api/src/index.mjs"], {
  cwd: repoRoot,
  env
});
const desktopPid = await spawnDetached("desktop", electronBin, ["src/main.mjs"], {
  cwd: path.join(repoRoot, "apps", "desktop"),
  env
});

if (stoppedCount > 0) {
  console.log(`Stopped ${stoppedCount} stale Voice Flow process${stoppedCount === 1 ? "" : "es"}.`);
}
console.log(`Voice Flow API started: ${apiPid}`);
console.log(`Voice Flow desktop started: ${desktopPid}`);
console.log(`Logs: ${logsDir}`);
