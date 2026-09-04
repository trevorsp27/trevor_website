/* NerdWars online, up to four machines.
 *
 * net.js had no tests at all. That was defensible while it was one connection,
 * four scalars and a two-message handshake -- you can hold that in your head.
 * It is now a seat table with joins, leaves, a room that fills up, and a host
 * that relays every guest's input to the other guests. You cannot hold that in
 * your head, and a lobby race is exactly the kind of bug that only shows up
 * with four real people in a room and is then impossible to reproduce.
 *
 * So this runs the real net.js against a fake PeerJS broker, with four
 * independent engines behind it.
 *
 * THE ORACLE. Comparing live state across machines is NOT a valid test under
 * rollback: at any instant one machine may be running on a guess for a slot
 * while another already holds the real input. Both are correct, and they
 * reconcile a few frames later. What must agree is a CONFIRMED frame -- one
 * that ran on nobody's guess -- and the engine already hashes those. Every
 * machine that hashed a given frame must have hashed it identically.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(HERE, "..", "assets", "js", "nerdwars");
const SPRITES = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
const GAME = readFileSync(path.join(JS_DIR, "game.js"), "utf8");
const NET = readFileSync(path.join(JS_DIR, "net.js"), "utf8");

/* ---------------- a fake broker, shared by the browsers in one test ------- */

let brokers = new Map();
let pending = [];
/* One-way latency, in frames. Zero while the lobby settles; raised for the
   match itself, because a zero-latency link is the one case rollback is never
   entered on -- every machine always holds real input for the frame it is
   about to run, no prediction is ever wrong, and the entire multi-peer
   reduction this change rewrote goes untested. */
let LAG = 0;
const later = (fn) => pending.push({ fn, due: LAG });

function resetWorld() {
  brokers = new Map();
  pending = [];
  LAG = 0;
}

/** Advance the wire by one frame, delivering whatever has arrived. */
function tick() {
  const ready = [];
  const keep = [];
  for (const e of pending) {
    if (--e.due <= 0) ready.push(e);
    else keep.push(e);
  }
  pending = keep;
  for (const e of ready) e.fn();
}

/** Deliver queued events until things settle. */
function flush(rounds = 60) {
  for (let r = 0; r < rounds && pending.length; r++) tick();
}

class FakeConn {
  constructor() {
    this.open = false;
    this.closed = false;
    this.handlers = {};
    this.peerEnd = null;
  }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  emit(ev, arg) { for (const fn of this.handlers[ev] || []) fn(arg); }
  send(msg) {
    if (!this.open || this.closed) return;
    const far = this.peerEnd;
    later(() => { if (far && far.open) far.emit("data", msg); });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    const far = this.peerEnd;
    later(() => {
      if (far && !far.closed) { far.closed = true; far.open = false; far.emit("close"); }
    });
    this.emit("close");
  }
}

function makeFakePeer() {
  return class FakePeer {
    constructor(id) {
      this.id = id || "anon-" + brokers.size + "-" + pending.length;
      this.handlers = {};
      if (id && brokers.has(id)) {
        later(() => this.emit("error", { type: "unavailable-id" }));
        return;
      }
      if (id) brokers.set(id, this);
      later(() => this.emit("open", this.id));
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    emit(ev, arg) { for (const fn of this.handlers[ev] || []) fn(arg); }
    connect(destId) {
      const dest = brokers.get(destId);
      const mine = new FakeConn();
      if (!dest) {
        later(() => this.emit("error", { type: "peer-unavailable" }));
        return mine;
      }
      const theirs = new FakeConn();
      mine.peerEnd = theirs;
      theirs.peerEnd = mine;
      later(() => {
        dest.emit("connection", theirs);
        mine.open = true;
        theirs.open = true;
        later(() => { theirs.emit("open"); mine.emit("open"); });
      });
      return mine;
    }
    destroy() { if (brokers.get(this.id) === this) brokers.delete(this.id); }
  };
}

/* ---------------- just enough DOM for the lobby to render into ----------- */

const LOBBY_IDS = ["nw-online", "nw-host", "nw-join", "nw-join-code", "nw-code",
  "nw-status", "nw-chars", "nw-stage-pick", "nw-stage-row", "nw-seats",
  "nw-start", "nw-leave"];

function makeEl(id) {
  return {
    id, textContent: "", innerHTML: "", value: "",
    hidden: false, disabled: false, dataset: {}, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev, e) { for (const fn of this.listeners[ev] || []) fn(e || {}); },
  };
}

