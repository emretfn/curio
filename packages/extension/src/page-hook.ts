import { HOOK_EVENT } from "./channel.ts";
import { installHook } from "./hook.ts";

// Runs in the page's own JavaScript world, on every x.com document, before
// any of X's scripts. Events go to the relay content script as text, the only
// value that crosses between the two worlds unchanged.

// Taken now, so reporting does not run through anything the page replaces
// later.
const { dispatchEvent } = EventTarget.prototype;
const { stringify } = JSON;
const HookCustomEvent = CustomEvent;
const { apply } = Reflect;

installHook(window, (event) => {
  apply(dispatchEvent, window, [
    new HookCustomEvent(HOOK_EVENT, { detail: stringify(event) }),
  ]);
});
