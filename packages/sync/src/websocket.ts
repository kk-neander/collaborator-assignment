import type { Connect, Timers } from "./client.ts";
import type { ServerMessage } from "@split-brain/protocol";

export function webSocketConnect(url: string): Connect {
  return (handlers) => {
    const ws = new WebSocket(url);
    let closed = false;
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      handlers.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (closed) return;
      closed = true;
      handlers.onClose(ev.reason || `connection closed (${ev.code})`);
    };
    ws.onerror = () => {
    };
    return {
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close: () => {
        closed = true;
        ws.close();
      },
    };
  };
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
