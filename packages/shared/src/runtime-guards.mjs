import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

function isIgnorableWriteError(error) {
  return Boolean(error && typeof error === "object" && (error.code === "EIO" || error.code === "EPIPE"));
}

function toLine(value) {
  if (typeof value === "string") {
    return value;
  }

  return inspect(value, {
    breakLength: Infinity,
    depth: 4
  });
}

function wrapStreamWrite(stream, label, appendFallbackLog) {
  if (!stream?.write) {
    return;
  }

  const originalWrite = stream.write.bind(stream);

  stream.write = (chunk, encoding, callback) => {
    const hasEncoding = typeof encoding === "string";
    const nextEncoding = hasEncoding ? encoding : undefined;
    const nextCallback = typeof encoding === "function" ? encoding : callback;

    try {
      return originalWrite(chunk, nextEncoding, (error) => {
        if (isIgnorableWriteError(error)) {
          appendFallbackLog(`${label}.write`, [error]);
          nextCallback?.();
          return;
        }

        nextCallback?.(error);
      });
    } catch (error) {
      if (!isIgnorableWriteError(error)) {
        throw error;
      }

      appendFallbackLog(`${label}.write`, [error]);
      nextCallback?.();
      return false;
    }
  };
}

export function installRuntimeGuards({ logFilePath } = {}) {
  const appendFallbackLog = (label, args = []) => {
    if (!logFilePath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
      const line = `${new Date().toISOString()} [${label}] ${args.map(toLine).join(" ")}${os.EOL}`;
      fs.appendFileSync(logFilePath, line, "utf8");
    } catch {
      // Ignore secondary logging failures.
    }
  };

  wrapStreamWrite(process.stdout, "stdout", appendFallbackLog);
  wrapStreamWrite(process.stderr, "stderr", appendFallbackLog);

  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.("error", (error) => {
      if (isIgnorableWriteError(error)) {
        return;
      }

      appendFallbackLog("stdio-error", [error]);
    });
  }

  for (const methodName of ["log", "info", "warn", "error"]) {
    const originalMethod = console[methodName].bind(console);

    console[methodName] = (...args) => {
      try {
        originalMethod(...args);
      } catch (error) {
        if (!isIgnorableWriteError(error)) {
          throw error;
        }

        appendFallbackLog(`console.${methodName}`, args);
      }
    };
  }

  process.on("uncaughtExceptionMonitor", (error) => {
    if (isIgnorableWriteError(error)) {
      appendFallbackLog("uncaught-exception", [error]);
    }
  });
}
