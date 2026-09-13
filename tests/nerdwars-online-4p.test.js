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

/* Each vm gets its own Math.random stream. Every harness in this suite hands
   the sandbox the HOST's Math, so without this they all draw from one shared
   sequence -- and node --test runs files concurrently, which makes the
   interleaving, and therefore any test that averages over AI behavior,
   different on every run. Math remains the prototype, so everything else on
   it still works. */
let __seedCounter = 0;
function seededMath() {
  let s = (0x9e3779b9 ^ (++__seedCounter * 2654435761)) >>> 0 || 1;
  const M = Object.create(Math);
  M.random = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  return M;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(HERE, "..", "assets", "js", "nerdwars");
const SPRITES = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
const GAME = readFileSync(path.join(JS_DIR, "game.js"), "utf8");
const NET = readFileSync(path.join(JS_DIR, "net.js"), "utf8");
const LADDER = readFileSync(path.join(JS_DIR, "ladder.js"), "utf8");

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

/* One shared database for every machine in a test -- the storage equivalent
   of the single `brokers` Map that makes the fake PeerJS work. Without a
   SHARED store, "the host writes the match and the guest confirms it" is two
   machines writing to two different databases and agreeing with nobody. */
let world = null;
function freshStore() {
  world = { matches: {}, profiles: {} };
  return world;
}

function resetWorld() {
  freshStore();
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

/** One whole browser: game.js, net.js, a lobby to click on.
 *
 * `opts.build` swaps the engine's stamped build id, which is how a browser
 * holding a stale cached bundle is simulated. That is not a hypothetical: it
 * is what actually happened, and the two machines played different matches
 * from the same inputs for three deaths before anybody worked out why.
 */
async function browser(opts) {
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
    console, Math: seededMath(), JSON, Date, Promise, Object, Array, Map, Set, Number, String,
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
  var netSrc = NET;
  if (opts && opts.legacyHello) {
    /* Matched loosely rather than as one exact string. This used to pin the
       whole literal, so adding a field to the handshake broke a test about
       version checking -- which is a long way from the change. */
    const helloRe = /send\(\{ t: "hello",[\s\S]*?build: MY_BUILD \}\);/;
    assert.ok(helloRe.test(NET), "net.js should send its build on hello");
    netSrc = NET.replace(helloRe,
      'send({ t: "hello", char: state.myChar, ready: state.myReady });');
  }
  var gameSrc = GAME;
  if (opts && opts.build) {
    const stamped = GAME.match(/BUILD_ID = '([a-z0-9]+)'/);
    assert.ok(stamped, "game.js should carry a stamped BUILD_ID");
    gameSrc = GAME.replace(stamped[0], "BUILD_ID = '" + opts.build + "'");
  }
  vm.runInContext(gameSrc, sb, { filename: "game.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  vm.runInContext(LADDER, sb, { filename: "ladder.js" });
  sb.window.NerdWarsFakeStore =
    sb.window.NerdWarsLadderKit.memoryStore(world);
  sb.window.NerdWarsLadder =
    sb.window.NerdWarsLadderKit.createLadder(sb.window.NerdWarsFakeStore);
  vm.runInContext(netSrc, sb, { filename: "net.js" });

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
    /* The same room, driven the way the GAME drives it now. Every method
       above fires a DOM click, which is how the lobby used to be operated
       and is no longer how it is operated anywhere: the panel is gone from
       the page and the room is drawn on the canvas. These reach net.js
       through window.NerdWarsLobby, which is the path that actually ships. */
    api: () => sb.window.NerdWarsLobby,
    ladder: () => sb.window.NerdWarsLadder,
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


/* ------------------------------------------------------------------ *
 * Two machines, two different bundles.
 * ------------------------------------------------------------------ */

test("the engine stamps a build id and the page can read it", async () => {
  const b = await browser();
  assert.match(b.nw.build, /^[a-f0-9]{10}$/,
    "build.py should stamp a content hash; got " + JSON.stringify(b.nw.build) +
    ". 'dev' means the bundle was not built, which would disable the check " +
    "that stops two different engines from playing each other");
});

test("a guest on a stale bundle is turned away instead of seated", async () => {
  resetWorld();
  const host = await browser();
  const guest = await browser({ build: "0badcache0" });

  host.pick("kel");
  host.hostRoom();
  flush();
  const code = host.code();

  guest.pick("trev");
  guest.joinRoom(code);
  flush();

  assert.equal(filledSeats(host), 1,
    "the host should still be sitting alone -- seating a guest on a different " +
    "engine is how two machines end up playing two different matches");
  assert.match(guest.status(), /different version/i,
    "and the guest has to be TOLD why, or the room simply never appears and " +
    "there is nothing to act on. Saw: " + JSON.stringify(guest.status()));
  assert.equal(guest.phase(), "idle");
});

test("the same bundle still joins normally", async () => {
  /* The control. A version gate that rejects everybody would pass the test
     above and quietly end multiplayer altogether. */
  const { ms } = await room(["kel", "trev"]);
  assert.equal(filledSeats(ms[0]), 2, "two matching builds should seat fine");
  assert.equal(ms[1].phase(), "lobby");
  assert.equal(ms[0].nw.build, ms[1].nw.build);
});

test("a desync stops the simulation, not just the lobby", async () => {
  const { ms } = await room(["kel", "trev"]);
  ms[0].start();
  flush();
  playOut(ms, 150);
  assert.equal(ms[0].nw.net.active, true, "the match should be running");

  const cp = checkpoint(ms[0]);
  assert.ok(cp.frame >= 0, "a frame should have been hashed by now");

  /* Exactly what a divergence looks like from the outside: the other machine
     reporting a different hash for a frame we have already confirmed. */
  ms[0].nw.net.receive({ t: "c", s: 1, f: cp.frame, h: (cp.hash ^ 0x5bf03635) >>> 0 });
  flush();

  assert.equal(
    ms[0].nw.net.active, false,
    "the SIMULATION has to stop, not just the lobby panel. It used to keep " +
    "running behind the warning, which is how a match played on for three " +
    "more deaths on one screen and none on the other"
  );
  assert.match(ms[0].status(), /fell out of step/i,
    "and say so. Saw: " + JSON.stringify(ms[0].status()));
});

test("a peer too old to send a build at all is also turned away", async () => {
  /* The realistic shape of this: a browser holding the whole page in cache has
     the old net.js too, and that one sends no build field at all. Silence is
     the signature of exactly the peer we know is out of date, so it must not
     read as agreement. */
  resetWorld();
  const host = await browser();
  const guest = await browser({ legacyHello: true });

  host.pick("kel");
  host.hostRoom();
  flush();
  guest.pick("trev");
  guest.joinRoom(host.code());
  flush();

  assert.equal(filledSeats(host), 1,
    "a guest that never mentions its build is running a page older than this " +
    "check, which is the case the check exists for");
  assert.match(host.status(), /different version/i,
    "and the host should be told, so they can pass the word on. Saw: " +
    JSON.stringify(host.status()));
});


test("the room can be run through the API the game uses, not the DOM", async () => {
  /* Every other test in this file operates the lobby by firing DOM clicks at
     elements the page no longer has. That was the only way in when the room
     WAS those elements; it is now a legacy path, and a test that only
     exercises a legacy path is a test that stops telling you the truth.

     So this one does the same job through window.NerdWarsLobby -- host,
     join, pick, start, leave -- which is what the canvas calls. If the room
     on screen can do it, this can do it. */
  resetWorld();
  const host = await browser();
  const guest = await browser();
  assert.ok(host.api(), "net.js should expose the lobby API");

  host.api().host();
  flush();
  const code = host.api().snapshot().code;
  assert.match(code, /^[A-Z2-9]{4}$/,
    "hosting should produce a four-character room code, got " + code);

  guest.api().join(code);
  flush();

  const seatsOf = (m) => m.api().snapshot().seats.filter((x) => x.here).length;
  assert.equal(seatsOf(host), 2, "the guest should be in the host's room");
  assert.equal(seatsOf(guest), 2, "and the guest should see both of them");
  assert.equal(host.api().snapshot().role, "host");
  assert.equal(guest.api().snapshot().role, "guest");

  // Picking through the API is what the grid on the canvas does.
  // Settled, not merely hovered: the host cannot start until everybody
  // in the room has locked a fighter in.
  host.api().pick("kel", true);
  guest.api().pick("trev", true);
  flush();
  const charAt = (m, slot) => {
    const seat = m.api().snapshot().seats.find((x) => x.slot === slot);
    return seat && seat.char;
  };
  assert.equal(charAt(host, 0), "kel");
  assert.equal(charAt(host, 1), "trev", "the host should see the guest's pick");

  // Only the host may start, and the snapshot says so before it is tried.
  assert.equal(host.api().snapshot().canStart, true);
  assert.equal(guest.api().snapshot().canStart, false,
    "a guest should not be told it can start the match");
  assert.equal(guest.api().start(), false, "and should not be able to");

  assert.equal(host.api().start(), true, "the host starts the match");
  flush();
  assert.equal(host.nw.scene, "battle");
  assert.equal(guest.nw.scene, "battle");
  assert.equal(JSON.stringify(host.nw.fighters.map((f) => f.key)),
               JSON.stringify(["kel", "trev"]));

  // And leaving through the API frees the seat, the way ESC in the room does.
  guest.api().leave();
  flush();
  assert.equal(guest.api().snapshot().phase, "idle",
    "leaving should put the guest back to no room at all");
});


test("when a real match ends, everybody lands back in the room", async () => {
  /* Reported from actual play: "when the game ends it should send the users
     back to the character select screen, not the title screen. the room
     should still be active."

     Every other rematch test in this repo drives the ENGINE's results screen
     or calls net.start twice. This one plays a match all the way to a real
     KO with net.js in the loop and then looks at where both machines are
     standing and whether the room is still alive -- which is the thing that
     was actually reported and the thing nothing was checking. */
  resetWorld();
  const host = await browser();
  const guest = await browser();

  host.api().host();
  flush();
  const code = host.api().snapshot().code;
  guest.api().join(code);
  flush();
  // Settled, not merely hovered: the host cannot start until everybody
  // in the room has locked a fighter in.
  host.api().pick("kel", true);
  guest.api().pick("trev", true);
  flush();
  host.api().start();
  flush();
  assert.equal(host.nw.scene, "battle", "precondition: a match is running");
  assert.equal(guest.nw.scene, "battle");

  // Run it out. Stocks are finite and the CPUs are not driving, so the quick
  // way to a real ending is to march both of them off the side.
  const ms = [host, guest];
  for (let i = 0; i < 4000 && ms.some((m) => m.nw.scene === "battle"); i++) {
    for (const m of ms) m.press("KeyA");
    playOut(ms, 1);
  }
  for (const m of ms) m.release("KeyA");

  assert.ok(ms.every((m) => m.nw.scene !== "battle"),
    "the match should have ended; scenes are " +
    ms.map((m) => m.nw.scene).join(", "));

  // Let the results screen time out the way it does for a real player.
  playOut(ms, 400);

  for (const [name, m] of [["host", host], ["guest", guest]]) {
    assert.equal(m.nw.scene, "room",
      "the " + name + " should be back in the room picking a fighter, not " +
      "on '" + m.nw.scene + "'");
    assert.notEqual(m.api().snapshot().phase, "idle",
      "and the " + name + "'s room should still be alive");
  }

  /* Nobody is locked in yet, so nothing can start. A match ending clears
     everybody's pick, which is the whole point of being handed back to the
     character select rather than straight into another fight. */
  assert.equal(host.api().snapshot().canStart, false,
    "a rematch should wait for everybody to pick again");

  // And it is a REAL room: pick again and the host can go.
  host.api().pick("reese", true);
  guest.api().pick("ladeane", true);
  flush();
  assert.equal(host.api().snapshot().canStart, true,
    "once everybody has locked in, the host should be able to start again " +
    "without rebuilding the room");
  assert.equal(host.api().start(), true);
  flush();
  assert.equal(host.nw.scene, "battle", "the second match should start");
  assert.equal(JSON.stringify(host.nw.fighters.map((f) => f.key)),
               JSON.stringify(["reese", "ladeane"]),
               "with the fighters they picked the second time");
});


test("a friend quitting mid-match leaves you in the room, not the title", async () => {
  /* The ending nothing was checking, and the one that was actually reported.

     A match can end four ways -- a KO, somebody pressing Escape, a peer
     sending `bye`, or a desync -- and only the KO goes through the results
     screen. The other three all run straight through netStop, which set the
     scene to 'title' flat. So a clean win put everyone back in the room and
     a friend quitting dropped you on the title screen with the room you were
     still sitting in nowhere on the screen.

     Three seats here on purpose: with only two, one leaving empties the room
     and the title screen is then the right answer, which would let the bug
     pass. With three, the room plainly survives. */
  resetWorld();
  const host = await browser();
  const a = await browser();
  const b = await browser();

  host.api().host();
  flush();
  const code = host.api().snapshot().code;
  a.api().join(code); flush();
  b.api().join(code); flush();
  host.api().pick("kel", true); a.api().pick("trev", true);
  b.api().pick("reese", true);
  flush();
  host.api().start();
  flush();
  const ms = [host, a, b];
  assert.ok(ms.every((m) => m.nw.scene === "battle"),
    "precondition: a three-player match is running");

  playOut(ms, 60);

  // One of them walks out mid-match, the way a person does.
  b.press("Escape");
  playOut(ms, 4);
  b.release("Escape");
  playOut(ms, 120);

  for (const [name, m] of [["host", host], ["the other guest", a]]) {
    assert.equal(m.nw.scene, "room",
      name + " should be left standing in the room, not on '" +
      m.nw.scene + "'");
    assert.notEqual(m.api().snapshot().phase, "idle",
      "and " + name + "'s room should still be alive");
  }

  /* Escape in a match leaves the MATCH, not the room -- so all three are
     still seated, and the one who walked out is simply not locked in. The
     room correctly waits for them, which is the gate doing its job rather
     than a bug. */
  assert.equal(host.api().snapshot().here, 3,
    "quitting a match should not give up the seat");
  host.api().pick("kel", true);
  a.api().pick("trev", true);
  flush();
  assert.equal(host.api().snapshot().canStart, false,
    "the third player is still in the room and has not picked, so the room " +
    "should wait for them");

  // Now they actually leave the room, and the two who are left can go.
  b.api().leave();
  flush();
  assert.equal(host.api().snapshot().here, 2, "the seat should be freed");
  assert.equal(host.api().snapshot().canStart, true,
    "two people, both locked in, should be able to go again");
});


test("everybody can watch everybody else choose", async () => {
  /* Reported from actual play: "when my friend is choosing a character i
     cant see when his box moves to other characters."

     The room only sent a pick when somebody COMMITTED, so until then their
     box sat on whatever they had last locked and the grid looked frozen.
     You could not tell a player still deciding from one who had wandered
     off. Now a moving cursor is broadcast as it moves, and `ready` says
     whether they have settled -- which is what the room draws solid rather
     than faint. */
  resetWorld();
  const host = await browser();
  const guest = await browser();
  host.api().host(); flush();
  guest.api().join(host.api().snapshot().code); flush();

  const seatOnHost = (slot) =>
    host.api().snapshot().seats.find((x) => x.slot === slot);
  const seatOnGuest = (slot) =>
    guest.api().snapshot().seats.find((x) => x.slot === slot);

  // The guest moves across the grid without committing to anything.
  guest.api().pick("reese", false);
  flush();
  assert.equal(seatOnHost(1).char, "reese",
    "the host should see the guest's cursor move before they commit");
  assert.equal(seatOnHost(1).ready, false,
    "and should be able to tell they have not settled on it");

  guest.api().pick("ladeane", false);
  flush();
  assert.equal(seatOnHost(1).char, "ladeane",
    "and should see it move again");
  assert.equal(seatOnHost(1).ready, false);

  // Then settles.
  guest.api().pick("ladeane", true);
  flush();
  assert.equal(seatOnHost(1).ready, true,
    "committing should show as committed");

  // It travels the other way too: a guest watches the host choose.
  host.api().pick("cobeus", false);
  flush();
  assert.equal(seatOnGuest(0).char, "cobeus",
    "the guest should see the host's cursor too");
  assert.equal(seatOnGuest(0).ready, false);
  host.api().pick("cobeus", true);
  flush();
  assert.equal(seatOnGuest(0).ready, true);

  // And the fighters that actually load are the ones they settled on.
  assert.equal(host.api().start(), true);
  flush();
  assert.equal(JSON.stringify(host.nw.fighters.map((f) => f.key)),
               JSON.stringify(["cobeus", "ladeane"]));
});


test("nothing starts until everybody in the room has locked in", async () => {
  /* Asked for directly: "make it so you cant start the game until everyone
     has selected a character."

     This was built once before and reverted, on the grounds that it gives a
     host no way to start when somebody forgets to press the key. That worry
     is answered rather than ignored: locking in is a TOGGLE on SPACE, the
     room says out loud how many people it is still waiting on, and leaving
     frees the seat. The gate is the point -- starting a match while somebody
     is still scrolling the grid picks a fighter for them. */
  resetWorld();
  const host = await browser();
  const guest = await browser();
  host.api().host(); flush();
  guest.api().join(host.api().snapshot().code); flush();

  // Both in the room, neither settled.
  host.api().pick("kel", false);
  guest.api().pick("trev", false);
  flush();
  assert.equal(host.api().snapshot().here, 2, "two people are in the room");
  assert.equal(host.api().snapshot().canStart, false,
    "nobody has locked in, so the host must not be told they can start");
  assert.equal(host.api().start(), false, "and must not be able to");
  // Driven through the API rather than the screens, so the engine was never
  // walked into the room scene; what matters is that no match began.
  assert.notEqual(host.nw.scene, "battle", "so nothing should have started");

  // One of them settles. Still not enough.
  host.api().pick("kel", true);
  flush();
  assert.equal(host.api().snapshot().canStart, false,
    "one of two is not everybody");
  assert.equal(host.api().start(), false);

  // Both settled: now it goes.
  guest.api().pick("trev", true);
  flush();
  assert.equal(host.api().snapshot().canStart, true,
    "with everybody locked in the host should be able to start");
  assert.equal(host.api().start(), true);
  flush();
  assert.equal(host.nw.scene, "battle");

  /* And unlocking takes it away again, which is what makes the toggle safe
     rather than a trap: a player who changes their mind can, and the host
     simply waits. */
  host.api().leave(); guest.api().leave();
  flush();
  resetWorld();
  const h2 = await browser();
  const g2 = await browser();
  h2.api().host(); flush();
  g2.api().join(h2.api().snapshot().code); flush();
  h2.api().pick("kel", true); g2.api().pick("trev", true);
  flush();
  assert.equal(h2.api().snapshot().canStart, true);
  g2.api().pick("trev", false);          // changed their mind
  flush();
  assert.equal(h2.api().snapshot().canStart, false,
    "somebody unlocking should take the start away again");
});


test("a finished match is written down, by both players, for themselves", async () => {
  /* The end of the whole chain: two people sign in, play a real match to a
     real KO, and a record appears that names PEOPLE rather than characters.

     The naming is the point. The engine's own winner is a character key --
     two people can both pick Kel, and then 'kel' identifies neither of them
     -- so the room ships a uid list indexed the same way as the character
     list, and the result is reported by SEAT. */
  resetWorld();
  const host = await browser();
  const guest = await browser();

  host.api().setMe({ uid: "u-trev", name: "Trev" });
  guest.api().setMe({ uid: "u-kel", name: "Kel" });

  host.api().host(); flush();
  guest.api().join(host.api().snapshot().code); flush();
  host.api().pick("kel", true); guest.api().pick("trev", true);
  flush();

  // The room knows who is in it, not just what they picked.
  const seats = host.api().snapshot().seats;
  assert.equal(seats.find((s) => s.slot === 1).uid, "u-kel",
    "the host should know which PERSON is in seat 1");
  assert.equal(guest.api().snapshot().seats.find((s) => s.slot === 0).name,
    "Trev", "and the guest should know who the host is");

  host.api().start();
  flush();
  assert.ok([host, guest].every((m) => m.nw.scene === "battle"));

  // Play it out for real, then let the results screen time out.
  const ms = [host, guest];
  for (let i = 0; i < 4000 && ms.some((m) => m.nw.scene === "battle"); i++) {
    for (const m of ms) m.press("KeyA");
    playOut(ms, 1);
  }
  for (const m of ms) m.release("KeyA");
  playOut(ms, 400);
  /* Both machines report, one writes and the other confirms, and that is two
     promise hops deep. Let the microtasks drain before reading the store. */
  for (let i = 0; i < 50; i++) await Promise.resolve();

  const mids = Object.keys(world.matches);
  assert.equal(mids.length, 1,
    "exactly one match document should exist, got " + mids.length);
  const rec = world.matches[mids[0]];

  assert.deepEqual([...rec.uids], ["u-trev", "u-kel"],
    "the record should name the people, in fighter order");
  assert.deepEqual([...rec.chars], ["kel", "trev"],
    "and the characters they played, in the same order");
  assert.ok(rec.host === "u-trev" || rec.host === "u-kel",
    "one of the two wrote it down, got " + rec.host);
  assert.ok(rec.winnerSlot === null || rec.winnerSlot === 0 || rec.winnerSlot === 1,
    "winnerSlot should be a seat or a draw, got " + rec.winnerSlot);
  assert.ok(rec.frames > 0, "and should carry how long it took");

  /* The other one confirmed it rather than writing a second copy. One
     document per match is what makes the log orderable: four machines have
     four clocks, so a per-player record has no canonical time to sort by.

     WHICH machine authored is deliberately not asserted. It used to be the
     room's host, always, and that is exactly what broke: the author wrote on
     leaving the results screen, the winner leaves first, and a guest who won
     was confirming a document nobody had written yet. */
  const other = rec.host === "u-trev" ? "u-kel" : "u-trev";
  assert.deepEqual([...Object.keys(rec.confirm)], [other],
    "the machine that did not write it should have confirmed it");
  assert.equal(rec.confirm[other].agree, true);
  assert.equal(rec.confirm[other].winnerSlot, rec.winnerSlot,
    "and should agree about who won -- both machines simulate the same match");

  // Which the ladder then counts.
  const view = host.ladder().__fold(
    Object.keys(world.matches).map((k) => ({ ...world.matches[k], mid: k })));
  assert.equal(view.counted, 1, "the match should count");
  assert.equal(view.disputed, 0);
  assert.equal(view.rows.length, 2, "two players on the board");
  const names = view.rows.map((r) => r.name).sort();
  assert.deepEqual(names, ["Kel", "Trev"]);
});

test("nothing is written down when a match ends any other way", async () => {
  /* Only `reason === "match over"` is a result. The other three endings --
     Escape, a peer's `bye`, a desync -- never reach the branch that decides
     a winner, so the engine still holds whatever it last decided: null on a
     first match, or the PREVIOUS match's winner on a rematch.

     Reporting on `stopped` without checking the reason would write last
     match's result down as this one's, and it would look entirely normal. */
  resetWorld();
  const host = await browser();
  const guest = await browser();
  host.api().setMe({ uid: "u-a", name: "A" });
  guest.api().setMe({ uid: "u-b", name: "B" });
  host.api().host(); flush();
  guest.api().join(host.api().snapshot().code); flush();
  host.api().pick("kel", true); guest.api().pick("trev", true);
  flush();
  host.api().start(); flush();
  assert.equal(host.nw.scene, "battle");

  playOut([host, guest], 60);
  guest.press("Escape");
  playOut([host, guest], 4);
  guest.release("Escape");
  playOut([host, guest], 200);

  assert.deepEqual(Object.keys(world.matches), [],
    "a match nobody finished should leave no record at all");
});

test("a match with anybody unidentified is not recorded", async () => {
  /* Somebody who has not signed in has no uid, and a record with a hole in
     it names a ghost -- worse, it would silently attribute their loss to
     nobody and still move the other player's rating. */
  resetWorld();
  const host = await browser();
  const guest = await browser();
  host.api().setMe({ uid: "u-a", name: "A" });
  // guest deliberately does not sign in
  host.api().host(); flush();
  guest.api().join(host.api().snapshot().code); flush();
  host.api().pick("kel", true); guest.api().pick("trev", true);
  flush();
  host.api().start(); flush();

  const ms = [host, guest];
  for (let i = 0; i < 4000 && ms.some((m) => m.nw.scene === "battle"); i++) {
    for (const m of ms) m.press("KeyA");
    playOut(ms, 1);
  }
  for (const m of ms) m.release("KeyA");
  playOut(ms, 400);

  assert.deepEqual(Object.keys(world.matches), [],
    "a match with an anonymous player should not be scored");
});


/* --------------------------------------------------------------------- *
 * REPRO: the guest's win is not counted.
 *
 * Reported from real play, and the database agrees: every match won by seat 0
 * is counted and every match won by seat 1 is pending, four to two.
 *
 * The hypothesis this exercises is ORDER, not who won. The results screen can
 * be left early with the attack key (after 40 frames) or it times out on its
 * own at 200. The winner is the one still mashing attack, so the winner leaves
 * first -- and leaving is what triggers the recording. When the HOST leaves
 * first it writes the match document and the guest confirms it afterwards.
 * When the GUEST leaves first it tries to confirm a document the host has not
 * written yet.
 * --------------------------------------------------------------------- */

/** Two signed-in machines, in a room, mid-match. */
async function twoInAMatch() {
  resetWorld();
  const host = await browser();
  const guest = await browser();
  host.api().setMe({ uid: "u-host", name: "Host" });
  guest.api().setMe({ uid: "u-guest", name: "Guest" });
  host.api().host(); flush();
  guest.api().join(host.api().snapshot().code); flush();
  host.api().pick("kel", true); guest.api().pick("trev", true);
  flush();
  host.api().start(); flush();
  assert.ok([host, guest].every((m) => m.nw.scene === "battle"),
    "both machines should be in the battle");
  return { host, guest };
}

/** Play until somebody wins, leaving both machines on the results screen. */
function playToResults(ms) {
  for (let i = 0; i < 5000 && ms.some((m) => m.nw.scene === "battle"); i++) {
    for (const m of ms) m.press("KeyA");
    playOut(ms, 1);
  }
  for (const m of ms) m.release("KeyA");
  return ms.every((m) => m.nw.scene === "results");
}

/* The same, but stopping ON the frame the match ends rather than ninety
   frames later. playOut drains the wire and flushes after every call, which
   carries the results screen well past the point where anything interesting
   happens on it -- and the interesting window here is the first twenty
   frames, before the result has been written down. */
function playToTheKO(ms) {
  LAG = 0;
  for (let i = 0; i < 6000 && ms.some((m) => m.nw.scene === "battle"); i++) {
    for (const m of ms) m.press("KeyA");
    tick();
    for (const m of ms) m.pump(1);
  }
  for (const m of ms) m.release("KeyA");
  return ms.every((m) => m.nw.scene === "results");
}

/** Leave the results screen with the attack key, the way a player does. */
function leaveResults(m) {
  m.pump(45);                 // carryOn needs resultTimer > 40
  m.press("KeyG");
  m.pump(4);
  m.release("KeyG");
  m.pump(4);
  flush();
}

const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

test("a match counts whichever seat won it", async () => {
  /* Reported from real play: "if the player who didnt start the room wins,
     the win doesnt count". The database agreed -- four matches won by seat 0
     counted, two won by seat 1 sat on "pending", and nothing else separated
     them.

     The cause was not who won, it was who moved first. Recording hung off
     leaving the results screen; the winner leaves first, because the winner
     is the one still mashing attack; and the room's host was the only machine
     allowed to AUTHOR the record. So a guest who won reported seconds before
     the host had written anything to confirm, and the confirm was refused.

     This drives both orders explicitly and asserts the thing that matters:
     the match counts, and the win lands on whoever won it. */
  for (const firstOut of ["host", "guest"]) {
    const { host, guest } = await twoInAMatch();
    assert.ok(playToResults([host, guest]), "the match should have ended");

    const winner = host.nw.result.winnerSlot;
    assert.ok(winner === 0 || winner === 1,
      "somebody should have won, got " + winner);
    assert.equal(guest.nw.result.winnerSlot, winner,
      "both machines should agree who won");

    const first = firstOut === "host" ? host : guest;
    const second = firstOut === "host" ? guest : host;
    leaveResults(first);
    await settle();
    second.pump(260);          // the other one waits for the screen to time out
    flush();
    await settle();

    const mids = Object.keys(world.matches);
    assert.equal(mids.length, 1,
      firstOut + " left first: one match document, got " + mids.length);
    const rec = world.matches[mids[0]];
    const view = host.ladder().__fold([{ ...rec, mid: mids[0] }]);

    assert.equal(view.counted, 1,
      firstOut + " left first, seat " + winner + " won: the match should count, " +
      "verdict was " + view.matches[0].verdict + " with confirms from [" +
      Object.keys(rec.confirm || {}).join(", ") + "], author " + rec.host);
    assert.equal(view.disputed, 0);

    const winnerUid = ["u-host", "u-guest"][winner];
    const loserUid = ["u-host", "u-guest"][1 - winner];
    assert.equal(view.rows.find((r) => r.uid === winnerUid).w, 1,
      "the win should belong to " + winnerUid);
    assert.equal(view.rows.find((r) => r.uid === loserUid).l, 1,
      "and the loss to " + loserUid);
  }
});

test("both machines write the match down before anybody can leave the screen", async () => {
  /* The structural half of the fix. The record used to be triggered by
     leaving the results screen, which is a keypress, which the winner makes
     first. Now the engine says the match is over on a fixed frame of that
     screen -- frame 20, where a rollback has long since settled and the
     earliest a key can be accepted is 40 -- so both machines report while
     they are still sitting there together. */
  const { host, guest } = await twoInAMatch();
  assert.ok(playToResults([host, guest]), "the match should have ended");
  // Nobody has pressed anything since the KO -- playToResults releases every
  // key -- and both machines are still sitting on the results screen.
  await settle();

  const mids = Object.keys(world.matches);
  assert.equal(mids.length, 1,
    "the match should be written down from the results screen itself, " +
    "without anybody touching a key, got " + mids.length + " documents");
  const rec = world.matches[mids[0]];
  assert.equal(Object.keys(rec.confirm || {}).length, 1,
    "and corroborated in the same breath, confirms: " +
    Object.keys(rec.confirm || {}).join(", "));
  assert.ok(host.nw.scene === "results" && guest.nw.scene === "results",
    "with both machines still on the results screen");
});


test("one player bailing out cannot erase everybody's record of the match", async () => {
  /* Leaving the results screen is not a private act. Escape there calls
     lobby().leave(), which sends `part` and tears the room down -- and the
     peer, still sitting on its own results screen, then stops with the reason
     "a player left" rather than "match over". Only "match over" records
     anything, so the quicker player used to be able to delete the slower
     one's record of a match they had both just played.

     Escape on this screen now waits until the result is written. */
  const { host, guest } = await twoInAMatch();
  assert.ok(playToTheKO([host, guest]), "the match should have ended");
  await settle();
  assert.equal(Object.keys(world.matches).length, 0,
    "nothing is written down in the instant the match ends -- a mispredicted " +
    "KO still has to be able to roll back");

  /* The host reaches for Escape straight away, inside the window. Leaving
     sends `part` and tears the room down; if it went through now, the guest
     would stop with the reason "a player left" instead of "match over" and
     would never write anything. */
  host.press("Escape");
  for (let i = 0; i < 40; i++) { host.pump(1); guest.pump(1); tick(); }
  host.release("Escape");
  flush();
  await settle();

  const mids = Object.keys(world.matches);
  assert.equal(mids.length, 1,
    "the match should have been written down anyway, got " + mids.length);
  const rec = world.matches[mids[0]];
  assert.equal(Object.keys(rec.confirm || {}).length, 1,
    "and corroborated, confirms: [" +
    Object.keys(rec.confirm || {}).join(", ") + "] author " + rec.host);
  const view = host.ladder().__fold([{ ...rec, mid: mids[0] }]);
  assert.equal(view.counted, 1,
    "the match still counts, verdict " + view.matches[0].verdict);
});
