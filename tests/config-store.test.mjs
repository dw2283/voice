import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopConfigStore, sanitizeApiBaseUrl } from "../apps/desktop/src/config-store.mjs";

function createFakeApp(userDataPath, isPackaged = true) {
  return {
    isPackaged,
    getPath(name) {
      assert.equal(name, "userData");
      return userDataPath;
    }
  };
}

function createFakeSafeStorage({ available = true } = {}) {
  return {
    decryptString(value) {
      return Buffer.from(value).toString("utf8");
    },
    encryptString(value) {
      return Buffer.from(value, "utf8");
    },
    isEncryptionAvailable() {
      return available;
    }
  };
}

async function withTempDir(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-flow-config-store-"));

  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

test("sanitizeApiBaseUrl trims whitespace and trailing slashes", () => {
  assert.equal(sanitizeApiBaseUrl(" https://voice.example.com/// "), "https://voice.example.com");
});

test("desktop config store saves and reloads encrypted API settings", async () => {
  await withTempDir(async (tempDir) => {
    const safeStorage = createFakeSafeStorage();
    const store = createDesktopConfigStore({
      app: createFakeApp(tempDir),
      env: {},
      safeStorage
    });

    await store.load();
    const saved = await store.save({
      apiBaseUrl: "https://voice.example.com/",
      apiToken: "secret-token"
    });

    assert.equal(saved.apiBaseUrl, "https://voice.example.com");
    assert.equal(saved.apiConfigured, true);
    assert.equal(saved.apiTokenMasked, "secr••••oken");

    const reloadedStore = createDesktopConfigStore({
      app: createFakeApp(tempDir),
      env: {},
      safeStorage
    });

    const reloaded = await reloadedStore.load();

    assert.equal(reloaded.apiBaseUrl, "https://voice.example.com");
    assert.equal(reloaded.apiConfigured, true);
    assert.equal(reloaded.hasApiToken, true);
  });
});

test("desktop config store keeps the existing token when the user only updates the route", async () => {
  await withTempDir(async (tempDir) => {
    const safeStorage = createFakeSafeStorage();
    const store = createDesktopConfigStore({
      app: createFakeApp(tempDir),
      env: {},
      safeStorage
    });

    await store.load();
    await store.save({
      apiBaseUrl: "https://voice.example.com",
      apiToken: "first-token"
    });

    await store.save({
      apiBaseUrl: "https://voice-beta.example.com",
      apiToken: ""
    });

    const reloadedStore = createDesktopConfigStore({
      app: createFakeApp(tempDir),
      env: {},
      safeStorage
    });

    await reloadedStore.load();

    assert.deepEqual(reloadedStore.getApiCredentials(), {
      apiBaseUrl: "https://voice-beta.example.com",
      apiToken: "first-token"
    });
  });
});

test("desktop config store refuses to save tokens without secure storage", async () => {
  await withTempDir(async (tempDir) => {
    const store = createDesktopConfigStore({
      app: createFakeApp(tempDir),
      env: {},
      safeStorage: createFakeSafeStorage({ available: false })
    });

    await store.load();

    await assert.rejects(
      store.save({
        apiBaseUrl: "https://voice.example.com",
        apiToken: "token"
      }),
      /secure storage/i
    );
  });
});

test("desktop config store clears unreadable saved tokens and asks for re-entry", async () => {
  await withTempDir(async (tempDir) => {
    const brokenSafeStorage = {
      decryptString() {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      },
      encryptString(value) {
        return Buffer.from(value, "utf8");
      },
      isEncryptionAvailable() {
        return true;
      }
    };

    await fs.writeFile(
      path.join(tempDir, "desktop-config.json"),
      `${JSON.stringify({ apiBaseUrl: "https://voice.example.com" }, null, 2)}\n`,
      "utf8"
    );
    await fs.writeFile(path.join(tempDir, "desktop-token.bin"), Buffer.from("corrupted-token"));

    const store = createDesktopConfigStore({
      app: createFakeApp(tempDir),
      env: {},
      safeStorage: brokenSafeStorage
    });

    const loaded = await store.load();

    assert.equal(loaded.apiBaseUrl, "https://voice.example.com");
    assert.equal(loaded.hasApiToken, false);
    assert.equal(loaded.apiConfigured, false);
    assert.match(loaded.settingsError, /saved api token could not be read/i);
    await assert.rejects(fs.access(path.join(tempDir, "desktop-token.bin")));
  });
});

test("packaged desktop config store migrates existing Electron settings on first launch", async () => {
  await withTempDir(async (tempDir) => {
    const parentDir = path.join(tempDir, "Application Support");
    const legacyDir = path.join(parentDir, "Electron");
    const packagedDir = path.join(parentDir, "VoiceKit");
    const safeStorage = createFakeSafeStorage();

    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "desktop-config.json"),
      `${JSON.stringify({ apiBaseUrl: "http://127.0.0.1:8000/" }, null, 2)}\n`,
      "utf8"
    );
    await fs.writeFile(path.join(legacyDir, "desktop-token.bin"), safeStorage.encryptString("local-dev-token"));

    const store = createDesktopConfigStore({
      app: createFakeApp(packagedDir, true),
      env: {},
      safeStorage
    });

    const loaded = await store.load();

    assert.equal(loaded.apiBaseUrl, "http://127.0.0.1:8000");
    assert.equal(loaded.apiConfigured, true);
    assert.equal(loaded.hasApiToken, true);
    assert.deepEqual(store.getApiCredentials(), {
      apiBaseUrl: "http://127.0.0.1:8000",
      apiToken: "local-dev-token"
    });
  });
});
