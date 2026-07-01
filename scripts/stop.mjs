import { isVoiceProcess, killPid, listProcesses, sleep } from "./process-utils.mjs";

async function stopVoiceProcesses() {
  const currentPid = process.pid;
  const candidates = (await listProcesses()).filter((processInfo) => {
    return processInfo.pid !== currentPid && isVoiceProcess(processInfo);
  });

  if (candidates.length === 0) {
    console.log("No VoiceKit processes are running.");
    return;
  }

  for (const processInfo of candidates) {
    await killPid(processInfo.pid, "SIGTERM");
  }

  await sleep(900);

  const remaining = (await listProcesses()).filter((processInfo) => {
    return processInfo.pid !== currentPid && isVoiceProcess(processInfo);
  });

  for (const processInfo of remaining) {
    await killPid(processInfo.pid, "SIGKILL");
  }

  console.log(`Stopped ${candidates.length} VoiceKit process${candidates.length === 1 ? "" : "es"}.`);
}

await stopVoiceProcesses();
