// Runs inside the pinned OpenClaw image against its real SQLite-backed stores.
// This does not establish encrypted Matrix traffic or Task continuation.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { installMatrixTestRuntime, resetMatrixTestStores } from "../../test-runtime.js";
import { resolveMatrixAuth } from "../client/config.js";
import { SqliteBackedMatrixSyncStore } from "../client/file-sync-store.js";
import { resolveMatrixStoragePaths, writeStorageMeta } from "../client/storage.js";
import { saveMatrixCredentials } from "../credentials.js";
import { readMatrixIdbSnapshotJson, writeMatrixIdbSnapshotJson } from "../crypto-state-store.js";

let home: string;
afterEach(async () => {
  await resetMatrixTestStores();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

it.each([false, true])("retains native auth, cursor and crypto snapshot at launch (clean shutdown: %s)", async (clean) => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agentteams-matrix-restart-"));
  const stateDir = path.join(home, ".openclaw");
  const auth = { homeserver: "http://127.0.0.1:6167", userId: "@worker:test",
    accessToken: "controller-token", deviceId: "EXISTING_DEVICE" };
  const cfg = { channels: { matrix: { ...auth, deviceId: undefined } } };
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  installMatrixTestRuntime({ cfg, stateDir });
  await saveMatrixCredentials(auth, env);
  const storage = await resolveMatrixStoragePaths({ ...auth, stateDir });
  await writeStorageMeta({ storagePaths: storage, ...auth });
  const seed = await SqliteBackedMatrixSyncStore.create(storage.rootDir);
  await seed.setSyncData({ next_batch: "persisted-cursor", rooms: {}, account_data: { events: [] } });
  if (clean) seed.markCleanShutdown();
  await seed.flush();
  const snapshot = JSON.stringify({ fixture: "native-snapshot-preserved" });
  await writeMatrixIdbSnapshotJson({ storageRootDir: storage.rootDir, snapshotJson: snapshot, databaseCount: 1 });
  await resetMatrixTestStores();

  const configPath = path.join(home, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(cfg));
  const source = fs.readFileSync("/opt/agentteams/scripts/worker-entrypoint.sh", "utf8");
  const preamble = source.split('log "Starting Worker Agent: ${WORKER_NAME}"')[1]
    .split("# Materialize the selected Harness")[0];
  execFileSync("bash", ["-ec", 'log() { :; }; mc() { exit 91; }; curl() { exit 92; };\n' + preamble], {
    env: { ...env, HOME: home, WORKSPACE: home, WORKER_CONFIG: configPath, WORKER_NAME: "worker",
      AGENTTEAMS_STORAGE_PREFIX: "fixture/storage" },
  });

  installMatrixTestRuntime({ cfg, stateDir });
  const restored = await resolveMatrixAuth({ cfg, env });
  expect(restored.accessToken).toBe(auth.accessToken);
  expect(restored.deviceId).toBe(auth.deviceId);
  const resumedStorage = await resolveMatrixStoragePaths({ ...restored, stateDir });
  expect(resumedStorage.rootDir).toBe(storage.rootDir);
  const resumed = await SqliteBackedMatrixSyncStore.create(resumedStorage.rootDir);
  expect(await resumed.getSavedSyncToken()).toBe("persisted-cursor");
  expect(resumed.hasSavedSyncFromCleanShutdown()).toBe(clean);
  expect(await readMatrixIdbSnapshotJson(resumedStorage.rootDir)).toBe(snapshot);
  expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(cfg);

  // A different confirmed device must never inherit this device's crypto/cursor.
  const other = await resolveMatrixStoragePaths({ ...auth, stateDir,
    accessToken: "rotated-token", deviceId: "DIFFERENT_DEVICE" });
  expect(other.rootDir).not.toBe(storage.rootDir);
  expect(await (await SqliteBackedMatrixSyncStore.create(other.rootDir)).getSavedSyncToken()).toBeNull();
  expect(await resumed.getSavedSyncToken()).toBe("persisted-cursor");
});