function stubContext() {
  return new Proxy({}, {
    get(_t, k) {
      if (k === "createLinearGradient" || k === "createRadialGradient")
        return () => ({ addColorStop() {} });
      if (k === "measureText") return () => ({ width: 0 });
      if (k === "canvas") return { width: 0, height: 0 };
      return () => {};
    },
    set: () => true,
  });
}

function stubCanvas(w, h) {
  const el = { width: w, height: h, style: {}, getContext: stubContext,
    addEventListener() {}, toDataURL: () => "",
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }) };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

let browserSeq = 0;

/** One whole browser: game.js, net.js, a lobby to click on. */
async function browser() {
  const seed = ++browserSeq;
  const els = {};
  for (const id of LOBBY_IDS) els[id] = makeEl(id);
  const view = stubCanvas(960, 540);
  const raf = [];
  let clock = 0;
  // The engine reads the keyboard off window events, so they have to be
  // capturable or a match cannot be driven at all.
  const winListeners = new Map();
  const on = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  const fire = (type, ev) => {
    for (const fn of winListeners.get(type) || []) fn(ev);
  };

  const sb = {
    console, Math, JSON, Date, Promise, Object, Array, Map, Set, Number, String,
    Boolean, Error, DataView, ArrayBuffer, Uint8Array, Uint32Array, Float64Array,
    isNaN, parseInt, parseFloat,
    // Delays matter: net.js reclaims a seat whose channel never opens after
    // 15s, and a stub that fires everything on the next tick would evict every
    // guest the instant they connected. One tick is one frame at 60Hz.
    setTimeout: (fn, ms) => {
      pending.push({ fn, due: Math.max(1, Math.round((ms || 0) / (1000 / 60))) });
      return 0;
    },
    requestAnimationFrame: (cb) => raf.push(cb),
    innerWidth: 960, innerHeight: 540, addEventListener: on(winListeners),
    // Deterministic "randomness": the room code only has to be unique here.
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = seed * 7 + i; return a; } },
    Image: class {
      constructor() { this.complete = true; this.naturalWidth = 16; this.naturalHeight = 16; }
      set src(v) { if (this.onload) this.onload(); }
    },
    document: {
      readyState: "complete",
      getElementById: (id) => (id === "nw-canvas" || id === "game" ? view : (els[id] || null)),
      querySelector: () => null,
      createElement: () => stubCanvas(320, 180),
      addEventListener() {},
      documentElement: {},
      fullscreenElement: null,
    },
  };
  sb.window = sb;
  sb.globalThis = sb;
  sb.Peer = makeFakePeer();

  vm.createContext(sb);
  vm.runInContext(SPRITES, sb, { filename: "sprites.js" });
  vm.runInContext("var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES,UI=window.NERDWARS_ASSETS.UI;", sb);
  vm.runInContext(GAME, sb, { filename: "game.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  vm.runInContext(NET, sb, { filename: "net.js" });

  return {
    nw: sb.window.NerdWars,
    run: (code) => vm.runInContext(code, sb),
    pump(n = 1) {
      for (let i = 0; i < n; i++) {
        const due = raf.splice(0, raf.length);
        clock += 1000 / 60;
        for (const cb of due) cb(clock);
      }
    },
    // Real key events, so a match is driven the way a person drives it.
    press: (code) => fire("keydown", { code, preventDefault() {} }),
    release: (code) => fire("keyup", { code }),
    hostRoom() { els["nw-host"].fire("click"); },
    joinRoom(code) { els["nw-join-code"].value = code; els["nw-join"].fire("click"); },
    pick(char) {
      els["nw-chars"].fire("click", { target: { closest: () => ({ dataset: { char } }) } });
    },
    start() { els["nw-start"].fire("click"); },
    leave() { els["nw-leave"].fire("click"); },
    startDisabled: () => els["nw-start"].disabled,
    code: () => els["nw-code"].textContent,
    status: () => els["nw-status"].textContent,
    seatsHtml: () => els["nw-seats"].innerHTML,
    phase: () => els["nw-online"].dataset.phase,
  };
}

/* net.js keeps its state private inside an IIFE, which is right -- the page
   should not be able to reach into the lobby. So read what it rendered. */
const seatOf = (b) => {
  const m = b.seatsHtml().match(/<li class="nw-seat is-you[^"]*" data-slot="(\d)"/);
  return m ? Number(m[1]) : -1;
};
const filledSeats = (b) =>
  (b.seatsHtml().match(/<li class="nw-seat(?![^"]*is-empty)/g) || []).length;

