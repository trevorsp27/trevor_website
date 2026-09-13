/* NerdWars: JohnnyHam's ult.
 *
 * HONEY BAKED is the only move in the game that spawns three different kinds
 * of projectile from one press -- a HamDrop, two Shocks and eight hamchunk
 * Pellets -- and it does it from a projectile's own landing rather than from
 * a frame of the caster's animation. That is a lot of new simulation state,
 * and all of it has to survive a rollback: online play rewinds and replays
 * frames constantly, so everything the ult creates gets snapshotted, thrown
 * away and rebuilt many times over inside a single match.
 *
 * So the test that matters is not "does it do damage" -- that is tuning, and
 * tuning moves. It is "do two independent copies of the engine, fed identical
 * inputs, still agree about the fight after this thing has gone off". The
 * oracle is the game's own desync detector, which hashes the exact float bits
 * of the simulation and compares them across the wire.
 *
 * Everything here runs the SHIPPED bundle, assets/js/nerdwars/game.js, rather
 * than the source it was built from, so a stale or half-written build fails.
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

/** Boot one independent copy of the engine, clock driven by hand. */
async function bootGame() {
  const view = stubCanvas(960, 540);
  const winListeners = new Map();
  const rafQueue = [];
  let clock = 0;

  const on = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };

  const sandbox = {
    console, Math: seededMath(), JSON, Date, Promise, Object, Array, Map, Set, Number,
    String, Boolean, Error, DataView, ArrayBuffer, Uint8Array, Float64Array,
    isNaN, parseInt, parseFloat,
    requestAnimationFrame: (cb) => rafQueue.push(cb),
    innerWidth: 960,
    innerHeight: 540,
    addEventListener: on(winListeners),
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
      querySelector: () => null,
      createElement: () => stubCanvas(320, 180),
      addEventListener: on(new Map()),
      documentElement: {},
      fullscreenElement: null,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SPRITES, sandbox, { filename: "sprites.js" });
  vm.runInContext(GAME, sandbox, { filename: "game.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const fire = (type, ev) => {
    for (const fn of winListeners.get(type) || []) fn(ev);
  };

  return {
    nw: sandbox.window.NerdWars,
    pump(n = 1) {
      for (let i = 0; i < n; i++) {
        const due = rafQueue.splice(0, rafQueue.length);
        clock += 1000 / 60;
        for (const cb of due) cb(clock);
      }
    },
    press: (code) => fire("keydown", { code, preventDefault() {} }),
    release: (code) => fire("keyup", { code }),
  };
}

/* Drive both sides into a real fight and spend the ult.
 *
 * The inputs react to the distance between the fighters rather than following
 * a fixed script. A fixed script was tried first and does not work: both sides
 * walk, cross straight past each other, and spend the rest of the match
 * jabbing empty air seventy pixels apart, which fills no meter and fires no
 * ult. Reacting is still perfectly deterministic -- the simulation is, so the
 * distances are, so the inputs are -- and it is also just what a player does.
 *
 * The meter charges on damage DEALT only (COMBAT.ultPerDamageDealt), so the
 * jabs have to actually land. JohnnyHam's jab reaches about eighteen pixels.
 *
 * Returns once the ham has fired and had time to land and resolve, or when the
 * frame budget runs out; the caller asserts on whether it fired at all.
 */
function fight(a, b, { frames = 2000, deliver = null } = {}) {
  const held = { a: null, b: null };
  const hold = (side, key) => {
    const s = side === "a" ? a : b;
    if (held[side] === key) return;
    if (held[side]) s.release(held[side]);
    held[side] = key;
    if (key) s.press(key);
  };

  let ultSeen = false;
  let hamFrame = -1;
  let sinceHam = 0;
  // What the ult actually put on the stage. "A fighter reached the ult state"
  // is true of every ult in the game, including the shockwave JohnnyHam used
  // to have, so it cannot tell this feature from its predecessor. These can.
  const spawned = new Set();

  for (let i = 0; i < frames; i++) {
    if (deliver) deliver();
    if (a.nw.scene !== "battle") break;

    const f = a.nw.fighters;
    const gap = f[1].x - f[0].x;

    if (Math.abs(gap) > 17) {
      // Walk toward each other. Signed, so it still closes after they cross.
      hold("a", gap > 0 ? "KeyD" : "KeyA");
      hold("b", gap > 0 ? "KeyA" : "KeyD");
    } else {
      // In range: jab to build the meter, and lean on the ult button. Pressing
      // it while the meter is short costs nothing, so it fires on the first
      // frame it is affordable.
      const phase = i % 16;
      const key = phase < 9 ? "KeyG" : phase < 13 ? "KeyL" : null;
      hold("a", key);
      hold("b", key);
    }

    a.pump(1);
    b.pump(1);

    if (!ultSeen && a.nw.fighters.some((x) => x.state === "ult")) ultSeen = true;
    for (const p of a.nw.projectiles) spawned.add(p.shape || p.kind);

    // Wait for the HAM, not merely for an ult. Waiting on the state meant that
    // in a JohnnyHam-vs-Kel match Kel charged first, the loop stopped a few
    // frames after HIS ult, and JohnnyHam never got to cast at all -- so the
    // run finished having proved nothing about the thing under test.
    if (hamFrame < 0 && spawned.has("HamDrop")) hamFrame = i;
    // Then let it fall (about thirty frames) and its chunks expire (a hundred),
    // so the assertions see the whole thing resolve.
    if (hamFrame >= 0 && ++sinceHam > 170) break;
  }

  hold("a", null);
  hold("b", null);
  return { ultSeen, hamSeen: hamFrame >= 0, hamFrame, spawned };
}

