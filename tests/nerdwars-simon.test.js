/* Simon's base kit, move by move: the HOTDOG, the SLOTS, the GUILLOTINE and
 * the SLOUCH.
 *
 * Each move is driven through the real input path -- netplay pads, one per
 * seat, the same way a rollback replays a frame -- and read back one frame at
 * a time, because most of what makes these moves what they are is WHEN
 * something happens: the frame a reel lands, the frame the bun drops, the
 * frame the choke ticks. A single reading at the end would pass a kit that
 * did the right things in the wrong order.
 *
 * Every test here has a negative control beside it: the same measurement run
 * against a copy of the engine with ONE line changed in memory, and the
 * check is that the same assertions then fail. A test whose sabotage does
 * not fail it is measuring nothing, and the sabotaged copies are never
 * written anywhere.
 *
 * The guards on these moves -- the jackpot and wake rings skipping a corpse,
 * the grounded-only slouch, sleepers waking early, the split being heard in
 * every state -- are pinned in nerdwars-simon-review.test.js. This file is
 * the shape of the kit itself: the hotdog's arc and split, the reels and
 * their payouts, the choke and the drop, and the sleep -- with the ten-second
 * free-mana window that now rides on it and the soul that climbs out of him.
 *
 * These load the engine source, as nerdwars-kel-buff.test.js does, because
 * none of this is reachable through NerdWars.fighters: projectiles, hitbox(),
 * payout() and the reels are all internals.
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
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");

/* Stores what is written to it, unlike a discard-everything stub: the engine
   reads back properties it sets (fillStyle, globalAlpha), and a test cannot
   install a spy on a context that throws writes away. */
function stubContext() {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return () => ({ addColorStop() {} });
      }
      if (key === "measureText") return () => ({ width: 0 });
      if (key === "canvas") return { width: 0, height: 0 };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {},
    getContext: () => stubContext(),
    /* Kept rather than thrown away, so a test can deliver a real mousedown to
       the engine's own listener instead of reaching past it. Everything the
       menus do with a mouse -- mapping a client point onto the canvas, hit
       testing the rects the last frame registered, running the action -- is
       behind this one handler, and a test that calls the action directly is
       testing none of it. */
    __on: {},
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

/* `engineSrc` is the one addition to the shared harness: the source to run
   instead of the file on disk, which is how a negative control boots its
   sabotaged copy without that copy ever touching the disk. */
async function bootEngine(engineSrc) {
  const view = stubCanvas(960, 540);
  const sandbox = {
    console, Math: seededMath(), JSON, Date, Promise, Object, Array, Map, Set, Number,
    String, Boolean, Error, DataView, ArrayBuffer, Uint8Array, Float32Array,
    Float64Array, isNaN, parseInt, parseFloat,
    requestAnimationFrame: () => {},
    innerWidth: 960, innerHeight: 540, addEventListener() {},
    Image: class {
      constructor() { this.complete = true; this.naturalWidth = 16; this.naturalHeight = 16; }
      set src(v) { if (this.onload) this.onload(); }
    },
    document: {
      getElementById: (id) => (id === "nw-canvas" || id === "game" ? view : null),
      querySelector: () => null,
      createElement: () => stubCanvas(320, 180),
      addEventListener() {},
      documentElement: {},
      fullscreenElement: null,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SPRITES, sandbox, { filename: "sprites.js" });
  vm.runInContext(
    "var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES," +
      "UI=window.NERDWARS_ASSETS.UI;", sandbox);
  vm.runInContext(engineSrc || readFileSync(ENGINE_PATH, "utf8"), sandbox,
    { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return (src) => vm.runInContext(src, sandbox);
}

const tapKey = (run, code) => run(`(function () {
  held.clear(); prevHeld.clear(); held.add(${JSON.stringify(code)});
  step();
  held.clear(); prevHeld.clear();
  return scene;
})()`);

/* ------------------------------------------------------------------ */

/* A copy of the engine with exactly one passage changed, built in memory for
   a negative control. The needle has to be found exactly once: a needle that
   is missing would boot the real engine and pass the control for nothing,
   and one that matches twice would change a line the control never meant
   to. Both are the silent-no-op failure that string edits to this file are
   known for, so both are refused loudly here. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* The other half of a negative control: the SAME checker the real test ran,
   and it has to throw an assertion. Anything else thrown is a broken checker,
   not a failed test, and is let through. */
function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e instanceof assert.AssertionError) return e.message;
    throw e;
  }
  assert.fail(why);
}

/* Simon in seat 0, Reese in seat 1. Reese because he is a plain body to
   throw things at -- no projectile of his own to muddy who hit whom -- and
   because he is the other buff character, which is the thing the slouch
   aura must not tangle with. The warmup runs both CPUs off Math.random and
   is reset out of again before every measurement. */
async function simonVsReese(opts) {
  const o = opts || {};
  const run = await bootEngine(o.engine);
  run("select.cursor=[7,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=" + (o.stage || 0) + "; startBattle();");
  run("for (var i=0;i<" + (o.warmup == null ? 130 : o.warmup) + ";i++) step();");
  assert.equal(run("fighters.map(function (f) { return f.key; }).join(',')"),
    "simon,reese", "precondition: ORDER should seat Simon at 7 and Reese at 4");
  run(HELPERS);
  return run;
}

/* Readers installed in the sandbox once per boot, so a per-frame record is
   one expression. They return plain copies -- primitives in an object that
   JSON.stringify then carries across the vm boundary -- never the live
   projectile. */
const HELPERS = `
  function shotOf(cls, piece) {
    for (var k = 0; k < projectiles.length; k++) {
      var b = projectiles[k];
      if (b instanceof cls && !b.dead && (piece == null || b.piece === piece)) return b;
    }
    return null;
  }
  function countOf(cls, piece) {
    var n = 0;
    for (var k = 0; k < projectiles.length; k++) {
      var b = projectiles[k];
      if (b instanceof cls && !b.dead && (piece == null || b.piece === piece)) n++;
    }
    return n;
  }
  function pick(b, keys) {
    if (!b) return null;
    var o = {};
    keys.forEach(function (k) { o[k] = b[k]; });
    return o;
  }`;

/* The numbers the tests measure against, read once per boot. Nested specs
   cross the boundary as JSON; nothing here is compared by identity. */
const SPEC = (run) => JSON.parse(run(`JSON.stringify({
  n: ROSTER.simon.specials.neutral, d: ROSTER.simon.specials.down,
  u: ROSTER.simon.specials.up, ult: ROSTER.simon.ult,
  manaMax: COMBAT.manaMax, maxHealth: COMBAT.maxHealth, ultMax: COMBAT.ultMax,
  gravity: PHYS.gravity, friction: PHYS.groundFriction, landLag: PHYS.landLag,
  main: STAGE.platforms.find(function (p) { return p.main; }) })`));

const RIGHT = 2, SHIELD = 128, ULT = 256, SP_NEUTRAL = 512, SP_DOWN = 1024, SP_UP = 2048;

/* Both of them clean and standing on the main floor, Simon on the left
   facing in and Reese far across the stage. Everything the warmup could have
   left behind is put back: a CPU Simon may well have pulled the lever or
   thrown a hotdog in those frames, so the reels, the air-cast flag and the
   split flag are cleared along with the usual state. */
const RESET = `
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    var NEUTRAL = ROSTER.simon.specials.neutral, DOWN = ROSTER.simon.specials.down,
        UP = ROSTER.simon.specials.up, SLOUCH = ROSTER.simon.ult;
    projectiles.length = 0; effects.length = 0;
    freezeFrames = 0; banner = null;
    [me, foe].forEach(function (f) {
      f.setState('idle');
      f.timer = 0; f.hitstun = 0; f.hitstop = 0; f.landLag = 0;
      f.invuln = 0; f.mana = 999; f.vx = 0; f.vy = 0;
      f.grabbing = -1; f.grabbedBy = -1; f.grabTimer = 0; f.grounded = true;
      f.specialSpawned = false; f.hasHit = false; f.attackFrame = 0;
      f.stocks = 99; f.health = 100; f.combo = 0; f.sinceHitFrames = 999;
      f.poison = 0; f.burn = 0; f.confused = 0; f.drowsy = 0;
      f.swordTimer = 0; f.buffTimer = 0; f.buffStats = null;
      f.shield = COMBAT.shieldMax; f.ultMeter = 0; f.evadeCd = 0;
      f.reels = [-1, -1, -1]; f.reelT = 0; f.reelStops = 0; f.reelSeed = 0;
      f.airCast = false; f.hotdogSplit = false; f.jumpsLeft = PHYS.airJumps;
      f.y = main.y; f.prevY = main.y;
    });
    me.x = main.x + 40; me.facing = 1;
    foe.x = main.x + main.w - 30; foe.facing = -1;`;

