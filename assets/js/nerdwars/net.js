/* NerdWars online play.
 *
 * The site is static, so there is no game server. Browsers connect straight to
 * each other over WebRTC; PeerJS's public broker is used only to introduce
 * them, exactly as Bounce Bots does. Once the connections are open, nothing
 * touches a server again.
 *
 * This file is only the transport and the lobby. The interesting half lives in
 * game.js: the match runs as deterministic rollback, so all that crosses the
 * wire is which buttons were pressed on which frame, plus a periodic hash so
 * the machines can prove they still agree.
 *
 * Bounce Bots is host-authoritative -- the leader's browser decides and the
 * others ask. That is right for a turn-based puzzle and wrong for a fighting
 * game, where it would give guests visible lag on every single input. Here
 * nobody is authoritative: every machine runs the same simulation.
 *
 * TOPOLOGY. Up to four machines, wired as a star rather than a mesh: guests
 * hold one connection each, to the host, and the host repeats every guest's
 * input to the other guests. A mesh would save guests one hop on each other's
 * inputs, at the cost of six connections between four browsers and a much
 * worse story when one of them is behind a difficult NAT. The extra hop costs
 * a few frames of prediction, which rollback already exists to absorb.
 *
 * The host is the only machine that talks to everyone, which also makes the
 * hash comparison exact without broadcasting it: hash equality is transitive,
 * so if every guest agrees with the host, the guests agree with each other.
 */