/* The shipped bundle is IIFE-wrapped, so the internal hash table is not
   reachable from here -- and should not be. The engine publishes the newest
   frame it hashed and that hash, which is enough: every machine hashes the
   same frame numbers, so two machines reporting the same frame with different
   hashes have diverged. */
const checkpoint = (b) => {
  const st = b.nw.net.status;
  return { frame: st.checkedFrame, hash: st.checkedHash };
};

/** Assert every machine that reached a given checkpoint agrees on it. */
function assertAgreed(machines, what) {
  const pts = machines.map(checkpoint);
  assert.ok(pts.every((p) => p.frame >= 0),
    `${what}: somebody never hashed a confirmed frame (${JSON.stringify(pts)})`);
  const byFrame = new Map();
  for (const p of pts) {
    if (!byFrame.has(p.frame)) byFrame.set(p.frame, new Set());
    byFrame.get(p.frame).add(p.hash);
  }
  for (const [frame, hashes] of byFrame) {
    assert.equal(hashes.size, 1,
      `${what}: machines disagreed about frame ${frame} (${[...hashes].join(" vs ")})`);
  }
  // And they should not be miles apart, or "they agree" is thin.
  const frames = pts.map((p) => p.frame);
  assert.ok(Math.max(...frames) - Math.min(...frames) <= 60,
    `${what}: checkpoints too far apart to mean much (${frames.join(", ")})`);
}

/* Four rhythms, one per seat, so every machine is doing something different
   and the inputs genuinely have to travel. Scheme-0 keys throughout: online
   there is one person per keyboard, so every end reads WASD. */
const PATTERNS = [
  ["KeyD", "KeyG", "KeyA", null],
  ["KeyA", "KeyG", "KeyD", "KeyW"],
  ["KeyD", "KeyW", "KeyG", "KeyA"],
  ["KeyG", "KeyA", null, "KeyD"],
];

/** Run everyone forward together over a link with real latency, pressing keys. */
function playOut(machines, frames, lag = 4) {
  const held = machines.map(() => null);
  const hold = (i, key) => {
    if (held[i] === key) return;
    if (held[i]) machines[i].release(held[i]);
    held[i] = key;
    if (key) machines[i].press(key);
  };

  LAG = lag;
  for (let t = 0; t < frames; t++) {
    tick();
    for (let i = 0; i < machines.length; i++) {
      hold(i, PATTERNS[i % 4][Math.floor(t / (7 + i * 3)) % 4]);
    }
    for (const m of machines) m.pump(1);
  }
  for (let i = 0; i < machines.length; i++) hold(i, null);

  // Drain the wire and let every machine settle onto the same confirmed
  // frame before anything is compared.
  LAG = 0;
  for (let i = 0; i < 90; i++) {
    tick();
    for (const m of machines) m.pump(1);
  }
  flush(120);
}

