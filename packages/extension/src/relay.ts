import { HOOK_EVENT, type Message } from "./channel.ts";
import { parseHookEvent } from "./protocol.ts";

// Runs in the extension's isolated world on every x.com document. It reads
// nothing from the page: it only passes on what the page hook reports, after
// checking it against the allowlist. Any script in the page can fire this
// event too, so what arrives is treated as a claim, and it carries no time:
// the service worker dates each capture itself.
window.addEventListener(HOOK_EVENT, (domEvent) => {
  try {
    const { detail } = domEvent as CustomEvent<unknown>;
    if (typeof detail !== "string") return;
    const event = parseHookEvent(JSON.parse(detail));
    if (event === undefined) return;
    const message: Message = { type: "hook-event", event };
    // Rejects when the extension was reloaded under this tab. Nothing can be
    // sent until the tab is reloaded too.
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // Not one of ours, or the extension was reloaded under this tab.
  }
});