/* Steps the match `frames` times through netplay pads and records one
   object per frame, read AFTER the step. `p0` and `p1` are expressions in
   `i` giving each seat's button bits for that frame -- specials and the ult
   are edge-triggered, so a press is the bit on one frame only. `pre` runs
   before each step, which is how a test holds a fighter in the air or keeps
   one untouchable. Hitstop is pinned off Simon so a hit never pauses his
   clock mid-measurement; mana is pinned unless the test is about mana. */
const DRIVE = (frames, o) => `
    var log = [];
    netplay.active = true;
    for (var i = 0; i < ${frames}; i++) {
      me.hitstop = 0; ${o.mana === false ? "" : "me.mana = 999;"}
      ${o.pre || ""}
      netplay.framePads = [bitsToPad(${o.p0 || "0"}), bitsToPad(${o.p1 || "0"})];
      step();
      log.push(${o.rec});
    }
    netplay.active = false; netplay.framePads = null;`;

const drive = (run, setup, frames, o) => JSON.parse(run(`(function () {
    ${RESET}
    ${setup || ""}
    ${DRIVE(frames, o)}
    return JSON.stringify(log);
  })()`));

const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

/* =====================================================================
   HOTDOG
   ===================================================================== */

const HOTDOG_FLIGHT = {
  pre: "foe.invuln = 9999;",     // nothing to hit: this is about the arc
  p0: `i === 0 ? ${SP_NEUTRAL} : 0`,
  rec: "{ st: me.state, af: me.attackFrame, n: projectiles.length," +
       " h: pick(shotOf(Hotdog), ['x', 'y', 'vx', 'vy', 'bounces', 'piece']) }",
};

function checkHotdogFlight(log, S) {
  const spawn = log.findIndex((r) => r.h);
  assert.ok(spawn >= 0, "pressing the special should have put a hotdog in the air");
  assert.equal(log[spawn].af, S.n.startup,
    "it leaves his hand on the startup frame (" + S.n.startup + "); attackFrame was " + log[spawn].af);
  assert.equal(log[spawn].st, "special");
  assert.equal(log[spawn].h.piece, "whole", "thrown whole");
  assert.equal(log[spawn].h.vx, S.n.speed,
    "thrown forward at the spec's speed; vx was " + log[spawn].h.vx);
  assert.ok(log[spawn].h.vy < 0,
    "and with lift -- rising on the frame it leaves; vy was " + log[spawn].h.vy);
  assert.ok(log[spawn].h.y < S.main.y - 10,
    "above the hand it left from; y was " + log[spawn].h.y);

  const bounce = log.findIndex((r) => r.h && r.h.bounces === 1);
  assert.ok(bounce > spawn, "a whole hotdog should bounce once on the floor, and it never did");
  assert.equal(log[bounce].h.y, S.main.y,
    "the bounce is on the floor at y " + S.main.y + "; it was at " + log[bounce].h.y);
  assert.ok(log[bounce - 1].h && log[bounce - 1].h.vy > 0,
    "it was falling the frame before the bounce; vy was " + (log[bounce - 1].h || {}).vy);
  assert.ok(log[bounce].h.vy < 0,
    "and rising on the frame of it; vy was " + log[bounce].h.vy);
  assert.ok(log[bounce + 1].h && log[bounce + 1].h.y < S.main.y,
    "and back off the floor the frame after; y was " + (log[bounce + 1].h || {}).y);
  assert.ok(log.every((r) => !r.h || r.h.bounces <= 1), "it never bounces twice");
  for (let f = spawn; f <= bounce; f++) {
    assert.ok(log[f].h && log[f].h.piece === "whole" && log[f].h.vx > 0,
      "one whole hotdog flying forward on every frame from the throw to the bounce; frame " + f);
  }

  const gone = log.findIndex((r, i) => i > bounce && !r.h);
  assert.ok(gone > bounce, "and it should be gone again within the recording");
  assert.ok(gone - spawn <= S.n.life,
    "gone inside its life of " + S.n.life + " frames; it lasted " + (gone - spawn));
  assert.equal(log[gone].n, 0, "leaving nothing behind in the air");
  return { spawn, bounce, gone };
}

test("HOTDOG: one whole hotdog, thrown forward with lift, bounces once and is gone", async () => {
  /* The arc, frame by frame: it leaves on the startup frame at the spec's
     speed and rising, comes down onto the floor, bounces exactly once, and
     is gone before its life runs out -- in practice on its second landing,
     which is what "bounces once" means. */
  const run = await simonVsReese();
  const S = SPEC(run);
  const r = checkHotdogFlight(drive(run, "", 80, HOTDOG_FLIGHT), S);
  assert.ok(r.bounce - r.spawn > 10, "the arc is an arc, not a drop: " + (r.bounce - r.spawn) + " frames to the floor");
});

test("negative control: a bounce that does not flip vy fails the flight test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "this.vy = -Math.abs(this.vy) * this.base.bounce;",
    "this.vy = Math.abs(this.vy) * this.base.bounce;") });
  const S = SPEC(run);
  const log = drive(run, "", 80, HOTDOG_FLIGHT);
  expectToFail(() => checkHotdogFlight(log, S),
    "with the bounce sending it downward the flight test should fail, and it passed");
});

const HOTDOG_HIT = {
  p0: `i === 0 ? ${SP_NEUTRAL} : 0`,
  rec: "{ n: projectiles.length, h: pick(shotOf(Hotdog), ['piece']), fhp: foe.health," +
       " fvx: foe.vx, fst: foe.state }",
};

function checkWholeHit(log, S) {
  const hit = log.findIndex((r) => r.fhp < 100);
  assert.ok(hit > 0, "a foe standing in the arc should have been hit; his health never moved");
  assert.equal(100 - log[hit].fhp, S.n.damage,
    "a whole hotdog takes the roster's neutral damage of " + S.n.damage + "; it took " + (100 - log[hit].fhp));
  assert.equal(S.n.damage, 9, "and that number is 9 -- retune it on purpose, not by accident");
  assert.ok(log[hit - 1].h && log[hit - 1].h.piece === "whole",
    "the thing that hit him was a whole hotdog still in flight the frame before");
  assert.equal(log[hit].h, null, "which is spent on the hit");
  assert.equal(log[hit].fst, "hitstun", "and he is in hitstun for it");
  assert.equal(Math.sign(log[hit].fvx), 1,
    "knocked FORWARD, the way it was thrown; his vx was " + log[hit].fvx);
  return hit;
}

test("HOTDOG: a whole one hits for 9 and knocks the foe the way it was thrown", async () => {
  /* Twenty pixels ahead is squarely in the first few frames of the arc. The
     knockback direction is the whole point of a projectile that travels:
     applyHit reads it from which side of the victim the shot was on. */
  const run = await simonVsReese();
  const S = SPEC(run);
  checkWholeHit(drive(run, "foe.x = me.x + 20;", 40, HOTDOG_HIT), S);
});

test("negative control: knockback read backwards fails the whole-hotdog hit test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "const dir = Math.sign(defender.x - sourceX) || attacker.facing;",
    "const dir = -(Math.sign(defender.x - sourceX) || attacker.facing);") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 20;", 40, HOTDOG_HIT);
  expectToFail(() => checkWholeHit(log, S),
    "with the launch direction negated the hit test should fail, and it passed");
});