/** Host a room and seat `n` machines in it. */
async function room(chars) {
  resetWorld();
  const ms = [];
  for (let i = 0; i < chars.length; i++) ms.push(await browser());
  ms[0].pick(chars[0]);
  ms[0].hostRoom();
  flush();
  const code = ms[0].code();
  for (let i = 1; i < ms.length; i++) {
    ms[i].pick(chars[i]);
    ms[i].joinRoom(code);
    flush();
  }
  return { ms, code };
}

test("four machines can sit down in one room", async () => {
  const { ms, code } = await room(["kel", "trev", "reese", "ladeane"]);
  const [A, B, C, D] = ms;

  assert.equal(code.length, 4, "the host should have a four-character room code");
  assert.equal(B.phase(), "lobby");
  assert.equal(C.phase(), "lobby");
  assert.equal(D.phase(), "lobby");

  assert.equal(filledSeats(A), 4, "the host should see four seats taken");
  assert.equal(
    JSON.stringify(ms.map(seatOf)), JSON.stringify([0, 1, 2, 3]),
    "each machine should know which seat it is in"
  );
  // Everyone renders the same four fighters, because the host is the only
  // source of the roster.
  assert.equal(new Set(ms.map((m) => (m.seatsHtml().match(/nw-seat-char/g) || []).length)).size, 1);
});

test("a fifth is turned away rather than silently dropped", async () => {
  const { ms, code } = await room(["kel", "trev", "reese", "ladeane"]);
  const E = await browser();
  E.pick("autisnick");
  E.joinRoom(code);
  flush();

  assert.equal(filledSeats(ms[0]), 4, "the room must not grow past four");
  assert.notEqual(E.phase(), "lobby", "the fifth should not have been seated");
});

test("the host starts a four-player match and everyone gets the right seat", async () => {
  const { ms } = await room(["kel", "trev", "reese", "ladeane"]);
  ms[0].start();
  flush();

  assert.ok(ms.every((m) => m.nw.net.active), "every machine should be in the match");
  assert.equal(JSON.stringify(ms.map((m) => m.nw.net.status.slots)),
               JSON.stringify([4, 4, 4, 4]));
  assert.equal(JSON.stringify(ms.map((m) => m.nw.net.status.slot)),
               JSON.stringify([0, 1, 2, 3]),
               "each machine drives a different fighter");
  assert.equal(JSON.stringify(ms[0].nw.fighters.map((f) => f.key)),
               JSON.stringify(["kel", "trev", "reese", "ladeane"]),
               "fighters should be seated in the order the lobby listed them");
  assert.equal(new Set(ms.map((m) => JSON.stringify(m.nw.fighters.map((f) => f.key)))).size, 1,
               "everyone should have built the same four fighters");
});

test("four machines stay in step through a real match", async () => {
  const { ms } = await room(["kel", "trev", "reese", "ladeane"]);
  ms[0].start();
  flush();
  const before = JSON.stringify(ms[0].nw.fighters);
  playOut(ms, 600);

  const st = ms.map((m) => m.nw.net.status);
  assert.deepEqual(st.map((x) => x.desync), [null, null, null, null], "somebody desynced");
  assert.equal(new Set(st.map((x) => x.frame)).size, 1, "machines reached different frames");
  assert.ok(st[0].frame > 400, `expected real progress, got frame ${st[0].frame}`);

  // Non-vacuous, part one: something actually happened. Four fighters standing
  // on their spawn points for ten seconds would satisfy everything above.
  assert.notEqual(JSON.stringify(ms[0].nw.fighters), before,
    "nobody moved, so this proved nothing about the simulation");

  // Non-vacuous, part two: the rollback path was entered. This is the code the
  // four-player change actually rewrote -- "1 - localSlot" became a loop over
  // slots, with per-peer newest[] and peerAhead[] reduced by netWorstRemote().
  // On a zero-latency link every guess is right, nothing is ever rewound, and
  // none of that code runs. Hence the deliberate latency in playOut().
  assert.ok(st.every((x) => x.rollbacks > 0),
    `every machine should have rolled back; got ${st.map((x) => x.rollbacks).join(", ")}`);
  assert.ok(st.some((x) => x.resimFrames > 100),
    `expected real resimulation, got ${st.map((x) => x.resimFrames).join(", ")}`);

  // The actual proof, stated positively rather than as the absence of a flag:
  // every machine that hashed a confirmed frame hashed it the same. Nudging
  // one machine's x by 0.0001 makes this fail, which is how it was checked to
  // be worth anything.
  assertAgreed(ms, "four machines");
});

