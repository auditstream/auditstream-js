// Must be imported first by worker.mjs so the traps are installed before @auditstream/node
// constructs its AsyncLocalStorage instance or any module can cache prototype methods.
// Cloudflare Workers ship both enterWith() and disable() as stubs that throw.
import { AsyncLocalStorage } from "node:async_hooks";

let enterWithCalls = 0;
let disableCalls = 0;

const origEnterWith = AsyncLocalStorage.prototype.enterWith;
const origDisable = AsyncLocalStorage.prototype.disable;

AsyncLocalStorage.prototype.enterWith = function enterWith(...args) {
  enterWithCalls += 1;
  if (typeof origEnterWith === "function") {
    origEnterWith.apply(this, args);
  }
  throw new Error("AsyncLocalStorage.enterWith() is not supported on Cloudflare Workers");
};

AsyncLocalStorage.prototype.disable = function disable(...args) {
  disableCalls += 1;
  if (typeof origDisable === "function") {
    origDisable.apply(this, args);
  }
  throw new Error("AsyncLocalStorage.disable() is not supported on Cloudflare Workers");
};

export function getAlsTrapCounts() {
  return { enterWithCalls, disableCalls };
}