(function () {
  "use strict";

  // v2: the wire format gained a sender slot and a seat roster. A v1 client
  // and a v2 client cannot play together, and would fail confusingly rather
  // than loudly, so they are simply not allowed to meet.
  var PEER_PREFIX = "trevor-nerdwars-v2-";

  /* Same engine on every machine, or no match at all.

     Rollback netcode sends buttons and nothing else: each machine derives the
     entire match from them, so two browsers on different bundles play two
     different matches from identical input. Nothing detects that early and
     nothing can reconcile it afterwards -- it showed up as one player falling
     through a floor that was solid on the other screen, losing three stocks
     on a machine where he never moved.

     A stale bundle is the ordinary way this happens: the page is cached, the
     ?v= token is cached with it, and the browser never asks for the new file.
     So the check has to be the bytes themselves, not a version anybody
     remembers to bump. */
  var MY_BUILD = (window.NerdWars && window.NerdWars.build) || "unknown";

  function buildDiffers(theirs) {
    /* Absent counts as different. A peer that sends no build at all is
       running a net.js from before this check existed, which means its page
       is older than this one by definition -- and that is precisely the
       browser-holding-a-stale-bundle case the check is for. Treating silence
       as agreement would wave through the only peer we already know is
       out of date. */
    return theirs !== MY_BUILD;
  }

  function sayRefresh(who) {
    /* The connection is about to be closed, and the drop handler has its own
       opinion about what to say. This is the more useful message of the two,
       so flag it and let the drop stay quiet. */
    state.rejected = true;
    say(who + " on a different version of the page, so a match would not be " +
        "the same game on both screens. Everyone hard-refresh " +
        "(Ctrl+Shift+R, or Cmd+Shift+R on a Mac) and try again.", "warn");
  }
  var CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  var CODE_LEN = 4;
  var MAX_SEATS = 4;
  // Starting input delay, in frames. One, not four: the engine runs rollback,
  // so it does not need delay to cover the network, and it raises this on its
  // own if a link turns out to be slow enough to need it.
  var DEFAULT_DELAY = 1;
  // How long a reserved seat may stay unanswered before the host reclaims it.
  var JOIN_TIMEOUT_MS = 15000;

  var els = {};
  var state = {
    role: null,        // 'host' | 'guest'
    peer: null,
    // Host: one entry per guest, indexed by that guest's slot (0 unused).
    // Guest: only [0] is set, and it is the connection to the host.
    conns: [],
    code: null,
    mySlot: 0,
    // The seat held in the room, as distinct from the fighter index a match
    // compacts that seat to.
    lobbySlot: null,
    myChar: "kel",
    // What the host believes is in the room. Guests receive this wholesale
    // rather than tracking it, so there is one source of truth.
    seats: [],         // [{ slot, char, here }]
    stage: "space",
    phase: "idle",     // idle | hosting | joining | lobby | playing
  };

  var lastSay = { text: "", kind: "" };

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
    /* Recorded as well as written. The room is drawn on the canvas now, so
       the engine needs the text; the DOM write stays because #nw-status is
       an aria-live region and it is the only thing on this page a screen
       reader can follow. One line of markup buys that, so it keeps it. */
    lastSay = { text: message || "", kind: kind || "" };
    if (!els.status) return;
    els.status.textContent = message || "";
    els.status.dataset.kind = kind || "";
  }

  function setPhase(phase) {
    state.phase = phase;
    if (els.panel) els.panel.dataset.phase = phase;
  }

  function charName(key) {
    if (!window.NerdWars) return key;
    var found = window.NerdWars.roster.find(function (c) { return c.key === key; });
    return found ? found.name : key;
  }

  /* ---------- seats ---------- */

  function seatFor(slot) {
    for (var i = 0; i < state.seats.length; i++) {
      if (state.seats[i].slot === slot) return state.seats[i];
    }
    return null;
  }

  /* Seats somebody is actually PLAYING from. A seat is reserved the moment a
     connection arrives -- so two people joining at once cannot be handed the
     same slot -- but it does not count as occupied until that guest's `hello`
     lands, which cannot happen before its data channel is open. Starting a
     match with an unopened channel drops the `go` on the floor and hangs
     everybody, so this gate is the thing that prevents it. */
  function occupiedSeats() {
    return state.seats.filter(function (s) { return s.here; });
  }

  /** Reserved but not yet answering: connecting, or a channel still opening. */
  function pendingSeats() {
    return state.seats.filter(function (s) { return !s.here; });
  }

  /** The lowest seat nobody is in. Host is always 0. */
  function freeSlot() {
    for (var slot = 1; slot < MAX_SEATS; slot++) {
      if (!seatFor(slot)) return slot;
    }
    return -1;
  }

  function setSeat(slot, char, here) {
    var s = seatFor(slot);
    if (!s) {
      s = { slot: slot, char: char || "kel", here: here !== false };
      state.seats.push(s);
      state.seats.sort(function (a, b) { return a.slot - b.slot; });
    } else {
      if (char) s.char = char;
      if (here !== undefined) s.here = here;
    }
    return s;
  }

  function dropSeat(slot) {
    state.seats = state.seats.filter(function (s) { return s.slot !== slot; });
  }

  /* Host only: tell everyone who is in the room and what they picked -- and
     redraw the host's own copy, which is the same information. Sending without
     redrawing left the host looking at a stale room: a guest would show itself
     seated while the host still had it as "joining", because every guest
     rerenders on the `seats` message and the host rerendered on nothing. */
  function broadcastSeats() {
    if (state.role !== "host") return;
    sendAll({
      t: "seats",
      seats: state.seats.map(function (s) {
        return { slot: s.slot, char: s.char, here: s.here };
      }),
    });
    renderLobby();
  }

  /* ---------- lobby rendering ---------- */

  function renderRoster() {
    if (!els.chars || !window.NerdWars) return;
    var roster = window.NerdWars.roster;
    els.chars.innerHTML = roster
      .map(function (c) {
        return (
          '<button class="nw-pick' +
          (c.key === state.myChar ? " is-on" : "") +
          '" type="button" data-char="' +
          c.key +
          '"><span class="nw-pick-name">' +
          c.name +
          "</span></button>"
        );
      })
      .join("");
  }

  function renderSeats() {
    if (!els.seats) return;
    var rows = [];
    for (var slot = 0; slot < MAX_SEATS; slot++) {
      var s = seatFor(slot);
      var mine = slot === state.mySlot && state.role !== null;
      var label;
      if (s && !s.here) {
        label = '<span class="nw-seat-empty">joining\u2026</span>';
      } else if (!s) {
        label = '<span class="nw-seat-empty">empty</span>';
      } else {
        label =
          '<span class="nw-seat-who">' +
          (slot === 0 ? "Host" : "Player " + (slot + 1)) +
          (mine ? " (you)" : "") +
          '</span> <span class="nw-seat-char">' +
          charName(s.char) +
          "</span>";
      }
      rows.push(
        '<li class="nw-seat' + (mine ? " is-you" : "") +
        (s && s.here ? "" : " is-empty") + '" data-slot="' + slot + '">' +
        label + "</li>"
      );
    }
    els.seats.innerHTML = rows.join("");
  }

  function renderLobby() {
    if (els.code) els.code.textContent = state.code || "----";
    renderSeats();
    if (els.start) {
      // Only the host starts, and only with somebody to fight.
      els.start.hidden = state.role !== "host";
      // Headcount alone is not enough: everyone counted has to be able to
      // receive the `go`.
      els.start.disabled = occupiedSeats().length < 2;
      if (pendingSeats().length && els.start.disabled) {
        els.start.textContent = "Waiting for players\u2026";
      }
      els.start.textContent =
        occupiedSeats().length > 2
          ? "Start " + occupiedSeats().length + "-player match"
          : "Start match";
    }
    if (els.stageRow) els.stageRow.hidden = state.role !== "host";
    renderRoster();
  }

  /* ---------- wire ---------- */

  function post(conn, msg) {
    if (conn && conn.open) {
      conn.send(JSON.parse(JSON.stringify(msg)));
    }
  }

  /** Everyone I hold a connection to. */
  function sendAll(msg) {
    for (var i = 0; i < state.conns.length; i++) post(state.conns[i], msg);
  }

  /* What game.js hands to the engine. A guest has exactly one place to put a
     packet; the host has to reach every guest. */
  function send(msg) {
    sendAll(msg);
  }

  function onData(msg, fromSlot) {
    if (!msg || typeof msg !== "object") return;

    // Anything the game understands goes straight through -- but a guest may
    // only speak for itself. Without this a guest could put somebody else's
    // slot on its packets and drive their fighter, and the resulting fight
    // would be perfectly in sync and completely wrong.
    if (msg.t === "i" || msg.t === "c") {
      if (state.role === "host" && msg.t === "i" && msg.s !== fromSlot) return;
      window.NerdWars.net.receive(msg);
      // The host is the only machine that hears every guest, so it is the one
      // that has to repeat their inputs to each other. Hashes are NOT
      // repeated: every guest compares against the host, and hash equality is
      // transitive, so that already proves the guests agree with each other.
      if (state.role === "host" && msg.t === "i") {
        for (var slot = 1; slot < MAX_SEATS; slot++) {
          if (slot === fromSlot) continue;
          post(state.conns[slot], msg);
        }
      }
      return;
    }

    // Somebody gave up their seat and left the room for good.
    if (msg.t === "part") {
      if (state.role === "host") {
        dropSeat(fromSlot);
        closeConn(fromSlot);
        broadcastSeats();
        if (window.NerdWars.net.active) sendAll({ t: "bye" });
      }
      if (window.NerdWars.net.active) window.NerdWars.net.stop("a player left");
      else renderLobby();
      return;
    }

    // "I am out of this match" -- which is what Escape sends. It ends the
    // match for everyone, but nobody loses their seat: the room stays up so
    // the same four can go again. Tearing the connection down here was a
    // regression, and a costly one, because nothing else ends a match: a KO
    // leaves netplay running, so somebody presses Escape every single time.
    if (msg.t === "bye") {
      if (state.role === "host") {
        // Guests only ever hear from the host, so without this the others
        // are left playing a match everybody else has stopped, waiting on
        // input that is never coming. Skip the sender: they said it first.
        for (var sl = 1; sl < MAX_SEATS; sl++) {
          if (sl !== fromSlot) post(state.conns[sl], { t: "bye" });
        }
      }
      // One person leaving ends the match for everybody. With two that was
      // the only possible answer; with four it is a choice, and the honest
      // one: keeping three going means every remaining machine has to delete
      // that fighter on the same simulation frame, and a disconnect is a
      // wall-clock event that each machine notices at a different moment.
      // Agreeing on that frame needs a referee, which this design does not
      // have. Better a clear ending than a silent divergence.
      if (window.NerdWars.net.active) {
        // `stop` raises 'stopped', which is what puts the message on screen.
        window.NerdWars.net.stop("a player left");
      } else {
        renderLobby();
      }
      return;
    }

    // ---- lobby ----

    if (msg.t === "full") {
      // The host is about to hang up. Say why, or it reads as a dropped link.
      say("That room is full, or a match is already running in it.", "warn");
      setPhase("idle");
      return;
    }

    if (msg.t === "badversion") {
      sayRefresh("You are");
      closeConn(fromSlot);
      setPhase("idle");
      return;
    }

    if (msg.t === "seat") {
      // First thing the host ever says, so it is the earliest possible place
      // to find out we are not the same game. Only the initial seating is a
      // handshake: the `match` variant goes to peers that already passed this
      // gate, and rejecting it there would tear down a working room.
      if (!msg.match && buildDiffers(msg.build)) {
        sayRefresh("The host is");
        closeConn(fromSlot);
        setPhase("idle");
        return;
      }
      // The host telling a guest which seat it took, or -- with `match` set --
      // which fighter it will be once empty seats are squeezed out. Only the
      // first kind changes where it sits in the room.
      state.mySlot = msg.slot;
      if (!msg.match) state.lobbySlot = msg.slot;
      renderLobby();
      return;
    }

    if (msg.t === "seats") {
      state.seats = (msg.seats || []).map(function (s) {
        return { slot: s.slot, char: s.char, here: s.here };
      });
      renderLobby();
      return;
    }

    if (msg.t === "hello") {
      // A guest announcing itself to the host. This is what turns a reserved
      // seat into an occupied one: it can only arrive on an open channel.
      if (state.role !== "host") return;
      if (buildDiffers(msg.build)) {
        // Tell them why before dropping them, or the room simply never
        // appears and they have no idea what went wrong.
        post(state.conns[fromSlot], { t: "badversion", build: MY_BUILD });
        dropSeat(fromSlot);
        closeConn(fromSlot);
        broadcastSeats();
        say("Somebody tried to join on a different version of the page and " +
            "was turned away. They need to hard-refresh.", "warn");
        renderLobby();
        return;
      }
      setSeat(fromSlot, msg.char, true);
      say(charName(msg.char) + " joined.", "good");
      broadcastSeats();
      return;
    }

    if (msg.t === "pick") {
      if (state.role === "host") {
        setSeat(fromSlot, msg.char, true);
        broadcastSeats();
      }
      return;
    }

    if (msg.t === "go") {
      // Belt and braces. The handshake above should have caught this long
      // ago, but this is the last instant at which refusing costs nothing.
      if (buildDiffers(msg.build)) {
        sayRefresh("The host is");
        closeConn(fromSlot);
        setPhase("idle");
        return;
      }
      // The host decides the pairing, so everyone starts from one source of
      // truth rather than each assembling their own idea of the match.
      beginMatch(msg.chars, msg.stage, msg.delay, state.mySlot);
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
          /* Stop the SIMULATION, not just the lobby.

             endMatch only moves the room's phase and prints a line. The
             engine kept running underneath it, which is how two machines on
             different bundles played on for three more deaths while one of
             them displayed a warning behind the canvas that nobody was
             looking at. A detector that does not stop anything is not a
             detector, it is a note. */
          state.desyncFrame = detail && detail.frame;
          if (window.NerdWars.net.active) window.NerdWars.net.stop("desync");
          else endMatch(desyncMessage());
        } else if (kind === "stopped" && state.phase === "playing") {
          var reason = detail && detail.reason;
          if (reason === "desync") {
            endMatch(desyncMessage());
          } else if (reason === "match over") {
            // The normal ending. Everybody is back in the room they were
            // already in, so this is an invitation rather than a warning.
            endMatch("Good game. Pick a fighter and go again.", "ok");
          } else {
            endMatch(reason ? "Match ended: " + reason + "." : "");
          }
        }
      },
    });
  }

  /* Almost always the same cause, so it names it: the two machines are on
     different bundles. A desync between identical builds would be a genuine
     engine bug, and the frame number is what makes that one reportable. */
  function desyncMessage() {
    return "The games fell out of step at frame " + state.desyncFrame +
      ", so the match was stopped. If this keeps happening, one of you is on " +
      "an older version of the page -- everyone hard-refresh and start again.";
  }

  function endMatch(message, kind) {
    // Back in the room, a guest is its SEAT again rather than the fighter
    // index the match compacted it to.
    if (state.role === "guest" && state.lobbySlot !== null) {
      state.mySlot = state.lobbySlot;
    }
    if (state.phase === "playing") {
      setPhase(state.conns.some(function (c) { return c && c.open; }) ? "lobby" : "idle");
    }
    if (message) say(message, kind || "warn");
    renderLobby();
  }

  /* ---------- connections ---------- */

  function closeConn(slot) {
    var conn = state.conns[slot];
    if (conn) {
      try { conn.close(); } catch (e) { /* already gone */ }
    }
    state.conns[slot] = null;
  }

  /* One connection. `slot` is the seat at the far end of it: for the host that
     is the guest's seat, for a guest it is always the host's, which is 0. */
  function attachConn(conn, slot) {
    state.conns[slot] = conn;

    conn.on("data", function (msg) { onData(msg, slot); });

    conn.on("open", function () {
      if (state.role === "host") {
        // Tell the newcomer which seat it is in, then who else is here.
        post(conn, { t: "seat", slot: slot, build: MY_BUILD });
        broadcastSeats();
      } else {
        send({ t: "hello", char: state.myChar, build: MY_BUILD });
        say("Connected.", "good");
      }
      // A channel that finishes opening DURING a match must not drag the panel
      // back to the lobby: the CSS un-hides the whole room over the top of the
      // running game.
      if (!window.NerdWars.net.active) setPhase("lobby");
      renderLobby();
    });

    var drop = function () {
      state.conns[slot] = null;
      if (state.role === "host") {
        dropSeat(slot);
        broadcastSeats();
        if (window.NerdWars.net.active) {
          // Same as an explicit `bye`: the remaining guests cannot see this
          // happen, so they have to be told.
          sendAll({ t: "bye" });
          window.NerdWars.net.stop("a player left");
          say("Somebody dropped out, so the match stopped.", "warn");
        }
        setPhase(occupiedSeats().length > 1 ? "lobby" : "hosting");
      } else {
        if (window.NerdWars.net.active) window.NerdWars.net.stop("disconnected");
        state.seats = [];
        // A version rejection has already said something far more useful,
        // and the close it triggers is the expected consequence rather than
        // news. Do not talk over it.
        if (state.rejected) state.rejected = false;
        else say("Lost the connection to the room.", "warn");
        setPhase("idle");
      }
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
    state.mySlot = 0;
    state.code = randomCode();
    state.seats = [];
    setSeat(0, state.myChar, true);
    setPhase("hosting");
    say("Creating a room…");
    renderLobby();

    var peer = new window.Peer(peerIdFor(state.code), { debug: 0 });
    state.peer = peer;

    peer.on("open", function () {
      say("Room ready.", "good");
      renderLobby();
    });

    peer.on("connection", function (conn) {
      var slot = freeSlot();
      if (slot < 0 || window.NerdWars.net.active) {
        // Full, or a match is already running. Say so rather than dropping
        // them silently on a closed socket with no explanation.
        conn.on("open", function () {
          post(conn, { t: "full" });
          setTimeout(function () { try { conn.close(); } catch (e) {} }, 250);
        });
        return;
      }
      // Reserved, not occupied: it becomes occupied when its `hello` arrives.
      // Broadcast immediately so the room shows somebody arriving rather than
      // the seat staying blank until the handshake finishes -- and so the
      // host's own panel redraws, which broadcastSeats now does.
      setSeat(slot, null, false);
      broadcastSeats();
      attachConn(conn, slot);
      // PeerJS never gives up on a connection that cannot complete ICE, so
      // without this a guest behind an awkward NAT sits in a seat forever and
      // the room reads as full to everyone else.
      setTimeout(function () {
        var s = seatFor(slot);
        if (!s || s.here) return;               // arrived, or already gone
        closeConn(slot);
        dropSeat(slot);
        broadcastSeats();
        say("Somebody could not connect and was dropped from the room.", "warn");
      }, JOIN_TIMEOUT_MS);
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
    state.seats = [];
    // Replaced by the host's `seat` message the moment the link opens.
    state.mySlot = 1;
    setPhase("joining");
    say("Looking for room " + code + "…");

    var peer = new window.Peer({ debug: 0 });
    state.peer = peer;

    peer.on("open", function () {
      var conn = peer.connect(peerIdFor(code), { reliable: true });
      attachConn(conn, 0);
      // PeerJS reports an unknown id as an error on the peer, not the
      // connection, so a wrong code surfaces there.
      setTimeout(function () {
        if (state.phase === "joining") {
          say("No room with that code. Check it — and if your friend is sure it is " +
              "right, you are both on different versions of the page: refresh and try again.",
              "warn");
          setPhase("idle");
        }
      }, 8000);
    });

    peer.on("error", function (err) {
      var type = (err && err.type) || "unknown";
      say(
        type === "peer-unavailable"
          ? "No room with that code. Check it — and if your friend is sure it is " +
            "right, you are both on different versions of the page: refresh and try again."
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
    for (var i = 0; i < MAX_SEATS; i++) closeConn(i);
    state.conns = [];
    if (state.peer) {
      try { state.peer.destroy(); } catch (e) { /* already gone */ }
    }
    state.peer = null;
    state.seats = [];
  }

  /* ---------- wiring ---------- */

  function init() {
    /* The panel used to be required, and its absence returned early -- which
       made sense when the panel WAS the lobby. The room is on the canvas
       now, so a page with no panel is the normal case and this has to wire
       up anyway. Every element below is optional from here down. */
    els.panel = $("nw-online");

    els.hostBtn = $("nw-host");
    els.joinBtn = $("nw-join");
    els.joinCode = $("nw-join-code");
    els.code = $("nw-code");
    els.status = $("nw-status");
    els.chars = $("nw-chars");
    els.stages = $("nw-stage-pick");
    els.stageRow = $("nw-stage-row");
    els.seats = $("nw-seats");
    els.start = $("nw-start");
    els.leave = $("nw-leave");

    renderRoster();
    renderStages();
    renderLobby();
    setPhase("idle");

    if (els.hostBtn) {
      els.hostBtn.addEventListener("click", function () { host(); });
    }
    if (els.joinBtn && els.joinCode) {
      els.joinBtn.addEventListener("click", function () { join(els.joinCode.value); });
      els.joinCode.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); join(els.joinCode.value); }
      });
    }

    if (els.chars) {
      els.chars.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-char]");
        if (btn) pickChar(btn.dataset.char);
      });
    }

    if (els.stages) {
      els.stages.addEventListener("change", function () {
        state.stage = els.stages.value;
      });
    }

    if (els.start) {
      els.start.addEventListener("click", function () { startMatch(); });
    }

    if (els.leave) {
      els.leave.addEventListener("click", function () { leaveRoom(); });
    }

    window.addEventListener("beforeunload", function () {
      sendAll({ t: "part" });
      teardown();
    });

    /* The room is drawn by the game, so the game needs a handle on it.
       Everything above this line is transport -- PeerJS, seats, the
       protocol -- and everything the engine does goes through here. */
    window.NerdWarsLobby = {
      host: function () { host(); },
      join: function (code) { join(code); },
      pick: pickChar,
      start: startMatch,
      leave: leaveRoom,
      setStage: function (key) { if (key) state.stage = key; },
      snapshot: snapshot,
    };
  }

  /* ---------- the room, as things you can call ----------

     These three were the bodies of three click handlers. They are functions
     now because the room moved onto the canvas: the engine draws it and
     calls these, and the DOM panel -- when a page still has one -- is just
     another caller. Nothing about the protocol changed. */

  function pickChar(key) {
    if (!key) return;
    state.myChar = key;
    if (state.role === "host") {
      setSeat(0, state.myChar, true);
      broadcastSeats();
    } else {
      send({ t: "pick", char: state.myChar });
    }
    renderLobby();
  }

  function startMatch() {
    if (state.role !== "host") return false;
    var here = occupiedSeats();
    if (here.length < 2) return false;
    // Seats are renumbered to be contiguous from zero, because the engine
    // seats fighters by array position: if player 2 left, the person in
    // seat 3 has to become fighter 2 rather than leaving a hole.
    var chars = here.map(function (s) { return s.char; });
    for (var i = 0; i < here.length; i++) {
      var conn = state.conns[here[i].slot];
      if (conn) post(conn, { t: "seat", slot: i, match: true, build: MY_BUILD });
    }
    state.mySlot = 0;
    sendAll({ t: "go", chars: chars, stage: state.stage,
             delay: DEFAULT_DELAY, build: MY_BUILD });
    beginMatch(chars, state.stage, DEFAULT_DELAY, 0);
    return true;
  }

  function leaveRoom() {
    // `part`, not `bye`: this one gives up the seat.
    sendAll({ t: "part" });
    teardown();
    setPhase("idle");
    say("Left the room.");
    renderLobby();
  }

  /* What the canvas draws the room from. A plain snapshot, rebuilt on
     demand: the engine reads it once per frame and owns no lobby state of
     its own, so there is exactly one source of truth and it is this file. */
  function snapshot() {
    var mine = state.role === "guest" && state.lobbySlot !== null
      ? state.lobbySlot : state.mySlot;
    return {
      available: peerLoaded(),
      phase: state.phase,
      role: state.role,
      code: state.code || "",
      mySlot: mine,
      myChar: state.myChar,
      stage: state.stage,
      status: lastSay.text,
      statusKind: lastSay.kind,
      seats: state.seats.map(function (seat) {
        return { slot: seat.slot, char: seat.char, here: !!seat.here,
                 you: seat.slot === mine };
      }),
      here: occupiedSeats().length,
      canStart: state.role === "host" && occupiedSeats().length >= 2,
    };
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

  // game.js is loaded first and defines window.NerdWars synchronously, but be
  // defensive: without it there is nothing to wire a lobby to.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
