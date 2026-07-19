import type { Settings } from "@lumen/core";

export interface SyncBackend {
  /** Stable identifier for telemetry and logging. */
  readonly id: string;
  /** Pull the latest snapshot from the server, or `null` if none exists. */
  pull(): Promise<SyncSnapshot | null>;
  /** Push a snapshot to the server. */
  push(snapshot: SyncSnapshot): Promise<void>;
  /** Verify connectivity and credentials. Returns an error message or `null`. */
  test(): Promise<string | null>;
}

export interface SyncSnapshot {
  /** Schema version. Currently 1. */
  version: 1;
  /** The user's settings payload. */
  settings: Settings;
  /** ISO 8601 timestamp of the last update. */
  updatedAt: string;
  /** Optional device identifier for debugging. */
  device?: string;
}

export interface WebDavSyncConfig {
  type: "webdav";
  url: string;
  username: string;
  password: string;
  /** Path appended to the server URL, default `/lumen-settings.json`. */
  path?: string;
}

export interface WorkerSyncConfig {
  type: "worker";
  url: string;
  token: string;
  deviceId?: string;
}

export type SyncConfig = WebDavSyncConfig | WorkerSyncConfig;