test("negative control: a whole hotdog carrying the bun's payload fails the hit test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "    this.base = spec;\n    this.spec = spec;\n    this.piece = 'whole';",
    "    this.base = spec;\n    this.spec = spec.parts.bottom;\n    this.piece = 'whole';") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 20;", 40, HOTDOG_HIT);
  expectToFail(() => checkWholeHit(log, S),
    "with the whole hotdog dealing the bun's 7 the hit test should fail, and it passed");
});

/* Thrown from the left balcony so the whole flies over the main floor with
   forty pixels of air under it; the foe stands where it will be twelve frames
   after it leaves the hand, which is where the second press splits it. The
   top keeps going well above his head; the bun drops onto it. */
const SPLIT_SETUP = `
    var perch = STAGE.platforms.filter(function (p) {
      return !p.main && p.y < main.y && p.x < main.x + main.w / 2;
    })[0];
    me.x = perch.x + 26; me.y = perch.y; me.prevY = perch.y;
    foe.x = me.x + 8 + NEUTRAL.speed * 12;`;

const HOTDOG_SPLIT = {
  p0: `(i === 0 || i === NEUTRAL.startup + 12) ? ${SP_NEUTRAL} : 0`,
  rec: "{ whole: countOf(Hotdog, 'whole')," +
       " top: pick(shotOf(Hotdog, 'top'), ['x', 'y', 'vx', 'vy'])," +
       " half: pick(shotOf(HotdogHalf), ['x', 'y', 'vy']), fhp: foe.health, st: me.state }",
};

function checkSplit(log, S) {
  const split = log.findIndex((r) => r.top);
  assert.equal(split, S.n.startup + 12,
    "the second press splits it on that very frame; the top appeared on frame " + split);
  assert.equal(log[split - 1].whole, 1, "a whole one was in the air the frame before");
  assert.equal(log[split].whole, 0, "and is not after");
  const top = log[split].top;
  assert.ok(near(Math.abs(top.vx), S.n.speed * S.n.top.speedMul),
    "the top is faster: speed " + S.n.speed + " times speedMul " + S.n.top.speedMul +
    " is " + (S.n.speed * S.n.top.speedMul) + "; its vx was " + top.vx);
  assert.equal(S.n.top.speedMul, 1.35, "and speedMul is 1.35 -- retune on purpose");
  assert.ok(top.vx > 0, "still heading the way it was thrown");
  const half = log[split].half;
  assert.ok(half, "and a bottom bun should be falling from the split");
  assert.equal(half.vy, S.n.bottom.fall,
    "at the spec's fall speed of " + S.n.bottom.fall + "; its vy was " + (half || {}).vy);
  assert.equal(S.n.bottom.fall, 3.2, "which is 3.2 -- retune on purpose");
  assert.ok(near(half.x, top.x - top.vx, 1e-6),
    "dropped from exactly where the split happened -- the top has moved one frame on, the bun has not");

  for (let f = split + 1; f < log.length && log[f].half; f++) {
    assert.equal(log[f].half.vy, S.n.bottom.fall, "the bun falls at one speed, no gravity; frame " + f);
    assert.ok(near(log[f].half.y - log[f - 1].half.y, S.n.bottom.fall),
      "and moves exactly that far each frame; frame " + f);
  }

  const hit = log.findIndex((r) => r.fhp < 100);
  assert.ok(hit > split, "the foe under the split should have been hit; his health never moved");
  assert.equal(100 - log[hit].fhp, S.n.bottom.damage,
    "the bun takes " + S.n.bottom.damage + "; he lost " + (100 - log[hit].fhp));
  assert.equal(S.n.bottom.damage, 7, "which is 7 -- retune on purpose");
  assert.ok(log[hit - 1].half && !log[hit].half, "the bun is spent on the hit");
  assert.ok(log[hit].top, "while the top is still flying: the 7 was the bun's, not the top's");
  return { split, hit };
}

test("HOTDOG: the second press splits it -- a faster top and a bun that drops for 7", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkSplit(drive(run, SPLIT_SETUP, 60, HOTDOG_SPLIT), S);
});

test("negative control: a top that keeps the whole's speed fails the split test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "this.vx *= parts.top.speedMul;", "this.vx *= 1;") });
  const S = SPEC(run);
  const log = drive(run, SPLIT_SETUP, 60, HOTDOG_SPLIT);
  expectToFail(() => checkSplit(log, S),
    "with the top no faster than the whole the split test should fail, and it passed");
});

test("negative control: a bun that falls upward fails the split test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "    this.vx = 0;\n    this.vy = spec.fall;",
    "    this.vx = 0;\n    this.vy = -spec.fall;") });
  const S = SPEC(run);
  const log = drive(run, SPLIT_SETUP, 60, HOTDOG_SPLIT);
  expectToFail(() => checkSplit(log, S),
    "with the bun rising instead of dropping the split test should fail, and it passed");
});

/* Frame 24 is the first press the game can hear after the throw: the throw
   is 20 frames end to end and the three frames of landLag after it eat a
   press. The whole is still in the air until around frame 54. */
const HOTDOG_AGAIN = {
  pre: "foe.invuln = 9999;",
  p0: `(i === 0 || i === 24 || i === 30) ? ${SP_NEUTRAL} : 0`,
  rec: "{ st: me.state, whole: countOf(Hotdog, 'whole'), top: countOf(Hotdog, 'top')," +
       " half: countOf(HotdogHalf) }",
};

function checkNoSecondWhole(log, S) {
  assert.equal(log[S.n.startup].whole, 1, "precondition: the first throw is out");
  assert.equal(log[23].st, "idle", "precondition: he is free again by frame 23; he was " + log[23].st);
  assert.equal(log[23].whole, 1, "precondition: and the whole is still flying");
  assert.equal(log[24].whole, 0, "the second press takes the whole out of the air...");
  assert.equal(log[24].top, 1, "...as a top...");
  assert.equal(log[24].half, 1, "...and a bun");
  assert.equal(log[24].st, "idle",
    "and it is a command to the hotdog, not a cast: he should still be idle, he was " + log[24].st);
  assert.ok(log.every((r) => r.whole <= 1), "two whole hotdogs are never in the air together");
  assert.equal(log[30].st, "special", "a third press, with no whole to talk to, throws again");
  assert.equal(log[30 + S.n.startup].whole, 1, "and a new whole comes out on its startup frame");
}

test("HOTDOG: two presses are one hotdog split, not two hotdogs; a third throws again", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkNoSecondWhole(drive(run, "", 60, HOTDOG_AGAIN), S);
});

test("negative control: a split press that also casts fails the one-at-a-time test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (intent && intent.kind === 'hotdog' && this.hotdogSplit) return;",
    "if (false) return;") });
  const S = SPEC(run);
  const log = drive(run, "", 60, HOTDOG_AGAIN);
  expectToFail(() => checkNoSecondWhole(log, S),
    "with the split press also spending a cast the test should fail, and it passed");
});

/* =====================================================================
   SLOTS
   ===================================================================== */

/* RIGHT is held through the whole spin, and the lever is pulled again on
   frames 12, 16 and 20. Stale reels from an imagined earlier spin are left
   on him so the wipe on the pull is something the test can see. */
const SLOTS_PRESSES = {
  p0: `(i === 0 || i === 12 || i === 16 || i === 20) ? (${SP_DOWN} | ${RIGHT}) : ${RIGHT}`,
  rec: "{ st: me.state, af: me.attackFrame, x: me.x, r: me.reels.join(','), rt: me.reelT," +
       " rs: me.reelStops, sp: me.specialSpawned }",
};

