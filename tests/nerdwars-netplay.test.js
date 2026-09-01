/* NerdWars netplay.
 *
 * Online play is deterministic lockstep: only button presses cross the wire,
 * and both machines run the identical simulation from them. That only works
 * if the simulation really is identical, so the interesting thing to test is
 * two independent copies of the engine fed the same inputs staying in step.
 *
 * The engine ships as a browser script, so these tests run it inside a vm
 * context with a small DOM stub and a hand-cranked requestAnimationFrame.
 * Driving the clock by hand is the point: it makes a frame-exact test
 * possible, which a real browser timer would not.
 *
 * The oracle is the game's own desync detector. Each side hashes the exact
 * float bits of its state every 30 frames and sends it across; a mismatch
 * sets `desync`. So "no desync after N frames" is a genuine assertion that
 * the two simulations agreed bit for bit, not just approximately.
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

/* A canvas context that accepts anything and returns something harmless.
   The engine calls a few dozen 2D methods; none of them affect the
   simulation, so none of them need to do anything here. */
function stubContext() {
  return new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "createLinearGradient" || key === "createRadialGradient") {
          return () => ({ addColorStop() {} });
        }
        if (key === "measureText") return () => ({ width: 0 });
        if (key === "canvas") return { width: 0, height: 0 };
        return () => {};
      },
      set() {
        return true;
      },
    }
  );
}

