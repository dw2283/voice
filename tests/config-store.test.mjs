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