function checkSlotsPresses(log, S) {
  const spawn = log.findIndex((r) => r.sp && r.st === "special");
  assert.equal(spawn, S.d.startup, "the lever is pulled on the startup frame; it was frame " + spawn);
  assert.equal(log[spawn - 1].r, "2,2,2", "the stale reels survive the startup...");
  assert.equal(log[spawn].r, "-1,-1,-1", "...and are wiped the frame the lever comes down");
  for (let f = spawn; f <= 20; f++) {
    assert.equal(log[f].af, S.d.startup,
      "while the reels spin the move is held on its startup frame; attackFrame was " +
      log[f].af + " on frame " + f);
  }
  assert.equal(log[21].af, S.d.startup + 1, "and moves on once the last reel lands");
  for (let f = 0; f < log.length && log[f].st === "special"; f++) {
    assert.equal(log[f].x, log[0].x,
      "rooted: RIGHT was held the whole time and he must not move while the move runs; x went from " +
      log[0].x + " to " + log[f].x + " by frame " + f);
  }
  assert.ok(log[40].x > log[0].x, "precondition: free again, the same held RIGHT does walk him");
  assert.equal(log[11].r, "-1,-1,-1", "nothing has landed before the first stop");
  assert.match(log[12].r, /^[0-3],-1,-1$/, "the first press after the pull stops the FIRST reel: " + log[12].r);
  assert.match(log[15].r, /^[0-3],-1,-1$/, "and only that one: " + log[15].r);
  assert.match(log[16].r, /^[0-3],[0-3],-1$/, "the next press stops the second: " + log[16].r);
  assert.match(log[19].r, /^[0-3],[0-3],-1$/, "and only that one: " + log[19].r);
  assert.match(log[20].r, /^[0-3],[0-3],[0-3]$/, "the third stops the last: " + log[20].r);
  assert.equal(log[20].rs, 3, "three presses counted");
  assert.equal(log[30].st, "special", "the recovery runs after the payout...");
  assert.equal(log[31].st, "idle", "...and ends " + S.d.recovery + " frames after the last reel");
}

test("SLOTS: the reels wipe on the pull, hold him on the startup frame, root him, and stop in order", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkSlotsPresses(drive(run, "me.reels = [2, 2, 2];", 50, SLOTS_PRESSES), S);
});

test("negative control: presses that stop no reel fail the SLOTS press test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (this.reelStops > i || this.reelT >= s.autoStop[i]) {",
    "if (this.reelT >= s.autoStop[i]) {") });
  const S = SPEC(run);
  const log = drive(run, "me.reels = [2, 2, 2];", 50, SLOTS_PRESSES);
  expectToFail(() => checkSlotsPresses(log, S),
    "with the presses ignored the press test should fail, and it passed");
});

test("negative control: a spin that does not hold the startup frame fails the SLOTS press test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "          this.attackFrame = s.startup;\n          this.reelT++;",
    "          this.reelT++;") });
  const S = SPEC(run);
  const log = drive(run, "me.reels = [2, 2, 2];", 50, SLOTS_PRESSES);
  expectToFail(() => checkSlotsPresses(log, S),
    "with attackFrame free to run on the press test should fail, and it passed");
});

test("negative control: a mobile SLOTS fails the rooted check", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "kind: 'slots', label: 'SLOTS',", "kind: 'slots', label: 'SLOTS', mobile: true,") });
  const S = SPEC(run);
  const log = drive(run, "me.reels = [2, 2, 2];", 50, SLOTS_PRESSES);
  expectToFail(() => checkSlotsPresses(log, S),
    "with the move mobile and RIGHT held he walks, and the test should fail; it passed");
});

test("negative control: reels that are not wiped on the pull fail the SLOTS press test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "          this.reels = [-1, -1, -1];\n          this.reelT = 0;",
    "          this.reelT = 0;") });
  const S = SPEC(run);
  const log = drive(run, "me.reels = [2, 2, 2];", 50, SLOTS_PRESSES);
  expectToFail(() => checkSlotsPresses(log, S),
    "with stale reels left standing the press test should fail, and it passed");
});

const SLOTS_AUTO = {
  p0: `i === 0 ? ${SP_DOWN} : 0`,
  rec: "{ st: me.state, af: me.attackFrame, r: me.reels.join(','), rt: me.reelT," +
       " rs: me.reelStops }",
};

function checkAutoStop(log, S) {
  const spawn = S.d.startup;
  const landed = [0, 1, 2].map((i) => log.findIndex((r) => r.r.split(",")[i] !== "-1"));
  assert.ok(landed.every((f) => f > spawn), "every reel lands on its own; landed on frames " + landed.join(","));
  assert.equal(log[log.length - 1].rs, 0, "precondition: nobody pressed anything after the pull");
  // reelT is 1 on the pull frame, so a reel that lands at reelT N lands N - 1 frames later.
  assert.equal(landed.map((f) => f - spawn + 1).join(","), "30,48,66",
    "left alone the reels land at the autoStop frames 30, 48, 66 of the spin; they landed at " +
    landed.map((f) => f - spawn + 1).join(","));
  assert.equal(S.d.autoStop.join(","), "30,48,66", "which is what the roster says");
  landed.forEach((f, i) => {
    assert.equal(log[f].rt, S.d.autoStop[i], "reelT on the frame reel " + i + " landed was " + log[f].rt);
  });
  assert.equal(log[landed[2] + 1].af, spawn + 1, "and the move moves on the frame after the last one");
  assert.match(log[landed[2]].r, /^[0-3],[0-3],[0-3]$/, "three symbols in 0..3: " + log[landed[2]].r);
}

test("SLOTS: reels nobody stops land on frames 30, 48 and 66 of the spin", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkAutoStop(drive(run, "", 100, SLOTS_AUTO), S);
});

test("negative control: reels that land late fail the auto-stop test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "|| this.reelT >= s.autoStop[i]) {", "|| this.reelT >= s.autoStop[i] + 5) {") });
  const S = SPEC(run);
  const log = drive(run, "", 100, SLOTS_AUTO);
  expectToFail(() => checkAutoStop(log, S),
    "with every reel five frames late the auto-stop test should fail, and it passed");
});

/* One whole spin left alone, pulled on a chosen battleFrames, read as the
   three symbols it landed on. */
const SPIN = (bf) => `(function () {
    ${RESET}
    battleFrames = ${bf};
    ${DRIVE(100, { p0: `i === 0 ? ${SP_DOWN} : 0`, rec: "me.reels.join(',')" })}
    return log[99];
  })()`;

function spinsOn(run, frames) {
  return frames.map((bf) => {
    const r = run(SPIN(bf));
    assert.match(r, /^[0-3],[0-3],[0-3]$/, "a finished spin is three symbols; got " + r);
    return r;
  });
}

function checkDeterminism(a, b, tries) {
  assert.equal(a.join(" | "), b.join(" | "),
    "the same battleFrames in the same seat must spin the same reels on two fresh boots: " +
    a.join(" | ") + " versus " + b.join(" | "));
  assert.ok(tries.some((t) => t !== a[0]),
    "and a different battleFrames must change the spin somewhere in twenty tries; every one " +
    "of them came up " + a[0]);
}

test("SLOTS: the spin is a pure function of the match, and not a constant", async () => {
  /* Both machines in an online game have to see the same reels, and a
     rollback has to replay the same spin, so the seed is battleFrames and the
     seat and nothing else. Two boots, three pulls each on the same frames,
     compared as strings; then twenty pulls on neighboring frames, of which
     at least one has to differ, or "deterministic" would be satisfied by a
     machine that always paid the same. */
  const runA = await simonVsReese();
  const runB = await simonVsReese();
  const frames = [700, 800, 900];
  const a = spinsOn(runA, frames), b = spinsOn(runB, frames);
  const tries = spinsOn(runA, Array.from({ length: 20 }, (_, k) => 701 + k));
  checkDeterminism(a, b, tries);
});

test("negative control: a seed drawn from Math.random fails the determinism test", async () => {
  const engine = sabotage(
    "this.reelSeed = ((battleFrames * 2654435761) ^ (this.slot * 40503) ^ 0x9e3779b9) >>> 0;",
    "this.reelSeed = (Math.random() * 4294967296) >>> 0;");
  const runA = await simonVsReese({ engine }), runB = await simonVsReese({ engine });
  const frames = [700, 800, 900];
  const a = spinsOn(runA, frames), b = spinsOn(runB, frames);
  const tries = spinsOn(runA, Array.from({ length: 20 }, (_, k) => 701 + k));
  expectToFail(() => checkDeterminism(a, b, tries),
    "with the seed off Math.random two boots should disagree and the test should fail; it passed");
});

