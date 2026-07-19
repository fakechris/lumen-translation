import { browser } from "wxt/browser";

/**
 * Background service worker:
 * - registers context menus
 * - routes keyboard shortcut commands to the active tab's content script
 * - bridges popup/options <-> content script settings updates
 */

async function ensureContextMenus() {
  if (!browser.contextMenus) return;
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: "lumen-toggle-page",
    title: "Translate this page (Lumen)",
    contexts: ["page"],
  });
  browser.contextMenus.create({
    id: "lumen-translate-selection",
    title: "Translate selection (Lumen)",
    contexts: ["selection"],
  });
  browser.contextMenus.create({
    id: "lumen-translate-input",
    title: "Translate input box (Lumen)",
    contexts: ["editable"],
  });
}

export default defineBackground(() => {
  ensureContextMenus();

  browser.runtime.onInstalled.addListener(() => ensureContextMenus());

  const sendToActiveTab = async (message: unknown) => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) return;
    try {
      await browser.tabs.sendMessage(tab.id, message);
    } catch {
      // Content script not present (e.g. chrome:// pages); ignore.
    }
  };

  browser.commands?.onCommand.addListener((command: string) => {
    void sendToActiveTab({ type: "command", command });
  });

  browser.contextMenus?.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    const menuItem = info.menuItemId as string;
    const type =
      menuItem === "lumen-toggle-page"
        ? "toggle-translate"
        : menuItem === "lumen-translate-selection"
          ? "translate-selection"
          : menuItem === "lumen-translate-input"
            ? "translate-input"
            : null;
    if (!type) return;
    void browser.tabs.sendMessage(tab.id, { type });
  });

  // Relay settings-changed events to every content script.
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "settings-broadcast") {
      for (const tab of [message]) {
        void browser.tabs
          .query({})
          .then((tabs) =>
            Promise.all(
              tabs.map((t) =>
                t.id ? browser.tabs.sendMessage(t.id, message).catch(() => {}) : Promise.resolve(),
              ),
            ),
          );
      }
      sendResponse?.({ ok: true });
      return false;
    }
    return false;
  });
});
