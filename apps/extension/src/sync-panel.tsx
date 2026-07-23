import { useState } from "react";
import type { Settings } from "@lumen/core";
import { createWebDavBackend, createWorkerBackend, syncOnce, type SyncBackend } from "@lumen/sync";
import { t } from "./i18n";

interface SyncConfig {
  backend: "off" | "webdav" | "worker";
  webdavUrl?: string;
  webdavUser?: string;
  webdavPass?: string;
  webdavPath?: string;
  workerUrl?: string;
  workerToken?: string;
  deviceId?: string;
}

export function readSyncConfig(settings: Settings): SyncConfig {
  const cfg = (settings.engines.__sync__ ?? {}) as Partial<SyncConfig>;
  return { ...cfg, backend: cfg.backend ?? "off" } as SyncConfig;
}

export function SyncPanel({
  settings,
  onSyncConfigChange,
  onSettingsChange,
}: {
  settings: Settings;
  onSyncConfigChange: (cfg: SyncConfig) => void;
  onSettingsChange?: (s: Settings) => void;
}) {
  const cfg = readSyncConfig(settings);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (patch: Partial<SyncConfig>) => {
    onSyncConfigChange({ ...cfg, ...patch });
  };

  const buildBackend = (): SyncBackend | null => {
    if (cfg.backend === "webdav" && cfg.webdavUrl) {
      return createWebDavBackend({
        url: cfg.webdavUrl,
        username: cfg.webdavUser ?? "",
        password: cfg.webdavPass ?? "",
        path: cfg.webdavPath,
      });
    }
    if (cfg.backend === "worker" && cfg.workerUrl) {
      return createWorkerBackend({
        url: cfg.workerUrl,
        token: cfg.workerToken ?? "",
        deviceId: cfg.deviceId,
      });
    }
    return null;
  };

  const doSync = async () => {
    const backend = buildBackend();
    if (!backend) {
      setStatus("Pick a backend and fill in credentials first.");
      return;
    }
    setBusy(true);
    setStatus("Testing…");
    try {
      const err = await backend.test();
      if (err) {
        setStatus(`Connection test failed: ${err}`);
        return;
      }
      setStatus("Syncing…");
      const result = await syncOnce(backend, settings, {
        strategy: "merge-rules",
        device: cfg.deviceId,
      });
      // Write the merged settings back to the local store so new rules from
      // remote actually take effect locally (and broadcast to content scripts).
      onSettingsChange?.(result.after);
      setStatus(`Done (${result.direction}). Before=${result.before.rules.length} rules, after=${result.after.rules.length}.`);
    } catch (err) {
      setStatus(`Sync error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Field label="Backend">
        <select className="input" value={cfg.backend} onChange={(e) => update({ backend: e.target.value as SyncConfig["backend"] })}>
          <option value="off">Off (local only)</option>
          <option value="webdav">WebDAV</option>
          <option value="worker">Self-hosted Worker</option>
        </select>
      </Field>

      {cfg.backend === "webdav" && (
        <>
          <Field label="WebDAV URL" hint="e.g. https://dav.example.com/lumen">
            <input className="input" value={cfg.webdavUrl ?? ""} onChange={(e) => update({ webdavUrl: e.target.value })} />
          </Field>
          <div className="flex gap-2">
            <Field label="Username">
              <input className="input" value={cfg.webdavUser ?? ""} onChange={(e) => update({ webdavUser: e.target.value })} />
            </Field>
            <Field label="Password">
              <input type="password" className="input" value={cfg.webdavPass ?? ""} onChange={(e) => update({ webdavPass: e.target.value })} />
            </Field>
          </div>
          <Field label="File path" hint="Defaults to /lumen-settings.json">
            <input className="input" value={cfg.webdavPath ?? ""} placeholder="/lumen-settings.json" onChange={(e) => update({ webdavPath: e.target.value })} />
          </Field>
        </>
      )}

      {cfg.backend === "worker" && (
        <>
          <Field label="Worker URL" hint="Your self-hosted Lumen sync worker">
            <input className="input" value={cfg.workerUrl ?? ""} placeholder="https://lumen-sync.you.workers.dev" onChange={(e) => update({ workerUrl: e.target.value })} />
          </Field>
          <Field label="Bearer token">
            <input type="password" className="input" value={cfg.workerToken ?? ""} onChange={(e) => update({ workerToken: e.target.value })} />
          </Field>
          <Field label="Device id" hint="Optional label for this device.">
            <input className="input" value={cfg.deviceId ?? ""} placeholder="macbook-pro" onChange={(e) => update({ deviceId: e.target.value })} />
          </Field>
        </>
      )}

      {cfg.backend !== "off" && (
        <button
          className="lumen-btn-primary px-4 py-2 text-sm disabled:opacity-50"
          onClick={() => void doSync()}
          disabled={busy}
        >
          {busy ? '…' : 'Sync now'}
        </button>
      )}
      {status && (
        <div
          className="text-xs border rounded p-2"
          style={{
            color: 'var(--lumen-text-soft)',
            background: 'var(--lumen-surface-2)',
            borderColor: 'var(--lumen-border)',
            borderRadius: 10,
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint && (
        <div className="text-xs mt-0.5" style={{ color: 'var(--lumen-muted)' }}>
          {hint}
        </div>
      )}
    </label>
  );
}
