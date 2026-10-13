import type { Message, Status } from "./channel.ts";
import { type Activity, ago, type Prose, viewOf } from "./popup-view.ts";

/**
 * Draws what `viewOf` says. This file decides nothing about what a status
 * means: it asks the service worker, hands the answer to `viewOf`, and puts
 * the result on the page. It talks to the worker and to nothing else.
 */

/** Often enough that a count is seen to go up while the user scrolls X in another window. */
const POLL_MS = 1000;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`popup.html has no #${id}`);
  return found as T;
}

let status: Status | undefined | "loading" = "loading";
let activity: Activity | null = null;
/** The token field takes the keyboard once, when the popup opens onto it. */
let offeredFocus = false;

/**
 * Text is written only when it differs. The popup is redrawn every second,
 * and a region that is rewritten is a region read out again.
 */
function write(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function writeProse(node: HTMLElement, prose: Prose): void {
  const key = JSON.stringify(prose);
  if (node.dataset.prose === key) return;
  node.dataset.prose = key;
  node.replaceChildren(
    ...prose.map((part) => {
      if (typeof part === "string") return part;
      const code = document.createElement("code");
      code.textContent = part.code;
      return code;
    }),
  );
}

function writeSteps(list: HTMLElement, steps: readonly Prose[]): void {
  list.hidden = steps.length === 0;
  const key = JSON.stringify(steps);
  if (list.dataset.prose === key) return;
  list.dataset.prose = key;
  list.replaceChildren(
    ...steps.map((step) => {
      const item = document.createElement("li");
      const text = document.createElement("span");
      writeProse(text, step);
      item.append(text);
      return item;
    }),
  );
}

function writeTime(node: HTMLElement, at: number, now: number): void {
  const time = node as HTMLTimeElement;
  write(time, ago(at, now));
  const exact = new Date(at);
  if (time.dateTime !== exact.toISOString()) {
    time.dateTime = exact.toISOString();
    time.title = exact.toLocaleString();
  }
}

/** A button that is busy stays focusable, says what it is doing, and does nothing. */
function setBusy(
  button: HTMLElement,
  label: HTMLElement,
  text: string,
  busy: boolean,
  blocked: boolean,
): void {
  write(label, text);
  button.toggleAttribute("data-busy", busy);
  button.setAttribute("aria-disabled", String(blocked));
}

function draw(): void {
  const now = Date.now();
  const view = viewOf(status, activity, now);
  const known = status !== "loading" && status !== undefined ? status : null;

  const main = element("status");
  main.dataset.state = view.state;
  main.dataset.tone = view.tone;
  if (known === null) delete main.dataset.pairing;
  else main.dataset.pairing = known.pairing;

  for (const icon of main.querySelectorAll<HTMLElement>("[data-icon]")) {
    icon.toggleAttribute("hidden", icon.dataset.icon !== view.icon);
  }
  write(element("title"), view.title);
  writeProse(element("detail"), view.detail);
  writeSteps(element("steps"), view.steps);

  // The token field: out in the open where pairing is the thing to do,
  // folded away where a token is already saved.
  const form = element("pairing");
  const open = element("pairing-open");
  const fold = element<HTMLDetailsElement>("pairing-fold");
  const home = view.tokenField === "open" ? open : element("pairing-folded");
  if (form.parentElement !== home) {
    home.append(form);
    fold.open = false;
  }
  open.hidden = view.tokenField !== "open";
  fold.hidden = view.tokenField !== "folded";
  element<HTMLInputElement>("token").readOnly = activity === "pairing";
  setBusy(
    element("pair"),
    element("pair-label"),
    activity === "pairing" ? "Pairing…" : "Pair",
    activity === "pairing",
    activity !== null,
  );

  // The state's own action. It is the main one unless the token field is.
  const action = element("action");
  action.hidden = view.action === null;
  if (view.action !== null) {
    const busy =
      (view.action.does === "check" && activity === "checking") ||
      (view.action.does === "send" && activity === "sending");
    action.dataset.does = view.action.does;
    action.dataset.variant = view.tokenField === "open" ? "outline" : "primary";
    setBusy(
      action,
      element("action-label"),
      busy ? view.action.busy : view.action.label,
      busy,
      activity !== null,
    );
  }

  element("counts").hidden = !view.counts || known === null;
  if (known !== null) {
    write(element("captured"), String(known.captured));
    write(element("delivered"), String(known.delivered));
    write(element("pending"), String(known.pending));
    write(element("rejected"), String(known.rejected));
    element("rejected-cell").hidden = known.rejected === 0;

    const { lastCapturedAt, lastDeliveredAt } = known;
    element("times").hidden =
      lastCapturedAt === null && lastDeliveredAt === null;
    element("last-captured-line").hidden = lastCapturedAt === null;
    element("last-delivered-line").hidden = lastDeliveredAt === null;
    if (lastCapturedAt !== null) {
      writeTime(element("last-captured"), lastCapturedAt, now);
    }
    if (lastDeliveredAt !== null) {
      writeTime(element("last-delivered"), lastDeliveredAt, now);
    }
  }

  element("last-error").hidden = view.problem === null;
  if (view.problem !== null) {
    writeTime(element("last-error-at"), view.problem.at, now);
    write(element("last-error-message"), view.problem.message);
  }

  if (!offeredFocus && known !== null) {
    offeredFocus = true;
    if (view.tokenField === "open") element("token").focus();
  }
}

/** Asks the worker, and keeps its answer. No answer is a state of its own. */
async function ask(message: Message): Promise<void> {
  try {
    status =
      (await chrome.runtime.sendMessage<Message, Status | null>(message)) ??
      undefined;
  } catch {
    status = undefined;
  }
}

/**
 * After an action the keyboard is where it was, unless that place is gone:
 * a button the new state does not have, the field once it has folded away.
 * Then the new state's title takes it, which is also what gets read out.
 */
function keepTheKeyboard(): void {
  const active = document.activeElement;
  const gone =
    !(active instanceof HTMLElement) ||
    active === document.body ||
    active.closest("[hidden]") !== null ||
    (active.tagName !== "SUMMARY" &&
      active.closest("details:not([open])") !== null);
  if (gone) element("title").focus();
}

/** One thing at a time: a press while another is under way does nothing. */
async function act(does: Activity, message: Message): Promise<void> {
  if (activity !== null) return;
  activity = does;
  draw();
  await ask(message);
  activity = null;
  // The worker has the token now, accepted or not. It is not left on the page.
  if (does === "pairing") element<HTMLInputElement>("token").value = "";
  draw();
  keepTheKeyboard();
}

element<HTMLFormElement>("pairing").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = element<HTMLInputElement>("token");
  if (input.value.trim() === "") {
    input.focus();
    return;
  }
  void act("pairing", { type: "set-token", token: input.value });
});

element("action").addEventListener("click", () => {
  if (element("action").dataset.does === "check") {
    void act("checking", { type: "check-pairing" });
  } else {
    void act("sending", { type: "deliver-now" });
  }
});

draw();
void ask({ type: "get-status" }).then(draw);
// Also while an action is under way: pairing delivers everything that was
// waiting before it answers, and the counts should be seen to move meanwhile.
// The worker answers in the order it finishes, so a poll never overwrites a
// fresher answer with an older one.
setInterval(() => void ask({ type: "get-status" }).then(draw), POLL_MS);
