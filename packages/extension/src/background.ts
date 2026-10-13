import type { Message, Status } from "./channel.ts";
import { parseHookEvent } from "./protocol.ts";
import { createCaptureQueue } from "./queue.ts";

const RETRY_ALARM = "retry-delivery";
const X_ORIGIN = "https://x.com";

// Captures and the pairing token are for extension pages and this worker
// only. Content scripts, which run inside x.com tabs, get no access.
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

const queue = createCaptureQueue({
  storage: {
    get: async (key) => (await chrome.storage.local.get(key))[key],
    set: (items) => chrome.storage.local.set(items),
    remove: (key) => chrome.storage.local.remove(key),
    keys: () => chrome.storage.local.getKeys(),
  },
  fetch: (input, init) => fetch(input, init),
  // This worker's clock. Capture times come from here and nowhere else.
  now: () => Date.now(),
});

// The alarm is what gets waiting captures delivered when nothing else wakes
// this worker: Chrome may stop it at any moment, mid-delivery included, and
// an alarm outlives it. So the alarm exists whenever captures are waiting,
// from the moment the first is queued, and is not left to the end of a
// delivery. Decisions run one at a time, each on the queue as it then is.
let alarmTurn: Promise<unknown> = Promise.resolve();
function syncRetryAlarm(): Promise<void> {
  const turn = alarmTurn.then(async () => {
    const { pending } = await queue.status();
    if (pending === 0) {
      await chrome.alarms.clear(RETRY_ALARM);
    } else if ((await chrome.alarms.get(RETRY_ALARM)) === undefined) {
      await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    }
  });
  alarmTurn = turn.catch(() => {});
  return turn;
}

async function deliver(options?: { retryRejected?: boolean }): Promise<Status> {
  const status = await queue.deliver(options);
  await syncRetryAlarm();
  return status;
}

/** Picks up whatever an earlier run of this worker left waiting. */
async function resume(): Promise<void> {
  await syncRetryAlarm();
  if ((await queue.status()).pending > 0) await deliver();
}

function isFromXPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.tab !== undefined && sender.origin === X_ORIGIN;
}

function isFromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.origin === `chrome-extension://${chrome.runtime.id}`;
}

async function handle(
  message: Message,
  sender: chrome.runtime.MessageSender,
): Promise<Status | undefined> {
  if (message.type === "hook-event") {
    if (!isFromXPage(sender)) return undefined;
    // Checked again here: this worker trusts no other part of the extension
    // to have applied the allowlist. Whatever time the event claims is
    // dropped; the queue dates the capture by this worker's clock.
    const event = parseHookEvent(message.event);
    if (event?.kind === "capture") {
      await queue.enqueue(event.capture);
      await syncRetryAlarm();
      return deliver();
    }
    if (event?.kind === "problem") await queue.noteProblem(event.problem);
    return undefined;
  }
  // Everything else is the popup's to ask, not a web page's content script.
  if (!isFromExtensionPage(sender)) return undefined;
  switch (message.type) {
    case "set-token": {
      const status = await queue.pair(message.token);
      await syncRetryAlarm();
      return status;
    }
    case "check-pairing": {
      const status = await queue.checkPairing();
      await syncRetryAlarm();
      return status;
    }
    case "deliver-now":
      return deliver({ retryRejected: true });
    case "get-status":
      return queue.status();
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message: Message, sender, respond) => {
  // Only this extension's own pages and content scripts are listened to.
  if (sender.id !== chrome.runtime.id) return false;
  handle(message, sender).then(respond, () => respond(undefined));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void deliver();
});

// Runs every time Chrome starts this worker, for whatever reason.
void resume();