test("negative control: a constant seed fails the determinism test", async () => {
  const engine = sabotage(
    "this.reelSeed = ((battleFrames * 2654435761) ^ (this.slot * 40503) ^ 0x9e3779b9) >>> 0;",
    "this.reelSeed = 12345;");
  const runA = await simonVsReese({ engine }), runB = await simonVsReese({ engine });
  const frames = [700, 800, 900];
  const a = spinsOn(runA, frames), b = spinsOn(runB, frames);
  const tries = spinsOn(runA, Array.from({ length: 20 }, (_, k) => 701 + k));
  expectToFail(() => checkDeterminism(a, b, tries),
    "with a constant seed every spin is the same and the test should fail; it passed");
});

/* The payout table, called directly with the reels forced: this is what
   payout() does with a result, not how the reels arrive at one. */
const PAYOUTS = `(function () {
    var out = {};
    ${RESET} foe.x = me.x + 30; me.mana = 10; me.reels = [0, 0, 0]; me.payout(DOWN);
    out.jackpotLost = 100 - foe.health; out.jackpotMana = me.mana; out.jackpotFoe = foe.state;
    ${RESET} foe.x = me.x + 60; me.mana = 10; me.reels = [0, 0, 0]; me.payout(DOWN);
    out.farLost = 100 - foe.health; out.farMana = me.mana;
    ${RESET} me.mana = 10; me.reels = [1, 1, 1]; me.payout(DOWN);
    out.chipsMana = me.mana;
    ${RESET} me.health = 50; me.reels = [2, 2, 2]; me.payout(DOWN);
    out.healed = me.health;
    ${RESET} me.ultMeter = 0; me.reels = [3, 3, 3]; me.payout(DOWN);
    out.house = me.ultMeter;
    ${RESET} foe.x = me.x + 30; me.mana = 10; me.reels = [0, 0, 1]; me.payout(DOWN);
    out.pairLost = 100 - foe.health; out.pairMana = me.mana;
    ${RESET} me.reels = [0, 1, 2]; me.payout(DOWN);
    out.bust = me.health;
    ${RESET} me.health = 2; me.reels = [0, 1, 2]; me.payout(DOWN);
    out.bustFloor = me.health;
    ${RESET} me.health = 2; me.reels = [3, 2, 1]; me.payout(DOWN);
    out.bustFloorAgain = me.health;
    return JSON.stringify(out);
  })()`;

function checkPayouts(p, S) {
  assert.equal(p.jackpotLost, S.d.jackpot.damage,
    "three sevens hit a foe inside the ring for " + S.d.jackpot.damage + "; he lost " + p.jackpotLost);
  assert.equal(S.d.jackpot.damage, 22, "and that is 22 -- retune on purpose");
  assert.equal(p.jackpotFoe, "hitstun", "and it is a real hit");
  assert.equal(p.jackpotMana, S.manaMax,
    "and refill his mana to the cap of " + S.manaMax + " from 10; it read " + p.jackpotMana);
  assert.equal(p.farLost, 0,
    "a foe outside the " + S.d.jackpot.radius + "px ring is untouched; he lost " + p.farLost);
  assert.equal(p.farMana, S.manaMax, "the mana still comes, hit or no hit");
  assert.equal(p.chipsMana, S.manaMax, "three blues: mana to the cap from 10; it read " + p.chipsMana);
  assert.equal(p.healed, 50 + S.d.heal.health,
    "three greens heal " + S.d.heal.health + " from 50; health read " + p.healed);
  assert.equal(S.d.heal.health, 24, "and that is 24 -- retune on purpose");
  assert.equal(p.house, S.d.house.ult, "three spades add " + S.d.house.ult + " ult meter; it read " + p.house);
  assert.equal(S.d.house.ult, 40, "and that is 40 -- retune on purpose");
  assert.equal(p.pairLost, S.d.jackpot.damage / 2,
    "a pair of sevens pays half: " + (S.d.jackpot.damage / 2) + " damage; he lost " + p.pairLost);
  assert.equal(p.pairMana, 10 + S.d.jackpot.mana / 2, "and half the mana; it read " + p.pairMana);
  assert.equal(p.bust, 100 - S.d.bust.damage,
    "no pair busts for " + S.d.bust.damage + " off his own bar; it read " + p.bust);
  assert.equal(S.d.bust.damage, 3, "and that is 3 -- retune on purpose");
  assert.equal(p.bustFloor, 1, "a bust never takes him below 1 health; from 2 it read " + p.bustFloor);
  assert.equal(p.bustFloorAgain, 1, "whatever three different symbols came up; it read " + p.bustFloorAgain);
}

test("SLOTS: the payout table -- three of a kind pays in full, a pair pays half, a bust costs 3", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkPayouts(JSON.parse(run(PAYOUTS)), S);
});

test("negative control: a pair that pays in full fails the payout test", async () => {
  const run = await simonVsReese({ engine: sabotage("const k = n === 3 ? 1 : 0.5;", "const k = 1;") });
  const S = SPEC(run);
  const p = JSON.parse(run(PAYOUTS));
  expectToFail(() => checkPayouts(p, S), "with a pair paying like three the payout test should fail; it passed");
});

test("negative control: a bust that can take the last point fails the payout test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "this.health = Math.max(1, this.health - s.bust.damage);",
    "this.health = this.health - s.bust.damage;") });
  const S = SPEC(run);
  const p = JSON.parse(run(PAYOUTS));
  expectToFail(() => checkPayouts(p, S), "with the floor gone the payout test should fail; it passed");
});

test("negative control: a jackpot with no ring fails the payout test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (dx * dx + dy * dy <= r2) applyHit(this, other, s.jackpot, this.x, k);",
    "applyHit(this, other, s.jackpot, this.x, k);") });
  const S = SPEC(run);
  const p = JSON.parse(run(PAYOUTS));
  expectToFail(() => checkPayouts(p, S), "with the jackpot hitting at any range the payout test should fail; it passed");
});

test("negative control: a jackpot that pays no mana fails the payout test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "this.mana = Math.min(COMBAT.manaMax, this.mana + s.jackpot.mana * k);",
    "this.mana = Math.min(COMBAT.manaMax, this.mana + s.jackpot.mana * k * 0);") });
  const S = SPEC(run);
  const p = JSON.parse(run(PAYOUTS));
  expectToFail(() => checkPayouts(p, S), "with the sevens paying no mana the payout test should fail; it passed");
});

/* =====================================================================
   GUILLOTINE
   ===================================================================== */

const CHOKE = {
  p0: `i === 0 ? ${SP_UP} : 0`,
  rec: "{ af: me.attackFrame, st: me.state, x: me.x, hb: me.hitbox() !== null," +
       " fst: foe.state, fhp: foe.health, nan: isNaN(foe.health), fby: foe.grabbedBy," +
       " gr: me.grabbing, gk: me.grabKind, gt: me.grabTimer, fvx: foe.vx, fvy: foe.vy }",
};