/** The three things HONEY BAKED puts on the stage, in the order they appear. */
function assertHamHappened(spawned, where) {
  const saw = [...spawned].sort().join(", ") || "nothing";
  assert.ok(spawned.has("HamDrop"),
    `no ham ever fell ${where}; what flew was: ${saw}`);
  assert.ok(spawned.has("Shock"),
    `the ham never cratered the floor ${where}; what flew was: ${saw}`);
  assert.ok(spawned.has("hamchunk"),
    `the ham never came apart ${where}; what flew was: ${saw}`);
}

test("the shipped bundle carries JohnnyHam's ham ult", async () => {
  const g = await bootGame();
  const john = g.nw.roster.find((c) => c.key === "johnnyham");

  assert.ok(john, "johnnyham missing from the roster");
  assert.equal(john.ult, "HONEY BAKED");

  // Every other ult is still where it was: a build that dropped or renamed one
  // shipped something other than what was intended. Compared as JSON because
  // the engine runs in its own vm context, so its arrays have a different
  // Array.prototype and deepStrictEqual rejects identical values.
  assert.equal(
    JSON.stringify(g.nw.roster.map((c) => c.ult)),
    JSON.stringify([
      "OUT OF THE TREES", "HONEY BAKED", "LEG DAY", "THE STROKES",
      "SHIRTS OPTIONAL", "LASER SWORD", "DESIGNATED DRIVER",
      "SIMON SLOUCH", "PLACEHOLDER ULT",
    ])
  );
});

test("the ham fires in a real match and both machines agree about it", async () => {
  const a = await bootGame();
  const b = await bootGame();

  // Both sides pick JohnnyHam, so whoever charges first the ult is his either
  // way, and a mirror makes two hams in the air at once likely -- the case
  // most able to expose state shared between them by accident.
  const chars = ["johnnyham", "johnnyham"];
  a.nw.net.start({ localSlot: 0, chars, stage: "swamp", delay: 4,
                   send: (m) => b.nw.net.receive(m) });
  b.nw.net.start({ localSlot: 1, chars, stage: "swamp", delay: 4,
                   send: (m) => a.nw.net.receive(m) });

  assert.equal(a.nw.scene, "battle");
  assert.equal(b.nw.scene, "battle");

  const { ultSeen, hamFrame, spawned } = fight(a, b);

  // Guard against a vacuous pass: without these, everything below would be
  // asserting about a match in which none of the new code ever ran. Checking
  // the state alone is not enough -- this whole test passed against the
  // previous build, where the same button produced a plain shockwave.
  assert.ok(ultSeen, "no fighter ever entered the ult state");
  assertHamHappened(spawned, "in the match");

  const sa = a.nw.net.status;
  const sb = b.nw.net.status;

  assert.equal(sa.desync, null,
    `player 1 desynced; the ham fired on frame ${hamFrame}`);
  assert.equal(sb.desync, null,
    `player 2 desynced; the ham fired on frame ${hamFrame}`);
  assert.equal(sa.frame, sb.frame,
    "the two sides simulated a different number of frames");

  assert.equal(
    JSON.stringify(a.nw.fighters),
    JSON.stringify(b.nw.fighters),
    "the two machines disagree about the fight after the ham went off"
  );
  // Projectiles are simulation state too. One press of this ult puts eleven
  // of them on the stage, and a divergence among those stays invisible in the
  // fighter comparison until it happens to hit somebody.
  assert.equal(
    JSON.stringify(a.nw.projectiles),
    JSON.stringify(b.nw.projectiles),
    "the two machines disagree about what is in the air"
  );
});

test("rollback survives the ham: a laggy link reaches the same fight", async () => {
  // The ham lands from a projectile's own update and spawns ten more
  // projectiles at that instant. On a laggy link that landing frame is
  // predicted, discarded and replayed over and over, so this is where a
  // snapshot that missed something would surface.
  const a = await bootGame();
  const b = await bootGame();

  const chars = ["johnnyham", "johnnyham"];
  const wire = [];
  const LAG = 7;
  a.nw.net.start({ localSlot: 0, chars, stage: "matrix", delay: 2,
                   send: (m) => wire.push({ to: "b", m, due: LAG }) });
  b.nw.net.start({ localSlot: 1, chars, stage: "matrix", delay: 2,
                   send: (m) => wire.push({ to: "a", m, due: LAG }) });

  // Seven frames of one-way delay, so most frames are a guess corrected later.
  const deliver = () => {
    for (const e of wire) e.due--;
    for (let k = wire.length - 1; k >= 0; k--) {
      if (wire[k].due > 0) continue;
      const { to, m } = wire[k];
      wire.splice(k, 1);
      (to === "a" ? a : b).nw.net.receive(m);
    }
  };

  const { spawned } = fight(a, b, { deliver });

  assertHamHappened(spawned, "over the laggy link");
  assert.equal(a.nw.net.status.desync, null, "player 1 desynced over the laggy link");
  assert.equal(b.nw.net.status.desync, null, "player 2 desynced over the laggy link");
  assert.ok(a.nw.net.status.rollbacks > 0,
    "no rollbacks happened, so the delayed link never exercised one");
  assert.equal(
    JSON.stringify(a.nw.fighters),
    JSON.stringify(b.nw.fighters),
    "the two machines disagree after rolling back through the ham"
  );
  assert.equal(
    JSON.stringify(a.nw.projectiles),
    JSON.stringify(b.nw.projectiles),
    "the two machines disagree about what is in the air after a rollback"
  );
});
