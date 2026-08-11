import { describe, expect, it } from 'vitest';
import { shouldUseBrowserFetch } from '../http-bridge';

describe('HTTP bridge routing', () => {
  const devPage = 'http://localhost:1421/prefs.html';
  const bundledPage = 'http://tauri.localhost/prefs.html';

  it('keeps relative and same-origin requests in the webview', () => {
    expect(shouldUseBrowserFetch('./assets/app.js', devPage)).toBe(true);
    expect(shouldUseBrowserFetch('http://localhost:1421/@vite/client', devPage)).toBe(true);
  });

  it('never routes Tauri IPC and asset URLs back through the HTTP plugin', () => {
    expect(shouldUseBrowserFetch('http://ipc.localhost/command', bundledPage)).toBe(true);
    expect(shouldUseBrowserFetch('ipc://localhost/command', bundledPage)).toBe(true);
    expect(shouldUseBrowserFetch('http://asset.localhost/icon.png', bundledPage)).toBe(true);
    expect(shouldUseBrowserFetch('asset://localhost/icon.png', bundledPage)).toBe(true);
  });

  it('routes external translation and local model endpoints through Tauri', () => {
    expect(
      shouldUseBrowserFetch('https://translate.googleapis.com/translate_a/single', devPage),
    ).toBe(false);
    expect(shouldUseBrowserFetch('http://127.0.0.1:11434/v1/chat/completions', devPage)).toBe(
      false,
    );
  });
});
