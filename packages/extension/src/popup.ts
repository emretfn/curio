import type { Message, Pairing, Status } from "./channel.ts";

const PAIRING_TEXT: Record<Pairing, string> = {
  none: "no",
  unconfirmed: "not confirmed: the app has not answered yet",
  paired: "yes",
  refused: "no: the app did not accept this token",
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`popup.html has no #${id}`);
  return found as T;
}

function time(at: number | null): string {
  return at === null ? "never" : new Date(at).toLocaleString();
}

function show(status: Status | undefined): void {
  if (status === undefined) return;
  element("paired").textContent = PAIRING_TEXT[status.pairing];
  element("paired").dataset.pairing = status.pairing;
  element("captured").textContent = String(status.captured);
  element("delivered").textContent = String(status.delivered);
  element("pending").textContent = String(status.pending);
  element("rejected").textContent = String(status.rejected);
  element("last-captured").textContent = time(status.lastCapturedAt);
  element("last-delivered").textContent = time(status.lastDeliveredAt);
  const error = element("last-error");
  error.hidden = status.lastError === null;
  error.textContent =
    status.lastError === null
      ? ""
      : `Last error (${time(status.lastError.at)}): ${status.lastError.message}`;
}

async function send(message: Message): Promise<void> {
  show(await chrome.runtime.sendMessage<Message, Status | undefined>(message));
}

element<HTMLFormElement>("pairing").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = element<HTMLInputElement>("token");
  if (input.value.trim() === "") return;
  void send({ type: "set-token", token: input.value }).then(() => {
    input.value = "";
  });
});
element("deliver").addEventListener("click", () => {
  void send({ type: "deliver-now" });
});

void send({ type: "get-status" });
// The popup stays open while the user scrolls in another window.
setInterval(() => void send({ type: "get-status" }), 2000);
