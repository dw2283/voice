import fs from "node:fs/promises";
import path from "node:path";

const configFileName = "desktop-config.json";
const tokenFileName = "desktop-token.bin";

function defaultApiBaseUrl(env, isPackaged) {
  if (typeof env.FLOW_API_BASE_URL === "string" && env.FLOW_API_BASE_URL.trim()) {
    return sanitizeApiBaseUrl(env.FLOW_API_BASE_URL);
  }

  return isPackaged ? "" : "http://127.0.0.1:8000";
}

function defaultApiToken(env, isPackaged) {
  if (typeof env.FLOW_API_TOKEN === "string" && env.FLOW_API_TOKEN.trim()) {
    return env.FLOW_API_TOKEN.trim();
  }

  return isPackaged ? "" : "local-dev-token";
}

function buildSecureStorageMessage() {
  return "Voice Flow needs macOS secure storage before it can save an API token on this Mac.";
}

export function sanitizeApiBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

export function maskToken(token) {
  if (!token) {
    return "";
  }

  if (token.length <= 8) {
    return `${token.slice(0, 2)}••••`;
  }

  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

export function createDesktopConfigStore({ app, safeStorage, env = process.env }) {
  const userDataPath = app.getPath("userData");
  const configPath = path.join(userDataPath, configFileName);
  const tokenPath = path.join(userDataPath, tokenFileName);
  const envDefaults = {
    apiBaseUrl: defaultApiBaseUrl(env, app.isPackaged),
    apiToken: defaultApiToken(env, app.isPackaged)
  };

  const state = {
    apiBaseUrl: envDefaults.apiBaseUrl,
    apiToken: envDefaults.apiToken,
    lastError: "",
    loaded: false
  };

  function isSecureStorageAvailable() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  function getSnapshot() {
    const secureStorageAvailable = isSecureStorageAvailable();
    const apiConfigured = Boolean(state.apiBaseUrl && state.apiToken);

    return {
      apiBaseUrl: state.apiBaseUrl,
      apiConfigured,
      apiTokenMasked: maskToken(state.apiToken),
      configPath,
      hasApiToken: Boolean(state.apiToken),
      secureStorageAvailable,
      secureStorageMessage: secureStorageAvailable ? "API tokens are saved in macOS secure storage." : buildSecureStorageMessage(),
      settingsLoaded: state.loaded,
      settingsError: state.lastError
    };
  }

  async function load() {
    await fs.mkdir(userDataPath, { recursive: true });
    state.apiBaseUrl = envDefaults.apiBaseUrl;
    state.apiToken = envDefaults.apiToken;
    state.lastError = "";

    try {
      const rawConfig = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(rawConfig);

      if (typeof parsed.apiBaseUrl === "string") {
        state.apiBaseUrl = sanitizeApiBaseUrl(parsed.apiBaseUrl);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        state.lastError = `Could not read desktop config: ${error.message}`;
      }
    }

    try {
      const encryptedToken = await fs.readFile(tokenPath);

      if (!isSecureStorageAvailable()) {
        throw new Error(buildSecureStorageMessage());
      }

      state.apiToken = safeStorage.decryptString(encryptedToken).trim();
    } catch (error) {
      if (error.code !== "ENOENT") {
        state.lastError = error instanceof Error ? error.message : "Could not decrypt the saved API token.";
        state.apiToken = envDefaults.apiToken;
      }
    }

    state.loaded = true;
    return getSnapshot();
  }

  async function save({ apiBaseUrl, apiToken }) {
    const nextApiBaseUrl = sanitizeApiBaseUrl(apiBaseUrl);
    const providedApiToken = String(apiToken ?? "").trim();
    const nextApiToken = providedApiToken || state.apiToken;

    if (!nextApiBaseUrl) {
      throw new Error("API Base URL is required.");
    }

    if (!nextApiToken) {
      throw new Error("API token is required.");
    }

    if (!isSecureStorageAvailable()) {
      throw new Error(buildSecureStorageMessage());
    }

    await fs.mkdir(userDataPath, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify({ apiBaseUrl: nextApiBaseUrl }, null, 2)}\n`, "utf8");
    await fs.writeFile(tokenPath, safeStorage.encryptString(nextApiToken));

    state.apiBaseUrl = nextApiBaseUrl;
    state.apiToken = nextApiToken;
    state.lastError = "";
    state.loaded = true;

    return getSnapshot();
  }

  async function reset() {
    await fs.rm(configPath, { force: true });
    await fs.rm(tokenPath, { force: true });
    state.apiBaseUrl = envDefaults.apiBaseUrl;
    state.apiToken = envDefaults.apiToken;
    state.lastError = "";
    state.loaded = true;
    return getSnapshot();
  }

  function getApiCredentials() {
    if (!state.apiBaseUrl || !state.apiToken) {
      throw new Error("Connect your API before dictating.");
    }

    return {
      apiBaseUrl: state.apiBaseUrl,
      apiToken: state.apiToken
    };
  }

  return {
    getApiCredentials,
    getSnapshot,
    isConfigured() {
      return Boolean(state.apiBaseUrl && state.apiToken);
    },
    load,
    reset,
    save
  };
}
