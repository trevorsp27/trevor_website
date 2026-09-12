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
    Math: seededMath(),
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
      hidden: false,
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
    /* Hide the tab, the way a browser does: set document.hidden and fire the
       event. A hidden tab also stops pumping, which the caller does. */
    setHidden(v) {
      sandbox.document.hidden = v;
      fire(docListeners, "visibilitychange", {});
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

test("a side with no opponent input guesses ahead instead of freezing", async () => {
  const a = await bootGame();
  const outbox = [];
  a.nw.net.start({
    localSlot: 0,
    chars: ["reese", "ladeane"],
    stage: "space",
    delay: 1,
    send: (m) => outbox.push(m),
  });

  // Under lockstep this stopped dead at the primed frames. It should now keep
  // simulating on a guess, and only stop once the guess would have to reach
  // further ahead than a rollback could undo.
  a.pump(80);
  const guessing = a.nw.net.status;
  assert.ok(
    guessing.frame > 10,
    `should have guessed well past the primed frames, got ${guessing.frame}`
  );
  assert.equal(guessing.stalling, true, "should stop at the rollback limit");
  assert.equal(guessing.desync, null, "guessing is not divergence");

  // Nothing may be treated as agreed while it is still a guess: confirming a
  // frame is what licenses the hash comparison, and comparing a guessed frame
  // would report a desync that has not happened.
  assert.ok(
    guessing.confirmedFrame < guessing.frame,
    "frames run on a guess must not count as confirmed"
  );

  // Hand it the opponent's missing inputs; it should pick straight back up.
  const bits = [];
  for (let f = 0; f < 400; f++) bits.push(0);
  a.nw.net.receive({ t: "i", f: 0, b: bits });
  a.pump(60);

  const resumed = a.nw.net.status;
  assert.equal(resumed.stalling, false, "should have resumed");
  assert.ok(resumed.frame > guessing.frame, "should have advanced past the stall");
  assert.equal(resumed.desync, null, "resuming must not have diverged");
});

test("two engines on a laggy link roll back and stay identical", async () => {
  const a = await bootGame();
  const b = await bootGame();

  // A frame-quantised link: anything sent on pump N arrives on pump N+LAG.
  // Six frames is longer than the one frame of input delay, so NEITHER side
  // can ever have the other's input in time -- every frame is simulated from
  // a guess and then corrected. That is the path this test exists to cover.
  const LAG = 6;
  let now = 0;
  const wire = [];
  const post = (to, m) => wire.push({ at: now + LAG, to, m });
  const flush = () => {
    for (let i = wire.length - 1; i >= 0; i--) {
      if (wire[i].at <= now) {
        const p = wire.splice(i, 1)[0];
        (p.to === "a" ? a : b).nw.net.receive(p.m);
      }
    }
  };

  a.nw.net.start({ localSlot: 0, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post("b", m) });
  b.nw.net.start({ localSlot: 1, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post("a", m) });

  const p1 = ["KeyD", "KeyF", "KeyW", "KeyA", "KeyG", "ShiftLeft", "KeyS", "KeyQ"];
  const p2 = ["KeyA", "KeyC", "KeyW", "KeyD", "KeyR", "KeyG", "KeyQ", "KeyS"];
  let ha = null, hb = null;

  for (let i = 0; i < 900; i++) {
    flush();
    if (i % 7 === 0) { if (ha) a.release(ha); ha = p1[(i / 7) % p1.length | 0]; a.press(ha); }
    if (i % 5 === 0) { if (hb) b.release(hb); hb = p2[(i / 5) % p2.length | 0]; b.press(hb); }
    a.pump(1);
    b.pump(1);
    now++;
  }

  const sa = a.nw.net.status, sb = b.nw.net.status;

  assert.ok(sa.rollbacks > 0, "the link is too slow for anything else: expected rollbacks");
  assert.ok(sa.resimFrames > sa.rollbacks, "a rollback should replay more than nothing");
  assert.equal(sa.desync, null, "player 1 saw a desync");
  assert.equal(sb.desync, null, "player 2 saw a desync");
  assert.ok(sa.frame > 500, `expected real progress, got frame ${sa.frame}`);

  // The hash check only ever compares confirmed frames, so it being clean
  // above is the real assertion. This pins the other half: both sides agreed
  // on enough frames for that comparison to have actually run.
  assert.ok(
    sa.confirmedFrame > 400,
    `expected most frames confirmed, got ${sa.confirmedFrame}`
  );
});

test("a mutual stall recovers once the link comes back", async () => {
  const a = await bootGame();
  const b = await bootGame();

  // A link that can be cut. While it is down packets are DROPPED, not queued,
  // which is the case that used to be fatal: both sides run out of opponent
  // input, both stop at the rollback limit, and a stalled side used to
  // transmit nothing at all -- so neither could ever un-stall the other and
  // the match hung forever with no way out but closing the tab.
  let up = true;
  const inbox = [];
  const post = (to, m) => { if (up) inbox.push({ to, m }); };
  const flush = () => {
    while (inbox.length) {
      const p = inbox.shift();
      (p.to === "a" ? a : b).nw.net.receive(p.m);
    }
  };

  a.nw.net.start({ localSlot: 0, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post("b", m) });
  b.nw.net.start({ localSlot: 1, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post("a", m) });

  const run = (n) => { for (let i = 0; i < n; i++) { flush(); a.pump(1); b.pump(1); } };

  run(60);
  const before = a.nw.net.status.frame;
  assert.ok(before > 40, "should be running normally before the outage");

  // Pull the plug on both directions for long enough to outlast the guess
  // window on both sides.
  up = false;
  inbox.length = 0;
  run(90);

  const stalled = a.nw.net.status;
  assert.equal(stalled.stalling, true, "both sides should have run out of guesses");

  // Plug it back in. Nothing sent during the outage survived, so recovery has
  // to come from packets sent AFTER it -- which only happens if a stalled
  // side keeps transmitting.
  up = true;
  run(120);

  const sa = a.nw.net.status, sb = b.nw.net.status;
  assert.equal(sa.stalling, false, "player 1 never recovered from the outage");
  assert.equal(sb.stalling, false, "player 2 never recovered from the outage");
  assert.ok(sa.frame > stalled.frame + 30,
    `should have advanced well past the stall, got ${sa.frame} from ${stalled.frame}`);
  assert.equal(sa.desync, null, "player 1 diverged across the outage");
  assert.equal(sb.desync, null, "player 2 diverged across the outage");
});

test("the scene is part of the snapshot, so a match end can be rewound", async () => {
  const a = await bootGame();
  a.nw.net.start({
    localSlot: 0,
    chars: ["kel", "trev"],
    stage: "swamp",
    delay: 1,
    send: () => {},
  });

  // Run forward on guesses, then hand over a contradicting input for a frame
  // already simulated. The rollback must restore everything the simulation
  // owns -- and `scene` is part of that, because updateBattle ends the match
  // by setting it. A KO decided on a guessed frame used to be irreversible.
  a.pump(30);
  const mid = a.nw.net.status.frame;
  assert.ok(mid > 5, "should have guessed forward");

  const before = a.nw.net.status.rollbacks;
  const held = [];
  for (let i = 0; i < 12; i++) held.push(3);      // left+right held: not a guess
  a.nw.net.receive({ t: "i", f: Math.max(0, mid - 10), b: held });
  a.pump(5);

  const after = a.nw.net.status;
  assert.ok(after.rollbacks > before, "a contradicted guess should have rewound");
  assert.equal(after.desync, null, "rewinding is not divergence");
  assert.equal(a.nw.scene, "battle", "the rollback must leave us in the match");
  assert.ok(after.frame >= mid, "should have replayed back up to where it was");
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

/* A peer whose browser cannot hold 60fps.
 *
 * This is the thing that actually froze real matches, and it is not a network
 * problem at all. If they produce 59 input frames a second and I consume 60,
 * the gap between my frame and their newest input grows by one every second,
 * without bound; twenty seconds later it crosses the rollback ceiling and I
 * stall -- and then keep stalling, because nothing about stalling makes them
 * catch up. Measured before the fix: a peer at 59fps froze the game 19.8% of
 * the time, at 55fps 87%, while the worst network in the lab managed 0.1%.
 *
 * Adaptive delay cannot help and the numbers showed it: the slow side pegged
 * its delay at the maximum and nothing changed. Delay is a fixed offset; this
 * is a difference in rate. The fix is to pace the local clock so the faster
 * machine gives frames back gradually and the two converge.
 */
test("a peer whose machine runs slow does not freeze the match", async () => {
  const a = await bootGame();
  const b = await bootGame();

  const chars = ["kel", "trev"];
  a.nw.net.start({ localSlot: 0, chars, stage: "swamp", delay: 1,
                   send: (m) => b.nw.net.receive(m) });
  b.nw.net.start({ localSlot: 1, chars, stage: "swamp", delay: 1,
                   send: (m) => a.nw.net.receive(m) });

  // B manages 57 of every 60 frames. Small enough that a person would call
  // their machine fine; more than enough to wedge the old code permanently.
  let credit = 0;
  let stalledFrames = 0;
  for (let t = 0; t < 1500; t++) {
    a.pump(1);
    credit += 57 / 60;
    while (credit >= 1) { b.pump(1); credit -= 1; }
    if (a.nw.net.status.stalling) stalledFrames++;
  }

  assert.equal(a.nw.net.status.desync, null, "pacing must not change the simulation");
  assert.ok(
    stalledFrames < 30,
    `the fast side froze for ${stalledFrames} of 1500 frames; before frame ` +
    "pacing this was over a thousand"
  );
  // Non-vacuous: the match has to have actually run, or "it never stalled" is
  // true of a match that never started.
  assert.ok(a.nw.net.status.frame > 1000,
    `expected a real match, got frame ${a.nw.net.status.frame}`);
});

test("pacing does not slow a match down when both sides keep up", async () => {
  // The trade this fix must not make: slowing healthy matches to rescue broken
  // ones. On a link where nobody is behind, pacing must never engage.
  const a = await bootGame();
  const b = await bootGame();
  const chars = ["kel", "trev"];
  a.nw.net.start({ localSlot: 0, chars, stage: "swamp", delay: 1,
                   send: (m) => b.nw.net.receive(m) });
  b.nw.net.start({ localSlot: 1, chars, stage: "swamp", delay: 1,
                   send: (m) => a.nw.net.receive(m) });

  for (let t = 0; t < 600; t++) { a.pump(1); b.pump(1); }

  assert.equal(a.nw.net.status.stalling, false);
  assert.equal(a.nw.net.status.desync, null);
  // Both machines ran every frame they were given: no frames were paced away.
  assert.ok(a.nw.net.status.frame >= 595,
    `healthy play should not lose frames, got ${a.nw.net.status.frame} of 600`);
});

/* Distance is not a fault, and must not be charged for.
 *
 * The first version of frame pacing keyed off "how far ahead am I of the
 * newest input I hold from them", which latency depresses exactly as much as a
 * slow peer does. So two perfectly healthy machines paced simply because they
 * were far apart: measured at the time, a 334ms link lost about 9% of its
 * frames permanently, in exchange for nothing -- a standing offset from
 * latency is not a rate difference, and running slower cannot close it.
 *
 * That is the same reason input delay could not fix the original freeze, so it
 * was a mistake worth pinning down. Pacing now keys off proximity to the
 * rollback ceiling, which only a rate difference approaches.
 *
 * A zero-latency link cannot catch this: it is the one case where the old
 * signal and the new one agree.
 */
test("a distant but healthy link is not slowed down", async () => {
  for (const lag of [8, 16, 24]) {
    const a = await bootGame();
    const b = await bootGame();
    const chars = ["kel", "trev"];
    const wire = [];
    const post = (to, m) => wire.push({ to, m, due: lag });
    a.nw.net.start({ localSlot: 0, chars, stage: "swamp", delay: 1,
                     send: (m) => post("b", m) });
    b.nw.net.start({ localSlot: 1, chars, stage: "swamp", delay: 1,
                     send: (m) => post("a", m) });

    const TICKS = 900;
    for (let t = 0; t < TICKS; t++) {
      for (const e of wire) e.due--;
      for (let k = wire.length - 1; k >= 0; k--) {
        if (wire[k].due > 0) continue;
        const { to, m } = wire[k];
        wire.splice(k, 1);
        (to === "a" ? a : b).nw.net.receive(m);
      }
      a.pump(1);
      b.pump(1);
    }

    // Both machines hold a perfect 60fps here; the only variable is distance.
    // Every real frame must still produce a simulated one.
    const ran = a.nw.net.status.frame;
    assert.ok(ran >= TICKS - 10,
      `at ${lag} frames of one-way lag (~${Math.round(lag * 16.7)}ms) a healthy ` +
      `match advanced only ${ran} of ${TICKS} frames -- pacing is charging for ` +
      "distance, which it cannot fix and must not tax");
    assert.equal(a.nw.net.status.desync, null);
  }
});

/* Pacing and the delay tuner read the same number for incompatible purposes.
 *
 * Input delay is spent on the opponent's behalf: when they report having to
 * guess a long way, we add delay so they guess less. That works against
 * latency and jitter. It does nothing at all once pacing has engaged, because
 * pacing PINS the gap at whatever value makes our rate equal theirs -- a frame
 * of delay that shrinks the gap makes us pace less, and it opens straight back
 * up. Measured while writing this: delay 1 against delay 8 moved the
 * prediction distance from 28.036 frames to 28.035.
 *
 * So a paced match used to walk the delay to the cap and park seven frames --
 * 117ms -- of input lag on the machine already struggling, in exchange for
 * nothing, and leave it there. In a fighting game that is a lot to pay for
 * a measurement that was never a request for help.
 */
test("a paced match does not also pile on input delay", async () => {
  const a = await bootGame();
  const b = await bootGame();
  const chars = ["kel", "trev"];
  a.nw.net.start({ localSlot: 0, chars, stage: "swamp", delay: 1,
                   send: (m) => b.nw.net.receive(m) });
  b.nw.net.start({ localSlot: 1, chars, stage: "swamp", delay: 1,
                   send: (m) => a.nw.net.receive(m) });

  // Slow enough to be firmly inside the pacing band.
  let credit = 0;
  for (let t = 0; t < 1500; t++) {
    a.pump(1);
    credit += 55 / 60;
    while (credit >= 1) { b.pump(1); credit -= 1; }
  }

  // Precondition: this is a paced match, not a healthy one that proves nothing.
  assert.equal(a.nw.net.status.stalling, false, "pacing should have kept it running");
  assert.ok(a.nw.net.status.frame > 1000, "the match has to have actually run");

  const worst = Math.max(a.nw.net.status.delay, b.nw.net.status.delay);
  assert.ok(worst <= 3,
    `input delay reached ${worst} frames (~${Math.round(worst * 16.7)}ms) in a ` +
    "paced match, where delay provably cannot reduce the prediction distance");
});

/* Rollback smoothing.
 *
 * Rollback rewinds and replays, and the corrected position lands in the very
 * next painted frame. Measured on a 200ms link with a fighter reversing the
 * way a person does: on its own machine the worst single-frame movement is
 * 3px, and on the peer's machine the SAME fighter moved up to 35px in one
 * frame -- more than two body widths, twenty-three times in five seconds.
 * That is what "multiplayer looks choppy" was.
 *
 * The fix draws the fighter a little behind the truth for a few frames after
 * a correction. It must not touch the simulation, which is the first thing
 * asserted here.
 */
test("a rollback correction is eased into the picture, not snapped", async () => {
  const a = await bootGame();
  const b = await bootGame();
  const wire = [];
  const LAG = 12;                                   // ~200ms each way
  const post = (to, m) => wire.push({ to, m, due: LAG });
  a.nw.net.start({ localSlot: 0, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post(1, m) });
  b.nw.net.start({ localSlot: 1, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post(0, m) });
  const gs = [a, b];

  const drawn = [];      // seat 0 as the PEER paints it
  const raw = [];        // seat 0's simulation position on the same machine
  let held = null;
  for (let i = 0; i < 300; i++) {
    // Reversing constantly is the point: holding one key makes prediction
    // always right, which produces almost no rollbacks and tests nothing.
    if (i % 11 === 0) {
      const want = (i / 11) % 2 === 0 ? "KeyD" : "KeyA";
      if (held) { a.release(held); b.release(held); }
      a.press(want); b.press(want); held = want;
    }
    for (const e of wire) e.due--;
    for (let k = wire.length - 1; k >= 0; k--) {
      if (wire[k].due > 0) continue;
      const { to, m } = wire[k];
      wire.splice(k, 1);
      gs[to].nw.net.receive(m);
    }
    a.pump(1); b.pump(1);
    const off = b.nw.__test.renderOffsets.find((o) => o.slot === 0);
    raw.push(b.nw.fighters[0].x);
    drawn.push(b.nw.fighters[0].x + (off ? off.dx : 0));
  }

  assert.ok(b.nw.net.status.rollbacks > 5,
    "expected real rollbacks to smooth, got " + b.nw.net.status.rollbacks);

  const jumps = (xs) => {
    let big = 0, worst = 0;
    for (let i = 1; i < xs.length; i++) {
      const d = Math.abs(xs[i] - xs[i - 1]);
      if (d > 8) big++;
      if (d > worst) worst = d;
    }
    return { big, worst };
  };
  const before = jumps(raw);      // what would have been drawn without this
  const after = jumps(drawn);     // what is drawn now

  assert.ok(before.big > 0,
    "the unsmoothed position should teleport, or there is nothing to fix");

  /* The worst single-frame jump is the assertion, not the count of jumps
     over some threshold. Counting them is sensitive to exactly where the
     distribution sits relative to the threshold, and it cannot improve past
     the clamp: a 38px correction with VIS_MAX at 20 still leaves an 18px
     step, which is much better and still over 8. Halving the worst case is
     the property that actually holds, and it holds at every latency. */
  assert.ok(
    after.worst < before.worst * 0.65,
    "worst single-frame jump should shrink by at least a third: was " +
      before.worst.toFixed(1) + "px, now " + after.worst.toFixed(1) + "px"
  );
  assert.ok(after.big <= before.big,
    "and no more teleporting frames than before: " + before.big + " -> " + after.big);
});

/* The property everything else depends on: this is a drawing change. If it
   ever touched the simulation it would desync a match, which is far worse
   than the stutter it exists to fix. */
test("smoothing changes the picture and not the simulation", async () => {
  const a = await bootGame();
  const b = await bootGame();
  a.nw.net.start({ localSlot: 0, chars: ["kel", "trev"], stage: "swamp",
                   delay: 2, send: (m) => b.nw.net.receive(m) });
  b.nw.net.start({ localSlot: 1, chars: ["kel", "trev"], stage: "swamp",
                   delay: 2, send: (m) => a.nw.net.receive(m) });

  let held = null;
  for (let i = 0; i < 200; i++) {
    if (i % 9 === 0) {
      const want = (i / 9) % 2 === 0 ? "KeyD" : "KeyA";
      if (held) { a.release(held); b.release(held); }
      a.press(want); b.press(want); held = want;
    }
    a.pump(1); b.pump(1);
  }

  assert.equal(a.nw.net.status.desync, null, "no desync");
  assert.equal(b.nw.net.status.desync, null, "no desync");
  assert.equal(
    JSON.stringify(a.nw.fighters),
    JSON.stringify(b.nw.fighters),
    "both machines must still agree about where everybody actually is"
  );
});

/* Input delay is the one cost the player feels directly, so it has to be
   earned. It is only worth paying when it prevents a stall -- and measured
   against a lossy, jittery link in a four-player room, it never did: the room
   stalls zero frames whether the cap is 2 or 8, because past about 150ms the
   pacing path gives the delay back anyway.
   
   What the old cap of 8 actually did was park 110ms on the stick within the
   first few seconds and leave it there, because the tuner raises delay while
   peers look far ahead and a lossy link never stops looking that way.
   
   This drives exactly that condition and asserts the delay stays low. It fails
   if NET_MAX_DELAY goes back up, and it fails if the tuner is changed to climb
   faster -- both of which would be invisible in every other test here. */
test("a lossy link does not park input delay on the stick", async () => {
  const a = await bootGame();
  const b = await bootGame();

  // Deterministic loss and jitter: a flaky result here would be worse than
  // no test, because the thing it guards is a tuning constant.
  let seed = 20260908;
  const rand = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };

  let now = 0;
  const wire = { ab: [], ba: [] };
  const blocked = { ab: -1, ba: -1 };
  const LAT = 7;                       // ~115ms, a friend two time zones away
  /* Ordered-reliable delivery, which is what the PeerJS channel gives us: a
     lost packet is retransmitted and everything behind it waits. That queueing
     is what makes peers look far ahead and drives the tuner up. */
  const post = (k, m) => {
    let at = now + LAT + Math.floor(rand() * 2);
    if (rand() < 0.07) { at = now + LAT * 3; blocked[k] = Math.max(blocked[k], at); }
    else if (at < blocked[k]) at = blocked[k];
    wire[k].push({ at, m });
  };
  const flush = (k, dest) => {
    for (let i = wire[k].length - 1; i >= 0; i--) {
      if (wire[k][i].at <= now) dest.nw.net.receive(wire[k].splice(i, 1)[0].m);
    }
  };

  a.nw.net.start({ localSlot: 0, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post("ab", m) });
  b.nw.net.start({ localSlot: 1, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post("ba", m) });

  const keys = ["KeyD", "KeyA", "KeyW", "KeyG"];
  let worstDelay = 0;
  let stalls = 0;
  for (let f = 0; f < 900; f++) {
    now = f;
    flush("ab", b); flush("ba", a);
    if (f % 7 === 0) a.press(keys[(f / 7 | 0) % keys.length]);
    if (f % 7 === 4) a.release(keys[(f / 7 | 0) % keys.length]);
    if (f % 9 === 0) b.press(keys[(f / 9 | 0) % keys.length]);
    if (f % 9 === 5) b.release(keys[(f / 9 | 0) % keys.length]);
    a.pump(1); b.pump(1);
    worstDelay = Math.max(worstDelay, a.nw.net.status.delay, b.nw.net.status.delay);
    if (a.nw.net.status.stalling || b.nw.net.status.stalling) stalls++;
  }

  assert.equal(stalls, 0, "a 115ms link with 7% loss should never stall the sim");
  assert.ok(
    worstDelay <= 3,
    "input delay climbed to " + worstDelay + " frames (" +
      Math.round(worstDelay * 16.67) + "ms) on a link that never needed it. " +
      "Delay is only worth paying to prevent a stall, and there were none."
  );
  assert.equal(a.nw.net.status.desync, null, "no desync");
  assert.equal(b.nw.net.status.desync, null, "no desync");
});

/* A hidden tab fires no requestAnimationFrame, so that machine stops
 * simulating AND stops sending input. Measured before the fix: the player who
 * stayed froze 0.38s later and got 37 of the next 300 frames, with a worst
 * stall of 260 frames -- four of the five seconds of a five-second absence
 * lost by somebody who had done nothing.
 *
 * A peer that ANNOUNCES it is hidden is not a peer that is lagging: it is a
 * machine receiving no key events, so "they pressed nothing" is the truth
 * rather than a guess, and the others can fill it in. The announcement is
 * what makes it safe -- the same assumption on a timer, against a merely slow
 * peer, would desync the match.
 */
test("one player tabbing out does not freeze everybody else", async () => {
  const a = await bootGame();
  const b = await bootGame();

  let now = 0;
  const wire = [];
  const LAG = 3;
  const post = (to, m) => wire.push({ at: now + LAG, to, m });
  const flush = () => {
    for (let i = wire.length - 1; i >= 0; i--) {
      if (wire[i].at <= now) {
        const p = wire.splice(i, 1)[0];
        (p.to === "a" ? a : b).nw.net.receive(p.m);
      }
    }
  };

  a.nw.net.start({ localSlot: 0, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post("b", m) });
  b.nw.net.start({ localSlot: 1, chars: ["kel", "trev"], stage: "swamp",
                   delay: 1, send: (m) => post("a", m) });

  const AWAY = 120, BACK = 420, TOTAL = 1200;
  let ran = 0;
  for (let f = 0; f < TOTAL; f++) {
    now = f;
    flush();
    if (f % 9 === 0) a.press("KeyD");
    if (f % 9 === 5) a.release("KeyD");
    if (f === AWAY) b.setHidden(true);
    if (f === BACK) b.setHidden(false);

    const before = a.nw.net.status.frame;
    a.pump(1);
    if (f < AWAY || f >= BACK) b.pump(1);
    if (f >= AWAY && f < BACK && a.nw.net.status.frame > before) ran++;
  }

  const sa = a.nw.net.status;
  const sb = b.nw.net.status;

  assert.equal(sa.worstStall, 0,
    "the player who stayed should never hit the stall gate; worst stall was " +
      sa.worstStall + " frames");
  assert.ok(ran > (BACK - AWAY) * 0.7,
    "they should keep playing through the absence, but simulated only " + ran +
      " of the " + (BACK - AWAY) + " frames it lasted");
  assert.ok(sa.coveredFrames > 0,
    "somebody has to have been filled in for, or this proves nothing");

  // And the whole point of doing it on evidence rather than on a timer.
  assert.equal(sa.desync, null, "no desync on the machine that stayed");
  assert.equal(sb.desync, null, "no desync on the machine that left");
  assert.equal(sa.frame, sb.frame,
    "they should be back in step: " + sa.frame + " vs " + sb.frame);
});
