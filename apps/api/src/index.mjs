import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "./providers/index.mjs";
import { createHttpError, invalidJsonBodyError, toErrorResponse, wrapDictationRequestError } from "./http-errors.mjs";
import { assertDictationRequest } from "../../../packages/shared/src/contracts.mjs";
import { installRuntimeGuards } from "../../../packages/shared/src/runtime-guards.mjs";

const port = Number(process.env.FLOW_API_PORT ?? 8000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "../public");
const runtimeLogFilePath = path.resolve(__dirname, "../../../.cache/api.log");
const maxRequestBodyBytes = 20 * 1024 * 1024;

installRuntimeGuards({
  logFilePath: runtimeLogFilePath
});

const provider = createProvider();

if (typeof provider.warmup === "function") {
  void provider.warmup().catch((error) => {
    console.warn("Voice Flow provider warmup failed:", error instanceof Error ? error.message : error);
  });
}

function writeJson(response, statusCode, payload) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };

  if (statusCode === 204) {
    response.writeHead(statusCode, headers);
    response.end();
    return;
  }

  response.writeHead(statusCode, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function writeStatic(response, filePath, contentType) {
  const file = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType
  });
  response.end(file);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };

    const finish = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback(value);
    };

    const onData = (chunk) => {
      body += chunk;
      bodyBytes += Buffer.byteLength(chunk);

      if (bodyBytes > maxRequestBodyBytes) {
        finish(reject, createHttpError(413, "Request body too large"));
        request.destroy();
      }
    };

    const onEnd = () => {
      try {
        finish(resolve, body ? JSON.parse(body) : {});
      } catch (error) {
        finish(reject, invalidJsonBodyError());
      }
    };

    const onError = (error) => {
      finish(reject, error);
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url || !request.method) {
      writeJson(response, 400, { error: "Invalid request" });
      return;
    }

    if (request.method === "OPTIONS") {
      writeJson(response, 204, {});
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        provider: provider.name
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      await writeStatic(response, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      await writeStatic(response, path.join(publicDir, "app.js"), "text/javascript; charset=utf-8");
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/dictate") {
      const body = await readJsonBody(request);
      let dictationRequest;

      try {
        dictationRequest = assertDictationRequest(body);
      } catch (error) {
        throw wrapDictationRequestError(error);
      }

      const result = await provider.transcribeAndPolish(dictationRequest);

      writeJson(response, 200, {
        ok: true,
        result
      });
      return;
    }

    writeJson(response, 404, {
      error: "Not found"
    });
  } catch (error) {
    const { payload, statusCode } = toErrorResponse(error);
    writeJson(response, statusCode, payload);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Voice Flow API listening on http://127.0.0.1:${port}`);
});
