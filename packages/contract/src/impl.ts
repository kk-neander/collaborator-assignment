import type { ClientMessage, ServerMessage } from "@split-brain/protocol";
import { ClientCore, ServerCore } from "@split-brain/sync";
import type { Implementation, Json } from "./index.ts";

export const impl: Implementation = {
  name: "split-brain-ot",

  createServer(env) {
    const core = new ServerCore({ store: env.store, now: env.now, seed: env.seed, timers: env.timers });
    return {
      connect: (connId, user, send) => core.connect(connId, { user, send: (msg: ServerMessage) => send(msg as unknown as Json) }),
      receive: (connId, msg) => core.receive(connId, msg),
      disconnect: (connId) => core.disconnect(connId),
      docText: (docId) => core.docText(docId),
      tree: () => core.treeNodes(),
      authorship: (docId) => core.authorship(docId),
      snapshot: () => core.snapshotAll(),
    };
  },

  createClient(env) {
    const core = new ClientCore({
      clientId: env.clientId,
      timers: env.timers,
      now: env.now,
      random: env.random,
      local: env.local,
      connect: (handlers) => {
        const link = env.connect({
          onOpen: handlers.onOpen,
          onClose: handlers.onClose,
          onMessage: (msg) => handlers.onMessage(msg as unknown as ServerMessage),
        });
        return { send: (msg: ClientMessage) => link.send(msg as unknown as Json), close: () => link.close() };
      },
    });
    return {
      start: () => core.start(),
      stop: () => core.stop(),
      open: (docId) => core.open(docId),
      isReady: (docId) => core.isReady(docId),
      text: (docId) => core.text(docId),
      insert: (docId, pos, text) => core.insert(docId, pos, text),
      delete: (docId, pos, length) => core.delete(docId, pos, length),
      replace: (docId, pos, length, text) => core.replace(docId, pos, length, text),
      undo: (docId) => core.undo(docId),
      changeTree: (change) => void core.changeTree(change),
      tree: () => core.treeNodes(),
      isSynced: () => core.isSynced(),
      stats: () => ({ droppedChars: core.stats.droppedChars, anomalies: core.stats.anomalies }),
    };
  },
};
