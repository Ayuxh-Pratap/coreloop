/**
 * Global push-to-talk: one key, anywhere in Windows, including while another app has focus. Emits "down" once
 * when the key is pressed (auto-repeat while held is ignored) and "up" when it is released.
 *
 * The key is not swallowed: other apps still see it, which is why the default is one people rarely press alone
 * (Right Ctrl).
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { uIOhook, UiohookKey } = require("uiohook-napi") as {
  uIOhook: EventEmitter & { start(): void; stop(): void };
  UiohookKey: Record<string, number>;
};

export const DEFAULT_PTT_KEY = process.env.COLOOP_PTT_KEY ?? "CtrlRight";

export function keyCode(name: string): number {
  const code = UiohookKey[name];
  if (code === undefined) {
    const known = Object.keys(UiohookKey).filter((k) => /^(Ctrl|Alt|Shift|Meta|F\d+|Insert|Pause|ScrollLock)/.test(k)).join(", ");
    throw new Error(`unknown key "${name}". Try one of: ${known}`);
  }
  return code;
}

export class PushToTalk extends EventEmitter {
  private held = false;
  private readonly code: number;
  readonly keyName: string;
  private readonly onDown = (e: { keycode: number }) => {
    if (e.keycode !== this.code || this.held) return;
    this.held = true;
    this.emit("down");
  };
  private readonly onUp = (e: { keycode: number }) => {
    if (e.keycode !== this.code || !this.held) return;
    this.held = false;
    this.emit("up");
  };

  constructor(keyName = DEFAULT_PTT_KEY) {
    super();
    this.keyName = keyName;
    this.code = keyCode(keyName);
  }

  start(): void {
    uIOhook.on("keydown", this.onDown);
    uIOhook.on("keyup", this.onUp);
    uIOhook.start();
  }

  stop(): void {
    uIOhook.off("keydown", this.onDown);
    uIOhook.off("keyup", this.onUp);
    uIOhook.stop();
  }
}
