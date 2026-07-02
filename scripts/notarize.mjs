import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { notarize } from "@electron/notarize";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const entitlementsPath = path.resolve(__dirname, "../apps/desktop/entitlements.mac.plist");

async function verifyBundleSignature(appPath) {
  try {
    await execFileAsync("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      appPath
    ]);
    return true;
  } catch {
    return false;
  }
}

async function adHocSignBundle(appPath) {
  console.log(`Applying ad-hoc macOS signature to ${path.basename(appPath)} for unsigned beta distribution...`);

  await execFileAsync("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--entitlements",
    entitlementsPath,
    appPath
  ]);

  await execFileAsync("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath
  ]);
}

export default async function notarizeBuild(context) {
  if (process.platform !== "darwin") {
    return;
  }

  const { appOutDir, electronPlatformName, packager } = context;

  if (electronPlatformName !== "darwin") {
    return;
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const signatureValid = await verifyBundleSignature(appPath);

  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    if (!signatureValid) {
      await adHocSignBundle(appPath);
    }

    console.log("Skipping notarization because Apple notarization credentials are not configured.");
    return;
  }

  if (!signatureValid) {
    throw new Error(`Expected a valid signed app bundle before notarization, but verification failed for ${appPath}.`);
  }

  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  });
}