function stubCanvas(w, h) {
  const el = {
    width: w,
    height: h,
    style: {},
    getContext: () => stubContext(),
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = {
    clientWidth: w,
    clientHeight: h,
    contains: () => true,
    dataset: {},
  };
  return el;
}

/** Boot one independent copy of the engine. */
async function bootGame() {
  const view = stubCanvas(960, 540);
  const winListeners = new Map();
  const docListeners = new Map();
  const rafQueue = [];
  let clock = 0;

  const on = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };

  const sandbox = {
    console,
    Math,
    JSON,
    Date,
    Promise,
    Object,
    Array,
    Map,
    Set,
    Number,
    String,
    Boolean,
    Error,
    DataView,
    ArrayBuffer,
    Uint8Array,
    Float64Array,
    isNaN,
    parseInt,
    parseFloat,
    requestAnimationFrame: (cb) => rafQueue.push(cb),
    innerWidth: 960,
    innerHeight: 540,
    addEventListener: on(winListeners),
    // Fires onload synchronously. The engine assigns onload before src, so
    // this resolves its load promises without needing timers.
    Image: class {
      constructor() {
        this.complete = true;
        this.naturalWidth = 16;
        this.naturalHeight = 16;
      }
      set src(v) {
        this._src = v;
        if (this.onload) this.onload();
      }
      get src() {
        return this._src;
      }
    },
    document: {
      getElementById: (id) => (id === "nw-canvas" || id === "game" ? view : null),
      // No [data-nerdwars] mount: the engine treats that as "I own the page",
      // which means it is focused from the start and reads the keyboard.
      querySelector: () => null,
      createElement: () => stubCanvas(320, 180),
      addEventListener: on(docListeners),
      documentElement: {},
      fullscreenElement: null,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SPRITES, sandbox, { filename: "sprites.js" });
  vm.runInContext(GAME, sandbox, { filename: "game.js" });

  // Let the asset-load promises settle.
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const fire = (map, type, ev) => {
    for (const fn of map.get(type) || []) fn(ev);
  };

  return {
    nw: sandbox.window.NerdWars,
    /** Advance exactly n animation frames at a steady 60Hz. */
    pump(n = 1) {
      for (let i = 0; i < n; i++) {
        const due = rafQueue.splice(0, rafQueue.length);
        clock += 1000 / 60;
        for (const cb of due) cb(clock);
      }
    },
    press: (code) =>
      fire(winListeners, "keydown", { code, preventDefault() {} }),
    release: (code) => fire(winListeners, "keyup", { code }),
  };
}

test("engine boots headlessly and reaches the title screen", async () => {
  const g = await bootGame();
  assert.equal(g.nw.ready, true);
  assert.equal(g.nw.scene, "title");
  g.pump(3);
  assert.ok(g.nw.frames > 0, "the loop should be running");
});

test("two independent engines stay bit-identical through a fought match", async () => {
  const a = await bootGame();
  const b = await bootGame();

  // Wire each one's outbound messages straight into the other.
  a.nw.net.start({
    localSlot: 0,
    chars: ["kel", "trev"],
    stage: "swamp",
    delay: 4,
    send: (m) => b.nw.net.receive(m),
  });
  b.nw.net.start({
    localSlot: 1,
    chars: ["kel", "trev"],
    stage: "swamp",
    delay: 4,
    send: (m) => a.nw.net.receive(m),
  });

  assert.equal(a.nw.scene, "battle");
  assert.equal(b.nw.scene, "battle");

  // Two different players mashing two different sets of keys. The sequences
  // are fixed so a failure is reproducible.
  //
  // Both are scheme-0 keys: online there is one person per keyboard, so both
  // ends read WASD regardless of which slot they hold. An arrow-key sequence
  // here would press nothing at all.
  const p1 = ["KeyD", "KeyF", "KeyW", "KeyA", "KeyG", "ShiftLeft", "KeyS", "KeyQ"];
  const p2 = ["KeyA", "KeyC", "KeyW", "KeyD", "KeyR", "KeyG", "KeyQ", "KeyS"];
  const held = { a: null, b: null };

  for (let i = 0; i < 900; i++) {
    if (i % 7 === 0) {
      if (held.a) a.release(held.a);
      held.a = p1[(i / 7) % p1.length | 0];
      a.press(held.a);
    }
    if (i % 5 === 0) {
      if (held.b) b.release(held.b);
      held.b = p2[(i / 5) % p2.length | 0];
      b.press(held.b);
    }
    // Interleave so neither side ever runs more than a frame ahead.
    a.pump(1);
    b.pump(1);
  }

  const sa = a.nw.net.status;
  const sb = b.nw.net.status;

  assert.equal(sa.desync, null, "player 1 saw a desync");
  assert.equal(sb.desync, null, "player 2 saw a desync");
  assert.ok(sa.frame > 500, `expected real progress, got frame ${sa.frame}`);
  assert.equal(sa.frame, sb.frame, "the two sides simulated a different number of frames");

  // Same fight on both machines, down to the damage counters. Compared as
  // JSON because the two engines run in separate vm contexts: their object
  // literals get context-local prototypes, so deepStrictEqual would reject
  // structurally identical values for having different Object.prototypes.
  assert.equal(
    JSON.stringify(a.nw.fighters),
    JSON.stringify(b.nw.fighters),
    "the two machines disagree about the state of the fight"
  );
});

test("both players use the same keys, whichever slot they are in", async () => {
  // The bug this covers: each machine used to read its own slot's bindings,
  // so the guest was on player two's controls (arrows and punctuation) while
  // reaching for WASD. Online there is one person per keyboard, so both ends
  // must answer to the same keys.
  const a = await bootGame();
  const b = await bootGame();

  a.nw.net.start({ localSlot: 0, chars: ["kel", "trev"], stage: "space",
                   delay: 4, send: (m) => b.nw.net.receive(m) });
  b.nw.net.start({ localSlot: 1, chars: ["kel", "trev"], stage: "space",
                   delay: 4, send: (m) => a.nw.net.receive(m) });

  const settle = (n) => { for (let i = 0; i < n; i++) { a.pump(1); b.pump(1); } };
  settle(20);

  const groundedY = b.nw.fighters[1].y;

  // The GUEST presses W. Their own fighter is slot 1.
  b.press("KeyW");
  settle(3);
  b.release("KeyW");
  settle(25);

  const guest = b.nw.fighters[1];
  assert.ok(guest.y < groundedY - 8,
    `guest pressed W and should have left the ground (y ${guest.y} vs ${groundedY})`);

  // And the host sees the same jump, because it is the same simulation.
  const asSeenByHost = a.nw.fighters[1];
  assert.equal(JSON.stringify(asSeenByHost), JSON.stringify(guest),
    "host and guest disagree about the guest's fighter");

  // The guest moving right with D must move slot 1, not slot 0.
  const p0 = b.nw.fighters[0].x;
  const p1 = b.nw.fighters[1].x;
  b.press("KeyD");
  for (let i = 0; i < 30; i++) { a.pump(1); b.pump(1); }
  b.release("KeyD");
  settle(5);
  assert.ok(b.nw.fighters[1].x > p1 + 5, "guest's own fighter should have moved right");
  assert.equal(b.nw.fighters[0].x, p0, "the host's fighter should not have moved");

  assert.equal(a.nw.net.status.desync, null);
  assert.equal(b.nw.net.status.desync, null);
});

test("a side with no opponent input waits instead of guessing", async () => {
  const a = await bootGame();
  const outbox = [];
  a.nw.net.start({
    localSlot: 0,
    chars: ["reese", "ladeane"],
    stage: "space",
    delay: 4,
    send: (m) => outbox.push(m),
  });

  // The opening `delay` frames are primed neutral for both sides, so it can
  // run exactly that far on its own and must then stop.
  a.pump(40);
  const stalled = a.nw.net.status;
  assert.equal(stalled.stalling, true, "should be waiting on the opponent");
  assert.equal(stalled.frame, 4, "should have run exactly the primed frames");

  // Hand it the opponent's missing inputs; it should pick straight back up.
  const bits = [];
  for (let f = 0; f < 200; f++) bits.push(0);
  a.nw.net.receive({ t: "i", f: 0, b: bits });
  a.pump(60);

  const resumed = a.nw.net.status;
  assert.equal(resumed.stalling, false, "should have resumed");
  assert.ok(resumed.frame > stalled.frame, "should have advanced past the stall");
});

test("a mismatched state hash is reported as a desync", async () => {
  const a = await bootGame();
  a.nw.net.start({
    localSlot: 0,
    chars: ["kel", "kel"],
    stage: "lava",
    delay: 4,
    send: () => {},
  });

  const bits = new Array(400).fill(0);
  a.nw.net.receive({ t: "i", f: 0, b: bits });
  a.pump(120);
  assert.equal(a.nw.net.status.desync, null, "no desync expected yet");

  // Frame 0 is always a checkpoint, so the game holds a hash for it.
  a.nw.net.receive({ t: "c", f: 0, h: 0xdeadbeef });
  const d = a.nw.net.status.desync;
  assert.ok(d, "a conflicting hash should be caught");
  assert.equal(d.frame, 0);
  assert.notEqual(d.mine, d.theirs);
});

test("leaving tells the other side and ends the match", async () => {
  const a = await bootGame();
  const outbox = [];
  a.nw.net.start({
    localSlot: 0,
    chars: ["trev", "reese"],
    stage: "beach",
    delay: 4,
    send: (m) => outbox.push(m),
  });
  assert.equal(a.nw.net.active, true);

  a.nw.net.receive({ t: "bye" });
  assert.equal(a.nw.net.active, false);
  assert.equal(a.nw.net.status.ended, "opponent left");
  assert.equal(a.nw.scene, "title");
});