function checkChoke(log, S) {
  const u = S.u;
  for (let f = 1; f < u.startup; f++) {
    assert.equal(log[f].hb, false, "no grab box during the startup; there was one on frame " + f);
    assert.equal(log[f].fst, "idle", "and nobody is caught yet on frame " + f);
    assert.equal(log[f].x, log[0].x, "and he has not moved yet on frame " + f);
  }
  assert.equal(u.startup, 6, "the startup is 6 -- retune on purpose");
  const C = log.findIndex((r) => r.fst === "grabbed");
  assert.equal(C, u.startup,
    "a foe fourteen pixels ahead is caught on the first active frame (" + u.startup + "); caught on " + C);
  assert.equal(log[C].hb, true, "the grab box is live on that frame");
  for (let f = u.startup; f < u.startup + u.active; f++) {
    const dx = log[f].x - log[f - 1].x;
    assert.ok(dx >= 1 && dx <= u.lunge + 1e-9,
      "the lunge carries him forward on every active frame, up to the roster's " + u.lunge +
      " per frame; frame " + f + " moved him " + dx);
  }
  assert.equal(u.lunge, 2.4, "and the lunge is 2.4 -- retune on purpose");

  assert.equal(log[C].gr, 1, "me.grabbing points at the foe's seat; it was " + log[C].gr);
  assert.equal(log[C].gk, 2, "grabKind 2 is the choke; it was " + log[C].gk);
  assert.equal(log[C].fby, 0, "and the foe knows who has him");
  assert.equal(log[C].nan, false, "the catch must not NaN his health");
  assert.equal(100 - log[C].fhp, u.grab.damage,
    "the catch itself costs grab.damage (" + u.grab.damage + "); he lost " + (100 - log[C].fhp));
  assert.equal(u.grab.damage, 2, "which is 2 -- retune on purpose");
  assert.equal(log[C].gt, u.grab.hold, "the hold starts at " + u.grab.hold + "; grabTimer was " + log[C].gt);

  const F = C + u.grab.hold;
  assert.ok(F < log.length, "precondition: the recording covers the whole hold");
  const ticks = [];
  for (let f = C + 1; f < F; f++) {
    assert.equal(log[f].nan, false, "health went NaN on frame " + f + " of the hold");
    assert.equal(log[f].fst, "grabbed", "held for the whole hold; on frame " + f + " he was " + log[f].fst);
    assert.ok(log[f].fhp <= log[f - 1].fhp, "health never climbs in the choke; it did on frame " + f);
    if (log[f].fhp < log[f - 1].fhp) {
      assert.ok(near(log[f - 1].fhp - log[f].fhp, u.choke.damage),
        "each choke tick is " + u.choke.damage + "; frame " + f + " took " + (log[f - 1].fhp - log[f].fhp));
      ticks.push(f - C);
    }
  }
  const expected = [];
  for (let k = 1; k < u.grab.hold; k += u.choke.every) expected.push(k);
  assert.equal(ticks.join(","), expected.join(","),
    "the choke ticks every " + u.choke.every + " frames of the hold, starting on the first; it ticked " +
    ticks.length + " times on hold frames " + ticks.join(","));
  assert.equal(u.choke.every + "/" + u.choke.damage, "12/1.5", "every 12 for 1.5 -- retune on purpose");

  const finished = log[F - 1].fhp - log[F].fhp;
  assert.equal(finished, u.finish.damage,
    "on the last frame of the hold the blade lands for " + u.finish.damage + "; he lost " + finished);
  assert.equal(u.finish.damage, 14, "which is 14 -- retune on purpose");
  assert.equal(log[F].nan, false, "and his health is a number");
  assert.equal(log[F].fst, "hitstun", "and he is launched out of the hold");
  assert.equal(log[F].gr, -1, "and let go of");
  assert.ok(log[F].fvy > 0, "launched DOWN: vy should be positive, it was " + log[F].fvy);
  assert.equal(Math.sign(log[F].fvx), 1, "and forward, the way Simon faces; vx was " + log[F].fvx);
  assert.ok(near(100 - log[F].fhp, u.grab.damage + ticks.length * u.choke.damage + u.finish.damage),
    "everything the move took adds up; total lost " + (100 - log[F].fhp));
}

test("GUILLOTINE on the ground: a lunge into a catch, a slow choke, and a blade that throws down and forward", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkChoke(drive(run, "foe.x = me.x + 14;", 120, CHOKE), S);
});

test("negative control: a guillotine with no lunge fails the choke test", async () => {
  const run = await simonVsReese({ engine: sabotage("this.vx = this.facing * s.lunge;", "this.vx = 0;") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 14;", 120, CHOKE);
  expectToFail(() => checkChoke(log, S), "with the lunge gone the choke test should fail; it passed");
});

test("negative control: a catch that subtracts undefined fails the choke test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "defender.health -= move.grab.damage;", "defender.health -= move.grab.dmg;") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 14;", 120, CHOKE);
  expectToFail(() => checkChoke(log, S), "with the catch making health NaN the choke test should fail; it passed");
});

test("negative control: a choke that never ticks fails the choke test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (s.choke && this.grabTimer % s.choke.every === 0) {", "if (false) {") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 14;", 120, CHOKE);
  expectToFail(() => checkChoke(log, S), "with no choke ticks the choke test should fail; it passed");
});

test("negative control: a finish thrown backward fails the choke test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "const from = victim.x - this.facing * 40;", "const from = victim.x + this.facing * 40;") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 14;", 120, CHOKE);
  expectToFail(() => checkChoke(log, S), "with the finish launching backward the choke test should fail; it passed");
});

const CHOKE_VS_SHIELD = {
  p0: `i === 0 ? ${SP_UP} : 0`,
  p1: `${SHIELD}`,
  rec: "{ fst: foe.state, fhp: foe.health, fsh: foe.shield }",
};

function checkChokeThroughShield(log, S) {
  for (let f = 1; f < S.u.startup; f++) {
    assert.equal(log[f].fst, "shield", "precondition: the foe is blocking through the startup; on frame " + f + " he was " + log[f].fst);
  }
  assert.equal(log[S.u.startup].fst, "grabbed",
    "a grab goes through a shield: he should be caught on frame " + S.u.startup + ", he was " + log[S.u.startup].fst);
  assert.equal(100 - log[S.u.startup].fhp, S.u.grab.damage, "and pays the catch");
}

test("GUILLOTINE: a shielding foe is still caught -- grabs go through shields", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkChokeThroughShield(drive(run, "foe.x = me.x + 14;", 12, CHOKE_VS_SHIELD), S);
});

test("negative control: a grab that respects the shield fails the through-shield test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (move.grab) {", "if (move.grab && defender.state !== 'shield') {") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 14;", 12, CHOKE_VS_SHIELD);
  expectToFail(() => checkChokeThroughShield(log, S),
    "with the grab blocked by a shield the through-shield test should fail; it passed");
});

/* Held thirty pixels up, under the top platform and above nothing else, for
   the startup; the frame the move decides (the startup frame) runs free, so
   the decision is made against real physics. The foe stands directly under
   him. */
const AIR_SETUP = `
    me.x = main.x + main.w / 2; foe.x = me.x;`;

const AIR_DROP = {
  pre: "if (i < UP.startup) { me.grounded = false; me.y = main.y - 30; me.prevY = me.y; me.vy = 0; }",
  p0: `i === 0 ? ${SP_UP} : 0`,
  rec: "{ af: me.attackFrame, st: me.state, ac: me.airCast, vy: me.vy, vx: me.vx, gr: me.grounded," +
       " hb: me.hitbox() !== null, drop: pick(shotOf(GuillotineDrop), ['x', 'y', 'vy'])," +
       " fhp: foe.health, fst: foe.state, fvy: foe.vy }",
};

function checkAirDrop(log, S) {
  const u = S.u, s = u.startup;
  assert.equal(log[s - 1].gr, false, "precondition: airborne going into the startup frame");
  assert.equal(log[s - 1].ac, false, "not decided before the startup frame");
  assert.equal(log[s].ac, true, "on the startup frame, airborne, the move becomes the drop: airCast was " + log[s].ac);
  assert.ok(log[s - 1].vy > 0, "precondition: he was falling the frame before; vy " + log[s - 1].vy);
  assert.ok(near(log[s].vy, u.air.rise + S.gravity),
    "and it gives him the hop: vy set to the roster's rise of " + u.air.rise + " (read after that frame's " +
    "gravity tick of " + S.gravity + ", so " + (u.air.rise + S.gravity) + "); it read " + log[s].vy);
  assert.equal(u.air.rise, -6.2, "and the rise is -6.2, HIGH NOTE's -- retune on purpose");
  assert.ok(near(log[s].vx, u.air.drift), "with the roster's drift forward; vx was " + log[s].vx);

  assert.ok(log[s].drop, "a guillotine should be falling from the startup frame");
  assert.equal(log[s].drop.vy, u.air.drop.speed,
    "at the roster's speed of " + u.air.drop.speed + "; its vy was " + log[s].drop.vy);
  assert.equal(u.air.drop.speed, 4.2, "which is 4.2 -- retune on purpose");
  for (let f = s + 1; f < log.length && log[f].drop; f++) {
    assert.ok(near(log[f].drop.y - log[f - 1].drop.y, u.air.drop.speed),
      "it falls exactly that far every frame, no gravity; frame " + f);
  }

  const hit = log.findIndex((r) => r.fhp < 100);
  assert.ok(hit > s, "the foe standing under him should have been hit; his health never moved");
  assert.equal(100 - log[hit].fhp, u.air.drop.damage,
    "the drop takes " + u.air.drop.damage + "; he lost " + (100 - log[hit].fhp));
  assert.equal(u.air.drop.damage, 10, "which is 10 -- retune on purpose");
  assert.ok(log[hit - 1].drop && !log[hit].drop, "and the guillotine is spent on the hit");
  assert.equal(log[hit].fst, "hitstun");

  for (let f = 0; f < log.length; f++) {
    if (log[f].st !== "special") continue;
    assert.equal(log[f].hb, false,
      "cast from the air the move has NO grab box, on any frame; hitbox() was live on frame " + f);
  }
}

