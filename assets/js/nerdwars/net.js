/* NerdWars online play.
 *
 * The site is static, so there is no game server. Two browsers connect
 * straight to each other over WebRTC; PeerJS's public broker is used only to
 * introduce them, exactly as Bounce Bots does. Once the connection is open,
 * nothing touches a server again.
 *
 * This file is only the transport and the lobby. The interesting half lives
 * in game.js: the match runs as deterministic lockstep, so all that crosses
 * the wire is which buttons were pressed on which frame. This file hands
 * those bytes to PeerJS and hands whatever arrives back to the game.
 *
 * Bounce Bots is host-authoritative -- the leader's browser decides and the
 * others ask. That is right for a turn-based puzzle and wrong for a fighting
 * game, where it would give the guest visible lag on every single input.
 * Here neither side is authoritative: both run the same simulation.
 */
(function () {
  "use strict";

  var PEER_PREFIX = "trevor-nerdwars-v1-";
  var CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  var CODE_LEN = 4;
  var DEFAULT_DELAY = 4;

  var els = {};
  var state = {
    role: null,        // 'host' | 'guest'
    peer: null,
    conn: null,
    code: null,
    myChar: "kel",
    theirChar: null,
    stage: "space",
    ready: { me: false, them: false },
    phase: "idle",     // idle | hosting | joining | lobby | playing
  };

  function $(id) {
    return document.getElementById(id);
  }

  function randomCode() {
    var out = "";
    var bytes = new Uint32Array(CODE_LEN);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    for (var i = 0; i < CODE_LEN; i++) {
      out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    }
    return out;
  }

  function peerIdFor(code) {
    return PEER_PREFIX + String(code).toUpperCase();
  }

  function peerLoaded() {
    return typeof window.Peer === "function";
  }

  function say(message, kind) {
    if (!els.status) return;
    els.status.textContent = message || "";
    els.status.dataset.kind = kind || "";
  }

  function setPhase(phase) {
    state.phase = phase;
    if (els.panel) els.panel.dataset.phase = phase;
  }

  /* ---------- lobby rendering ---------- */

  function renderRoster() {
    if (!els.chars || !window.NerdWars) return;
    var roster = window.NerdWars.roster;
    els.chars.innerHTML = roster
      .map(function (c) {
        return (
          '<button type="button" class="nw-pick" data-char="' + c.key + '"' +
          ' style="--pick:' + c.accent + '"' +
          (c.key === state.myChar ? ' aria-pressed="true"' : ' aria-pressed="false"') +
          "><span>" + c.name + "</span></button>"
        );
      })
      .join("");
  }

  function renderStages() {
    if (!els.stages || !window.NerdWars) return;
    els.stages.innerHTML = window.NerdWars.stages
      .map(function (s) {
        return (
          '<option value="' + s.key + '"' +
          (s.key === state.stage ? " selected" : "") +
          ">" + s.name + "</option>"
        );
      })
      .join("");
  }

  function renderLobby() {
    if (els.code) els.code.textContent = state.code || "----";
    if (els.theirPick) {
      var them = state.theirChar
        ? (window.NerdWars.roster.find(function (c) { return c.key === state.theirChar; }) || {}).name
        : null;
      els.theirPick.textContent = them ? them : "still choosing";
    }
    if (els.start) {
      // Only the host starts the match, and only once both sides are here.
      els.start.hidden = state.role !== "host";
      els.start.disabled = !state.conn || !state.theirChar;
    }
    if (els.stageRow) els.stageRow.hidden = state.role !== "host";
    renderRoster();
  }

  /* ---------- wire protocol (lobby only; the match speaks for itself) ---------- */

  function send(msg) {
    if (state.conn && state.conn.open) {
      state.conn.send(JSON.parse(JSON.stringify(msg)));
    }
  }

  function onData(msg) {
    if (!msg || typeof msg !== "object") return;

    // Anything the game understands goes straight through untouched.
    if (msg.t === "i" || msg.t === "c" || msg.t === "bye") {
      window.NerdWars.net.receive(msg);
      if (msg.t === "bye") endMatch("Your opponent left.");
      return;
    }

    if (msg.t === "pick") {
      state.theirChar = msg.char;
      renderLobby();
      return;
    }

    if (msg.t === "hello") {
      state.theirChar = msg.char;
      send({ t: "pick", char: state.myChar });
      say("Opponent connected.", "good");
      renderLobby();
      return;
    }

    if (msg.t === "go") {
      // The host decides the pairing, so both sides start from one source of
      // truth rather than each assembling their own idea of the match.
      beginMatch(msg.chars, msg.stage, msg.delay, 1);
      return;
    }
  }

  /* ---------- match ---------- */

  function beginMatch(chars, stage, delay, localSlot) {
    setPhase("playing");
    say("");
    window.NerdWars.net.start({
      localSlot: localSlot,
      chars: chars,
      stage: stage,
      delay: delay || DEFAULT_DELAY,
      send: send,
      onEvent: function (kind, detail) {
        if (kind === "desync") {
          endMatch(
            "The two games fell out of step at frame " + detail.frame +
              ", so the match was stopped."
          );
        } else if (kind === "stopped" && state.phase === "playing") {
          endMatch(detail && detail.reason ? "Match ended: " + detail.reason + "." : "");
        }
      },
    });
  }

  function endMatch(message) {
    if (state.phase === "playing") setPhase(state.conn ? "lobby" : "idle");
    if (message) say(message, "warn");
    renderLobby();
  }

  /* ---------- connection ---------- */

  function attachConn(conn, isHost) {
    state.conn = conn;
    conn.on("data", onData);
    conn.on("open", function () {
      if (!isHost) send({ t: "hello", char: state.myChar });
      say("Connected.", "good");
      setPhase("lobby");
      renderLobby();
    });
    var drop = function () {
      state.conn = null;
      state.theirChar = null;
      if (window.NerdWars.net.active) window.NerdWars.net.stop("disconnected");
      say("Opponent disconnected.", "warn");
      setPhase(state.role === "host" ? "hosting" : "idle");
      renderLobby();
    };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  function host() {
    if (!peerLoaded()) {
      say("Could not reach the matchmaking service. Check your connection and refresh.", "warn");
      return;
    }
    teardown();
    state.role = "host";
    state.code = randomCode();
    setPhase("hosting");
    say("Creating a room…");
    renderLobby();

    var peer = new window.Peer(peerIdFor(state.code), { debug: 0 });
    state.peer = peer;

    peer.on("open", function () {
      say("Room ready. Send the code to your friend.", "good");
      renderLobby();
    });
    peer.on("connection", function (conn) {
      if (state.conn) {
        // One opponent at a time; the game is 1v1.
        conn.on("open", function () { conn.close(); });
        return;
      }
      attachConn(conn, true);
    });
    peer.on("error", function (err) {
      if (err && err.type === "unavailable-id") {
        // That code is already someone else's room. Take another one.
        host();
        return;
      }
      say("Connection problem: " + ((err && err.type) || "unknown") + ".", "warn");
    });
  }

  function join(rawCode) {
    var code = String(rawCode || "").trim().toUpperCase();
    if (code.length !== CODE_LEN) {
      say("A room code is " + CODE_LEN + " characters.", "warn");
      return;
    }
    if (!peerLoaded()) {
      say("Could not reach the matchmaking service. Check your connection and refresh.", "warn");
      return;
    }
    teardown();
    state.role = "guest";
    state.code = code;
    setPhase("joining");
    say("Looking for room " + code + "…");

    var peer = new window.Peer({ debug: 0 });
    state.peer = peer;

    peer.on("open", function () {
      var conn = peer.connect(peerIdFor(code), { reliable: true });
      attachConn(conn, false);
      // PeerJS reports an unknown id as an error on the peer, not the
      // connection, so a wrong code surfaces there.
      setTimeout(function () {
        if (state.phase === "joining") {
          say("No room with that code. Check it and try again.", "warn");
          setPhase("idle");
        }
      }, 8000);
    });
    peer.on("error", function (err) {
      var type = (err && err.type) || "unknown";
      say(
        type === "peer-unavailable"
          ? "No room with that code. Check it and try again."
          : "Connection problem: " + type + ".",
        "warn"
      );
      setPhase("idle");
    });
  }

  function teardown() {
    if (window.NerdWars && window.NerdWars.net.active) {
      window.NerdWars.net.stop("closed");
    }
    if (state.conn) {
      try { state.conn.close(); } catch (e) { /* already gone */ }
    }
    if (state.peer) {
      try { state.peer.destroy(); } catch (e) { /* already gone */ }
    }
    state.conn = null;
    state.peer = null;
    state.theirChar = null;
  }

  /* ---------- wiring ---------- */

  function init() {
    els.panel = $("nw-online");
    if (!els.panel) return;

    els.hostBtn = $("nw-host");
    els.joinBtn = $("nw-join");
    els.joinCode = $("nw-join-code");
    els.code = $("nw-code");
    els.status = $("nw-status");
    els.chars = $("nw-chars");
    els.stages = $("nw-stage-pick");
    els.stageRow = $("nw-stage-row");
    els.theirPick = $("nw-their-pick");
    els.start = $("nw-start");
    els.leave = $("nw-leave");

    renderRoster();
    renderStages();
    renderLobby();
    setPhase("idle");

    els.hostBtn.addEventListener("click", function () { host(); });
    els.joinBtn.addEventListener("click", function () { join(els.joinCode.value); });
    els.joinCode.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); join(els.joinCode.value); }
    });

    els.chars.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-char]");
      if (!btn) return;
      state.myChar = btn.dataset.char;
      send({ t: "pick", char: state.myChar });
      renderLobby();
    });

    els.stages.addEventListener("change", function () {
      state.stage = els.stages.value;
    });

    els.start.addEventListener("click", function () {
      if (state.role !== "host" || !state.conn || !state.theirChar) return;
      var chars = [state.myChar, state.theirChar];
      send({ t: "go", chars: chars, stage: state.stage, delay: DEFAULT_DELAY });
      beginMatch(chars, state.stage, DEFAULT_DELAY, 0);
    });

    els.leave.addEventListener("click", function () {
      send({ t: "bye" });
      teardown();
      setPhase("idle");
      say("Left the room.");
      renderLobby();
    });

    window.addEventListener("beforeunload", function () {
      send({ t: "bye" });
      teardown();
    });
  }

  // game.js is loaded first and defines window.NerdWars synchronously, but be
  // defensive: without it there is nothing to wire a lobby to.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
