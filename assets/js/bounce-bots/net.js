// Thin wrapper over PeerJS.
//
// The site is static, so there is no server to run a game on. Instead the lobby
// leader's browser is the authority and everyone else connects straight to it
// over WebRTC. PeerJS's public broker is used only to introduce peers; once a
// connection is open, traffic goes browser-to-browser.

const PEER_PREFIX = "trevor-bouncebots-v1-";

export function peerIdFor(code) {
  return PEER_PREFIX + String(code).toUpperCase();
}

function assertPeerLoaded() {
  if (typeof window === "undefined" || typeof window.Peer !== "function") {
    throw new Error("PeerJS failed to load. Check your connection and refresh.");
  }
}

// The lobby leader. Accepts inbound connections and fans state back out.
export function createHost(code, handlers = {}) {
  assertPeerLoaded();

  const peer = new window.Peer(peerIdFor(code), { debug: 0 });
  const connections = new Map(); // peerId -> DataConnection

  peer.on("open", () => handlers.onReady?.(code));

  peer.on("connection", (conn) => {
    conn.on("open", () => {
      connections.set(conn.peer, conn);
      handlers.onJoin?.(conn.peer, conn);
    });

    conn.on("data", (data) => {
      handlers.onMessage?.(conn.peer, data);
    });

    const drop = () => {
      if (connections.delete(conn.peer)) handlers.onLeave?.(conn.peer);
    };
    conn.on("close", drop);
    conn.on("error", drop);
  });

  peer.on("error", (err) => {
    // An id clash means another lobby already owns this code. The caller
    // re-rolls the code rather than failing outright.
    if (err?.type === "unavailable-id") {
      handlers.onCodeTaken?.(code);
      return;
    }
    handlers.onError?.(err);
  });

  return {
    peer,
    connections,
    broadcast(message) {
      const payload = JSON.parse(JSON.stringify(message));
      connections.forEach((conn) => {
        if (conn.open) conn.send(payload);
      });
    },
    sendTo(peerId, message) {
      const conn = connections.get(peerId);
      if (conn?.open) conn.send(JSON.parse(JSON.stringify(message)));
    },
    destroy() {
      connections.forEach((conn) => conn.close());
      connections.clear();
      peer.destroy();
    }
  };
}

// A joining player. Holds exactly one connection: to the host.
export function createClient(code, handlers = {}) {
  assertPeerLoaded();

  const peer = new window.Peer({ debug: 0 });
  let conn = null;

  peer.on("open", () => {
    conn = peer.connect(peerIdFor(code), { reliable: true });

    conn.on("open", () => handlers.onOpen?.());
    conn.on("data", (data) => handlers.onMessage?.(data));
    conn.on("close", () => handlers.onClose?.());
    conn.on("error", (err) => handlers.onError?.(err));
  });

  peer.on("error", (err) => {
    if (err?.type === "peer-unavailable") {
      handlers.onNoSuchLobby?.(code);
      return;
    }
    handlers.onError?.(err);
  });

  return {
    peer,
    send(message) {
      if (conn?.open) conn.send(JSON.parse(JSON.stringify(message)));
    },
    destroy() {
      conn?.close();
      peer.destroy();
    }
  };
}