test("one person leaving ends the match for everybody", async () => {
  // The alternative -- carrying on with three -- needs every remaining machine
  // to delete that fighter on the same simulation frame, and a disconnect is a
  // wall-clock event each machine notices at a different moment. Ending is the
  // honest behaviour, but only if everyone actually hears about it: the bug
  // this covers is the host stopping while the other two guests, who cannot
  // see each other, played on waiting for input that was never coming.
  const { ms } = await room(["kel", "trev", "reese", "ladeane"]);
  ms[0].start();
  flush();
  playOut(ms, 120);
  assert.ok(ms.every((m) => m.nw.net.active), "precondition: all four playing");

  ms[2].leave();
  flush(60);
  for (const m of ms) m.pump(2);
  flush(20);

  assert.deepEqual(ms.map((m) => m.nw.net.active), [false, false, false, false],
    "every machine should have stopped, not just the host and the leaver");
  assert.equal(filledSeats(ms[0]), 3, "the host's room should be down to three");
  assert.match(ms[0].status(), /left|stopped|dropped/i,
    "the host should say why the match ended");
});

test("two machines still work exactly as before", async () => {
  const { ms } = await room(["kel", "trev"]);
  ms[0].start();
  flush();

  assert.equal(JSON.stringify(ms.map((m) => m.nw.net.status.slots)), JSON.stringify([2, 2]));
  assert.equal(JSON.stringify(ms[0].nw.fighters.map((f) => f.key)), JSON.stringify(["kel", "trev"]));

  playOut(ms, 400);
  assert.deepEqual(ms.map((m) => m.nw.net.status.desync), [null, null]);
  assertAgreed(ms, "two machines");
});

test("the host cannot start on a guest whose channel has not opened yet", async () => {
  // The regression this covers: the host used to claim a seat the instant
  // PeerJS raised `connection`, before the data channel existed. Start was
  // gated only on headcount, `post` silently swallows sends on a closed
  // channel, so the `go` never reached that guest -- and everyone else then
  // waited forever for input from somebody who never entered the match. There
  // is no timeout and nothing on screen; you reload or you sit there.
  resetWorld();
  const host = await browser();
  const guest = await browser();
  host.pick("kel");
  host.hostRoom();
  flush();

  guest.pick("trev");
  guest.joinRoom(host.code());
  // Deliberately only part-way: enough for the connection to be raised on the
  // host, not enough for the channel to open and the `hello` to land.
  tick();
  tick();

  assert.match(host.seatsHtml(), /joining/,
    "a connecting guest should show as joining, not as a seated player");
  assert.equal(host.startDisabled(), true,
    "Start must stay disabled until that guest can actually receive the go");

  // And clicking it anyway must not strand anybody.
  host.start();
  flush();
  assert.equal(host.nw.net.active, false,
    "the host started a match with a guest that could not hear it");

  // Once the handshake completes it becomes startable.
  flush();
  assert.equal(host.startDisabled(), false, "Start should free up once the guest is in");
  host.start();
  flush();
  assert.equal(host.nw.net.active, true);
  assert.equal(guest.nw.net.active, true);
});