test("GUILLOTINE in the air: the hop and the drop, and no grab box anywhere in it", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkAirDrop(drive(run, AIR_SETUP, 40, AIR_DROP), S);
});

test("negative control: an air cast that is never marked airCast fails the drop test", async () => {
  const run = await simonVsReese({ engine: sabotage("this.airCast = !this.grounded;", "this.airCast = false;") });
  const S = SPEC(run);
  const log = drive(run, AIR_SETUP, 40, AIR_DROP);
  expectToFail(() => checkAirDrop(log, S), "with airCast never set the drop test should fail; it passed");
});

test("negative control: a grab box that stays on in the air fails the drop test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (s && s.kind === 'guillotine' && this.airCast) return null;",
    "if (s && s.kind === 'guillotine' && !this.airCast) return null;") });
  const S = SPEC(run);
  const log = drive(run, AIR_SETUP, 40, AIR_DROP);
  expectToFail(() => checkAirDrop(log, S), "with the grab box live in the air the drop test should fail; it passed");
});

test("negative control: a guillotine that falls at half speed fails the drop test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "    this.vy = spec.speed;\n    this.life = spec.life;\n    this.t = 0;",
    "    this.vy = spec.speed / 2;\n    this.life = spec.life;\n    this.t = 0;") });
  const S = SPEC(run);
  const log = drive(run, AIR_SETUP, 40, AIR_DROP);
  expectToFail(() => checkAirDrop(log, S), "with the drop falling at half speed the drop test should fail; it passed");
});

/* =====================================================================
   SIMON SLOUCH
   ===================================================================== */

const SLOUCH_REC =
  "{ af: me.attackFrame, st: me.state, x: me.x, inv: me.invuln, hp: me.health, mana: me.mana," +
  " mf: me.manaFree, soul: countOf(Soul)," +
  " fd: foe.drowsy, fst: foe.state, fhp: foe.health, fgr: foe.grounded }";

/* Health at 40 and mana at 10, so the heal and the free-mana window have
   room to be seen; the ult meter is full. `at` is where the foe stands. */
const slouch = (run, at, extra, frames) => drive(run,
  "me.ultMeter = 999; me.health = 40; me.mana = 10; foe.x = me.x + " + at + ";",
  frames || 360, { mana: false, p0: `i === 0 ? ${ULT} : 0`, pre: extra || "", rec: SLOUCH_REC });

function checkSleep(log, S) {
  const u = S.ult, sleepFrom = u.startup, wake = u.startup + u.active;
  assert.equal(u.startup + "/" + u.active, "24/300", "24 frames of nodding off, 300 asleep -- retune on purpose");
  assert.equal(log[0].st, "ult", "precondition: the press was heard");
  assert.equal(log[wake + u.recovery - 1].st, "ult", "the move runs its whole length");
  assert.equal(log[wake + u.recovery].st, "idle", "and ends on schedule");
  for (let f = 0; f < wake + u.recovery; f++) {
    assert.equal(log[f].x, log[0].x, "rooted from the first nod: x moved on frame " + f);
  }
  for (let f = 1; f < sleepFrom; f++) {
    assert.equal(log[f].inv, 0, "not yet untouchable while he nods off; invuln was " + log[f].inv + " on frame " + f);
  }
  for (let f = sleepFrom; f < wake; f++) {
    assert.ok(log[f].inv > 0, "he cannot be woken: invuln must stay above 0 on every sleeping frame; it was " +
      log[f].inv + " on frame " + f + " (attackFrame " + log[f].af + ")");
  }
  assert.equal(log[sleepFrom - 1].hp, 40, "no healing before the sleep");
  for (let f = sleepFrom; f < wake; f++) {
    assert.ok(log[f].hp > log[f - 1].hp, "health climbs on every sleeping frame; it did not on frame " + f);
  }
  assert.ok(near(log[wake - 1].hp, 40 + u.heal, 1e-6),
    "a full sleep heals " + u.heal + ": from 40 to " + (40 + u.heal) + "; he woke on " + log[wake - 1].hp);
  assert.equal(u.heal, 25, "and the heal is 25 -- retune on purpose");

  /* The mana is not refilled, it is suspended: from the frame after he
     commits the bar is pinned full for `manaFree` frames -- long enough to
     cover the sleep and hand him the same again awake. The pin runs at the
     top of update(), one frame behind the runSpecial frame that opens it. */
  assert.ok(log[0].mana < S.manaMax, "precondition: the bar was low going in; it read " + log[0].mana);
  assert.equal(log[1].mf, u.manaFree,
    "the free window opens on his first frame in the move at the roster's " + u.manaFree + "; manaFree read " + log[1].mf);
  assert.equal(u.manaFree, 600, "and that is ten seconds -- retune on purpose");
  assert.ok(u.manaFree > wake, "long enough to outlive the sleep");
  for (let f = 2; f <= 1 + u.manaFree; f++) {
    assert.equal(log[f].mana, S.manaMax, "the bar reads full on every frame of the window; on frame " + f + " it read " + log[f].mana);
  }
  assert.ok(log[wake].mf > 0, "still open when he wakes -- the second five seconds are his; manaFree was " + log[wake].mf);
  assert.ok(log[u.manaFree].mf > 0, "and not closed a frame early");
  assert.equal(log[1 + u.manaFree].mf, 0, "closes exactly " + u.manaFree + " frames after it opened");

  if (u.soul) {
    // The part of him that does not sleep: out when the eyes close, gone when they open.
    assert.equal(log[sleepFrom - 1].soul, 0, "no soul while he is still nodding off");
    for (let f = sleepFrom; f < wake; f++) {
      assert.equal(log[f].soul, 1, "one soul out for the whole sleep; on frame " + f + " there were " + log[f].soul);
    }
    assert.equal(log[wake].soul, 0, "and it is gone on the frame he wakes");
  }
}

function checkDozes(log, S) {
  const u = S.ult, wake = u.startup + u.active;
  /* Read after the step, which is after the foe's own frame has shed one:
     Simon's aura takes him to `doze` and the sleep fires, then his update
     counts him down to doze - 1. So the most a recording can show is 89. */
  assert.ok(log.some((r) => r.fd >= u.aura.doze - 1),
    "a foe in the aura gets drowsy all the way to " + u.aura.doze + "; the most he reached was " +
    Math.max(...log.map((r) => r.fd)));
  assert.equal(u.aura.doze, 90, "and doze is 90 -- retune on purpose");
  const doze = log.findIndex((r) => r.fst === "hitstun");
  assert.ok(doze >= 110 && doze <= 125,
    "standing still in the aura he drops off around frame 110-125 of the move; he fell asleep on frame " + doze);
  for (let f = doze; f < wake; f++) {
    assert.equal(log[f].fst, "hitstun", "and stays under until Simon wakes; on frame " + f + " he was " + log[f].fst);
  }
  return doze;
}

/* Over the sleep only: the aura is what puts people under, and it is off
   the frame he wakes -- when the stretch can hit anyone close, on the ground
   or not, which is a different test. */
function checkNeverDozes(log, S, why) {
  const wake = S.ult.startup + S.ult.active;
  const dozed = log.findIndex((r, f) => f < wake && r.fst === "hitstun");
  assert.equal(dozed, -1, why + " -- he was in hitstun on frame " + dozed);
}

