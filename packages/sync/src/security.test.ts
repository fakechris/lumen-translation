import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "@lumen/core";
import type { Settings } from "@lumen/core";
import { redactSecrets, restoreSecrets } from "./snapshot.js";
import { validateRemoteUrl } from "./url-guard.js";

function asObject(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  return value as Record<string, unknown>;
}

describe("redactSecrets", () => {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    engines: {
      openai: {
        apiKey: "sk-local",
        token: "tok-local",
        secret: "shh",
        password: "pw",
        model: "gpt-4",
        endpoint: "https://api.openai.com",
        nested: { secret: "deep-secret", apiKey: "deep-key", keep: "yes" },
      },
      __sync__: {
        type: "webdav",
        url: "https://dav.example.com/lumen",
        username: "u",
        webdavPass: "dav-pw",
        workerToken: "wt-123",
      },
    },
    glossary: [{ source: "hello", target: "你好" }],
    rules: [{ match: "*.x.com", targetLang: "ja" }],
  };

  const redacted = redactSecrets(settings);

  it("strips secret fields from engine config", () => {
    const openai = asObject(asObject(redacted.engines).openai);
    expect(openai.apiKey).toBeUndefined();
    expect(openai.token).toBeUndefined();
    expect(openai.secret).toBeUndefined();
    expect(openai.password).toBeUndefined();
  });

  it("strips secret fields from __sync__ config", () => {
    const sync = asObject(asObject(redacted.engines).__sync__);
    expect(sync.webdavPass).toBeUndefined();
    expect(sync.workerToken).toBeUndefined();
  });

  it("strips secrets from deeply nested objects", () => {
    const openai = asObject(asObject(redacted.engines).openai);
    const nested = asObject(openai.nested);
    expect(nested.secret).toBeUndefined();
    expect(nested.apiKey).toBeUndefined();
    expect(nested.keep).toBe("yes");
  });

  it("preserves non-secret fields", () => {
    const openai = asObject(asObject(redacted.engines).openai);
    expect(openai.model).toBe("gpt-4");
    expect(openai.endpoint).toBe("https://api.openai.com");
    const sync = asObject(asObject(redacted.engines).__sync__);
    expect(sync.url).toBe("https://dav.example.com/lumen");
    expect(sync.username).toBe("u");
    expect(redacted.rules).toEqual(settings.rules);
    expect(redacted.glossary).toEqual(settings.glossary);
  });

  it("does not mutate the original settings", () => {
    const openai = asObject(asObject(settings.engines).openai);
    expect(openai.apiKey).toBe("sk-local");
  });
});

describe("restoreSecrets", () => {
  it("keeps the local device's secrets when the remote copy is redacted", () => {
    const local: Settings = {
      ...DEFAULT_SETTINGS,
      engines: {
        openai: { apiKey: "sk-local", model: "gpt-4" },
        __sync__: { url: "https://dav.example.com", webdavPass: "dav-pw" },
      },
    };
    // Remote is what comes back from the server: redacted, no secrets.
    const remote = redactSecrets(local);

    const restored = restoreSecrets(remote, local);

    const openai = asObject(asObject(restored.engines).openai);
    expect(openai.apiKey).toBe("sk-local");
    expect(openai.model).toBe("gpt-4");
    const sync = asObject(asObject(restored.engines).__sync__);
    expect(sync.webdavPass).toBe("dav-pw");
  });

  it("does not overwrite a local secret with a missing remote value", () => {
    const local: Settings = {
      ...DEFAULT_SETTINGS,
      engines: { openai: { apiKey: "sk-local" } },
    };
    const remote: Settings = {
      ...DEFAULT_SETTINGS,
      engines: { openai: { model: "gpt-4" } },
    };

    const restored = restoreSecrets(remote, local);

    const openai = asObject(asObject(restored.engines).openai);
    expect(openai.apiKey).toBe("sk-local");
  });
});

describe("validateRemoteUrl", () => {
  it("allows public https endpoints", () => {
    expect(validateRemoteUrl("https://dav.example.com/lumen")).toBeNull();
    expect(validateRemoteUrl("https://1.1.1.1")).toBeNull();
  });

  it("blocks loopback and localhost aliases", () => {
    expect(validateRemoteUrl("http://localhost")).not.toBeNull();
    expect(validateRemoteUrl("http://127.0.0.1")).not.toBeNull();
    expect(validateRemoteUrl("http://sub.localhost")).not.toBeNull();
  });

  it("blocks private / link-local IPv4 ranges", () => {
    expect(validateRemoteUrl("http://10.0.0.1")).not.toBeNull();
    expect(validateRemoteUrl("http://172.16.0.1")).not.toBeNull();
    expect(validateRemoteUrl("http://192.168.1.1")).not.toBeNull();
    expect(validateRemoteUrl("http://169.254.1.1")).not.toBeNull();
    expect(validateRemoteUrl("http://0.0.0.0")).not.toBeNull();
  });

  it("blocks IPv6 loopback / unique-local / mapped addresses", () => {
    expect(validateRemoteUrl("http://[::1]")).not.toBeNull();
    expect(validateRemoteUrl("http://[fc00::1]")).not.toBeNull();
    expect(validateRemoteUrl("http://[::ffff:127.0.0.1]")).not.toBeNull();
    expect(validateRemoteUrl("http://[::ffff:192.168.0.1]")).not.toBeNull();
  });

  it("blocks numeric IPv4 encoding tricks that resolve to private ranges", () => {
    expect(validateRemoteUrl("http://2130706433")).not.toBeNull(); // decimal 127.0.0.1
    expect(validateRemoteUrl("http://0x7f000001")).not.toBeNull(); // hex 127.0.0.1
    expect(validateRemoteUrl("http://0177.0.0.1")).not.toBeNull(); // octal 127.0.0.1
  });

  it("rejects non-http(s) schemes", () => {
    expect(validateRemoteUrl("file:///etc/passwd")).not.toBeNull();
    expect(validateRemoteUrl("ftp://dav.example.com")).not.toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(validateRemoteUrl("not a url")).not.toBeNull();
  });
});
