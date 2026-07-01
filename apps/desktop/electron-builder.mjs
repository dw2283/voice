import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const desktopPackageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

export default {
  appId: "com.dw2283.voicekit",
  productName: "VoiceKit",
  artifactName: "${productName}-${version}-${arch}.${ext}",
  directories: {
    buildResources: path.join(__dirname, "buildResources"),
    output: path.join(__dirname, "dist")
  },
  files: [
    "apps/desktop/src/**/*",
    "packages/shared/src/**/*",
    "package.json"
  ],
  extraResources: [
    {
      from: path.join(__dirname, "build", "bin"),
      to: "bin",
      filter: ["voice-flow-fn-listener"]
    }
  ],
  extraMetadata: {
    main: "apps/desktop/src/main.mjs",
    name: "voicekit",
    productName: "VoiceKit",
    version: desktopPackageJson.version
  },
  publish: [
    {
      provider: "github",
      owner: "dw2283",
      repo: "voice",
      releaseType: "prerelease"
    }
  ],
  generateUpdatesFilesForAllChannels: true,
  detectUpdateChannel: true,
  afterSign: path.join(repoRoot, "scripts", "notarize.mjs"),
  mac: {
    binaries: [path.join(repoRoot, "apps", "desktop", "build", "bin", "voice-flow-fn-listener")],
    category: "public.app-category.productivity",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    target: [
      {
        target: "dmg",
        arch: ["arm64"]
      },
      {
        target: "zip",
        arch: ["arm64"]
      }
    ],
    entitlements: path.join(__dirname, "entitlements.mac.plist"),
    entitlementsInherit: path.join(__dirname, "entitlements.mac.plist"),
    extendInfo: {
      NSMicrophoneUsageDescription: "VoiceKit records short dictation clips so it can transcribe and paste them."
    }
  }
};