test("backing out of a match keeps your seat in the room", async () => {
  // Escape is the ordinary "I am done with this match" gesture, and the engine
  // sends {t:'bye'} for it. Reading that as "I am leaving the room" ejected the
  // guest and made them re-enter the code -- and since a KO does not end an
  // online match, somebody presses Escape every single time.
  const { ms } = await room(["kel", "trev", "reese"]);
  ms[0].start();
  flush();
  playOut(ms, 90);
  assert.ok(ms.every((m) => m.nw.net.active), "precondition: all three playing");

  // A GUEST backs out.
  ms[1].press("Escape");
  ms[1].pump(2);
  ms[1].release("Escape");
  flush(80);
  for (const m of ms) m.pump(2);
  flush(40);

  assert.deepEqual(ms.map((m) => m.nw.net.active), [false, false, false],
    "backing out should end the match for everyone");
  assert.equal(filledSeats(ms[0]), 3,
    "...but nobody should lose their seat: the room stays up for a rematch");
  assert.notEqual(ms[1].phase(), "idle",
    "the guest who backed out should still be in the room, not thrown out");
});

/* Playing again with the same people.
 *
 * A finished match used to be the end of the room. updateBattle set the scene
 * to 'results' and updateResults set it back to 'title', and neither touched
 * netplay.active -- netStop was only reachable from this page, which had no
 * way of knowing the match had ended. So the room stayed "playing" forever
 * and the only way to have another go was to build a new room and swap codes
 * again. The lobby already knew how to re-seat and re-start; nothing ever
 * told it to.
 */

/** Walk seat 0 off the side until the match is decided. */
function playToTheEnd(machines) {
  LAG = 2;
  for (let t = 0; t < 3000; t++) {
    tick();
    // Straight off the left edge, over and over. Three stocks is three trips.
    if (t % 90 === 0) machines[0].press("KeyA");
    if (t % 90 === 80) machines[0].release("KeyA");
    for (const m of machines) m.pump(1);
    if (machines.every((m) => m.nw.scene === "results")) break;
  }
  machines[0].release("KeyA");
  LAG = 0;
  flush(60);
}

test("a finished match returns everyone to the room they were already in", async () => {
  const { ms } = await room(["kel", "trev"]);
  ms[0].start();
  flush();
  assert.ok(ms.every((m) => m.nw.net.active), "the match should have started");

  playToTheEnd(ms);
  assert.ok(
    ms.every((m) => m.nw.scene === "results"),
    "expected the match to finish; scenes were " + ms.map((m) => m.nw.scene).join(", ")
  );

  // Everyone presses on past the result screen.
  for (const m of ms) {
    for (let i = 0; i < 50; i++) m.pump(1);
    m.press("Enter"); m.pump(2); m.release("Enter"); m.pump(2);
  }
  flush(60);

  assert.ok(
    ms.every((m) => !m.nw.net.active),
    "netplay should have stopped on every machine once the match was over"
  );
  assert.ok(
    ms.every((m) => m.phase() === "lobby"),
    "everyone should be back in the lobby, phases were " +
      ms.map((m) => m.phase()).join(", ")
  );
  assert.equal(filledSeats(ms[0]), 2, "and both seats should still be taken");
});

test("the same room can start a second match with different fighters", async () => {
  const { ms } = await room(["kel", "trev"]);
  ms[0].start();
  flush();
  playToTheEnd(ms);
  for (const m of ms) {
    for (let i = 0; i < 50; i++) m.pump(1);
    m.press("Enter"); m.pump(2); m.release("Enter"); m.pump(2);
  }
  flush(60);
  assert.ok(ms.every((m) => m.phase() === "lobby"), "back in the lobby first");

  // Pick somebody else and go again -- no new room, no new code.
  ms[0].pick("johnnyham");
  ms[1].pick("reese");
  flush();
  assert.equal(ms[0].startDisabled(), false, "the host should be able to start again");
  ms[0].start();
  flush();

  assert.ok(ms.every((m) => m.nw.net.active), "a second match should be running");
  assert.equal(
    JSON.stringify(ms[0].nw.fighters.map((f) => f.key)),
    JSON.stringify(["johnnyham", "reese"]),
    "and with the fighters they picked the second time"
  );
  assert.equal(
    new Set(ms.map((m) => JSON.stringify(m.nw.fighters.map((f) => f.key)))).size, 1,
    "both machines should have built the same pair"
  );

  // And it is a real match, not a stalled one.
  playOut(ms, 240, 3);
  assertAgreed(ms, "the second match");
});