function checkWakeRing(log, S) {
  const u = S.ult, wake = u.startup + u.active;
  assert.equal(log[wake].af, wake, "precondition: frame " + wake + " is the wake frame");
  assert.equal(log[wake - 1].fhp, 100, "a sleeper is not hurt by the sleep itself");
  assert.equal(100 - log[wake].fhp, u.wake.damage,
    "on the wake frame the stretch hits a foe within " + u.wake.radius + "px for " + u.wake.damage +
    "; he lost " + (100 - log[wake].fhp));
  assert.equal(u.wake.damage, 6, "which is 6 -- retune on purpose");
  assert.equal(log[wake].fst, "hitstun", "and it is a real hit");
}

const SLEEP_FRAMES = 620;   // past the end of the ten-second free-mana window

test("SLOUCH: 24 frames to nod off, then 300 asleep -- untouchable, healing, rooted, with ten seconds of free specials", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkSleep(slouch(run, 30, "", SLEEP_FRAMES), S);
});

test("negative control: a sleep that does not re-arm invuln fails the sleep test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "          this.invuln = Math.max(this.invuln, 2);\n          this.health",
    "          this.invuln = Math.max(this.invuln, 0);\n          this.health") });
  const S = SPEC(run);
  const log = slouch(run, 30, "", SLEEP_FRAMES);
  expectToFail(() => checkSleep(log, S), "with the sleep not untouchable the sleep test should fail; it passed");
});

test("negative control: a sleep that heals half fails the sleep test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "this.health = Math.min(COMBAT.maxHealth, this.health + s.heal / s.active);",
    "this.health = Math.min(COMBAT.maxHealth, this.health + s.heal / s.active / 2);") });
  const S = SPEC(run);
  const log = slouch(run, 30, "", SLEEP_FRAMES);
  expectToFail(() => checkSleep(log, S), "with the heal halved the sleep test should fail; it passed");
});

test("negative control: a free window that does not pin the bar fails the sleep test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (this.manaFree > 0) { this.manaFree--; this.mana = COMBAT.manaMax; }",
    "if (this.manaFree > 0) { this.manaFree--; }") });
  const S = SPEC(run);
  const log = slouch(run, 30, "", SLEEP_FRAMES);
  expectToFail(() => checkSleep(log, S), "with the window counting but not paying the sleep test should fail; it passed");
});

test("negative control: a sleep with no soul fails the sleep test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (s.soul && this.attackFrame === s.startup) {", "if (false) {") });
  const S = SPEC(run);
  const log = slouch(run, 30, "", SLEEP_FRAMES);
  expectToFail(() => checkSleep(log, S), "with the soul never leaving the body the sleep test should fail; it passed");
});

test("SLOUCH: a foe standing in the aura drops off around frame 112; one at 60px never does; one in the air never does", async () => {
  /* The aura is +2 a frame against the -1 every fighter sheds, so it climbs
     at one a frame inside and reaches 90 on the 88th sleeping frame -- frame
     112 of the move. Sixty pixels is outside the 40px aura. The airborne
     foe is held inside the aura every frame and still gets drowsy, which
     shows he is IN it; only his feet keep him awake. */
  const run = await simonVsReese();
  const S = SPEC(run);
  const doze = checkDozes(slouch(run, 30), S);
  assert.equal(doze, 112, "the arithmetic says frame 112 exactly; it was " + doze);

  const far = slouch(run, 60);
  assert.ok(far.every((r) => r.fd === 0), "at 60px he never gets drowsy at all");
  checkNeverDozes(far, S, "and never falls asleep");

  const air = slouch(run, 10,
    "foe.grounded = false; foe.y = main.y - 20; foe.prevY = foe.y; foe.vy = 0;");
  assert.ok(air.some((r) => r.fd >= S.ult.aura.doze - 1),
    "precondition: the airborne foe is inside the aura and gets fully drowsy (read after his own frame sheds one)");
  assert.ok(air.every((r) => !r.fgr), "precondition: and stays off the ground");
  checkNeverDozes(air, S, "an airborne foe inside the aura must never fall asleep -- you can jump over a sleeping man");
});

test("negative control: an aura that adds only what the frame takes fails the doze test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "other.drowsy = Math.min(s.aura.doze, other.drowsy + 2);",
    "other.drowsy = Math.min(s.aura.doze, other.drowsy + 1);") });
  const S = SPEC(run);
  const log = slouch(run, 30);
  expectToFail(() => checkDozes(log, S), "with the aura no stronger than the decay the doze test should fail; it passed");
});

test("negative control: an aura that puts airborne foes to sleep fails the grounded-only check", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (other.drowsy >= s.aura.doze && other.grounded &&",
    "if (other.drowsy >= s.aura.doze &&") });
  const S = SPEC(run);
  const air = slouch(run, 10, "foe.grounded = false; foe.y = main.y - 20; foe.prevY = foe.y; foe.vy = 0;");
  expectToFail(() => checkNeverDozes(air, S, "airborne foe fell asleep"),
    "with the grounded check gone the airborne foe should sleep and the check should fail; it passed");
});

test("SLOUCH: waking up hits a foe within 26px for 6, on the wake frame exactly", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkWakeRing(slouch(run, 20), S);
  const far = slouch(run, 30);
  assert.equal(far[S.ult.startup + S.ult.active].fhp, 100,
    "and one at 30px -- inside the aura, outside the 26px ring -- is not hit by the stretch");
});

test("negative control: a wake with no ring fails the wake test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (dx * dx + dy * dy <= r2) applyHit(this, other, s.wake, this.x);",
    "if (false) applyHit(this, other, s.wake, this.x);") });
  const S = SPEC(run);
  const log = slouch(run, 20);
  expectToFail(() => checkWakeRing(log, S), "with the wake ring gone the wake test should fail; it passed");
});

/* =====================================================================
   CPU vs CPU
   ===================================================================== */

const SIM = `(function () {
    var bad = [], n = 0;
    for (var i = 0; i < 600; i++) {
      step(); n++;
      fighters.forEach(function (f) {
        if (isNaN(f.health) || isNaN(f.x) || isNaN(f.y)) bad.push(i + ':' + f.key);
      });
      if (scene !== 'battle') break;
    }
    return JSON.stringify({ bad: bad.slice(0, 5).join(','), scene: scene, stage: STAGE.key,
      trap: !!STAGE.trap, frames: n,
      f: fighters.map(function (f) { return { key: f.key, stocks: f.stocks, elim: f.eliminated }; }) });
  })()`;

function checkSim(r, stageKey) {
  assert.equal(r.stage, stageKey, "precondition: the match is on " + stageKey);
  assert.equal(r.bad, "", "no fighter's health, x or y may ever be NaN; first offenders " + r.bad);
  assert.ok(r.scene === "battle" || r.scene === "results", "the match is still a match or over cleanly; scene " + r.scene);
  for (const f of r.f) {
    assert.ok(f.stocks >= 1 || (f.elim && f.stocks <= 0),
      f.key + " should have a stock left or be eliminated cleanly; stocks " + f.stocks + ", eliminated " + f.elim);
  }
}

test("600 frames of CPU Simon vs CPU Reese on Deep Space and on Battlefield stay sane", async () => {
  const space = await simonVsReese({ warmup: 0 });
  checkSim(JSON.parse(space(SIM)), "space");
  const field = await simonVsReese({ warmup: 0, stage: 5 });
  const r = JSON.parse(field(SIM));
  assert.equal(r.trap, true, "precondition: Battlefield is the stage with the trapdoor");
  checkSim(r, "battlefield");
});

test("negative control: a NaN in the roster fails the CPU sanity test", async () => {
  const engine = sabotage(
    "weight: 104, walk: 1.42, jump: 6.4, doubleJump: 5.9,",
    "weight: 104, walk: undefined, jump: 6.4, doubleJump: 5.9,");
  const space = await simonVsReese({ warmup: 0, engine });
  const r = JSON.parse(space(SIM));
  expectToFail(() => checkSim(r, "space"), "with Simon's walk speed NaN the sanity test should fail; it passed");
  const field = await simonVsReese({ warmup: 0, stage: 5, engine });
  const r2 = JSON.parse(field(SIM));
  expectToFail(() => checkSim(r2, "battlefield"), "and on Battlefield too; it passed");
});
