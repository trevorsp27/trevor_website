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
 * Three sevens no longer pay a number at all, so what that reel DOES pay --
 * the giant, and everything that stops being true while he is one -- is
 * pinned at the END of this file, where a new boot cannot shift the seeded
 * Math stream out from under everything that already runs after it.
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
  u: ROSTER.simon.specials.up, ult: ROSTER.simon.ult, jab: ROSTER.simon.jab,
  manaMax: COMBAT.manaMax, maxHealth: COMBAT.maxHealth, ultMax: COMBAT.ultMax,
  gravity: PHYS.gravity, friction: PHYS.groundFriction, landLag: PHYS.landLag,
  main: STAGE.platforms.find(function (p) { return p.main; }) })`));

const ATTACK = 32, RIGHT = 2, SHIELD = 128, ULT = 256,
      SP_NEUTRAL = 512, SP_DOWN = 1024, SP_UP = 2048;

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
  /* THIRTY pixels ahead, not twenty. The whole dog's box was an eight-pixel
     square and is now eleven long -- the shape of the sprite rather than the
     shape of nothing in particular -- which reaches two pixels further
     forward, and two pixels was the whole margin: at twenty he is caught on
     the very frame it leaves the hand, so there is no frame before the hit in
     which the thing that hit him was in flight, and the check below has
     nothing to read. Thirty puts the contact three frames into the arc.

     The knockback direction is the whole point of a projectile that travels:
     applyHit reads it from which side of the victim the shot was on. */
  const run = await simonVsReese();
  const S = SPEC(run);
  checkWholeHit(drive(run, "foe.x = me.x + 30;", 40, HOTDOG_HIT), S);
});

test("negative control: knockback read backwards fails the whole-hotdog hit test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "const dir = Math.sign(defender.x - sourceX) || attacker.facing;",
    "const dir = -(Math.sign(defender.x - sourceX) || attacker.facing);") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 30;", 40, HOTDOG_HIT);
  expectToFail(() => checkWholeHit(log, S),
    "with the launch direction negated the hit test should fail, and it passed");
});

test("negative control: a whole hotdog carrying the bun's payload fails the hit test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "    this.base = spec;\n    this.spec = spec;\n    this.piece = 'whole';",
    "    this.base = spec;\n    this.spec = spec.parts.bottom;\n    this.piece = 'whole';") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 30;", 40, HOTDOG_HIT);
  expectToFail(() => checkWholeHit(log, S),
    "with the whole hotdog dealing the bun's 7 the hit test should fail, and it passed");
});

/* Thrown from the left balcony so the whole flies over the main floor with
   forty pixels of air under it; the foe stands where it will be twelve frames
   after it leaves the hand, which is where the second press splits it. The
   top keeps going well above his head and off the side of the screen; the bun
   planes down onto him. Sixty pixels of air below the split is what makes the
   two lanes readable as two lanes: only one of them can reach the man. */
const SPLIT_SETUP = `
    var perch = STAGE.platforms.filter(function (p) {
      return !p.main && p.y < main.y && p.x < main.x + main.w / 2;
    })[0];
    me.x = perch.x + 26; me.y = perch.y; me.prevY = perch.y;
    foe.x = me.x + 8 + NEUTRAL.speed * 12;`;

const HOTDOG_SPLIT = {
  p0: `(i === 0 || i === NEUTRAL.startup + 12) ? ${SP_NEUTRAL} : 0`,
  rec: "{ whole: countOf(Hotdog, 'whole')," +
       " top: pick(shotOf(Hotdog, 'top'), ['x', 'y', 'vx', 'vy', 'slide', 'launchVx'])," +
       " half: pick(shotOf(HotdogHalf), ['x', 'y', 'vx', 'vy'])," +
       " fhp: foe.health, st: me.state }",
};

function checkSplit(log, S) {
  const split = log.findIndex((r) => r.top);
  assert.equal(split, S.n.startup + 12,
    "the second press splits it on that very frame; the top appeared on frame " + split);
  assert.equal(log[split - 1].whole, 1, "a whole one was in the air the frame before");
  assert.equal(log[split].whole, 0, "and is not after");

  /* THE SAUSAGE PEELS OUT OF THE BUN, it does not teleport out of it. The
     split used to be one baked sprite swapped for another between two frames,
     at which point the top simply WAS faster and there was nothing to watch;
     it now leaves at a quarter of what the whole dog was doing and closes the
     gap back up to full speed over the slide. So the speed to pin is the
     target it eases towards -- launchVx -- and the frame it arrives on,
     because a top that starts at the target is the thing this shape was
     introduced to stop. */
  const top = log[split].top;
  const full = S.n.speed * S.n.top.speedMul;
  assert.ok(near(Math.abs(top.launchVx), full),
    "the top is easing up to speed " + S.n.speed + " times speedMul " + S.n.top.speedMul +
    " = " + full + "; launchVx was " + top.launchVx);
  assert.equal(S.n.top.speedMul, 1.35, "and speedMul is 1.35 -- retune on purpose");
  assert.ok(top.vx > 0, "still heading the way it was thrown");
  assert.ok(top.vx < S.n.speed,
    "and SLOWER than the whole dog was for the moment it is coming free -- that is the peel; " +
    "its vx on the split frame was " + top.vx + " against the whole's " + S.n.speed);
  assert.equal(S.n.top.kick, 0.25, "it leaves at a quarter of it -- retune on purpose");

  /* Snapped exactly onto the target on the last frame of the slide rather
     than left wherever a geometric series happened to reach: two machines
     replaying this frame have to agree to the bit, and the easiest number to
     agree on is one that is stated outright. The slide starts at `slide` and
     the split frame's own update has already spent one of it, so the arrival
     is slide - 1 frames after the split. */
  const upToSpeed = split + S.n.slide - 1;
  assert.equal(log[upToSpeed].top.slide, 0, "the slide has run out by frame " + upToSpeed);
  assert.ok(near(log[upToSpeed].top.vx, full),
    "and the top is snapped exactly onto " + full + " there, not merely near it; vx was " +
    log[upToSpeed].top.vx);
  assert.equal(S.n.slide, 6, "and the slide is 6 frames -- retune on purpose");
  for (let f = split; f < upToSpeed; f++) {
    assert.ok(log[f].top.vx < log[f + 1].top.vx,
      "climbing on every frame of the slide rather than jumping there; frame " + f +
      " read " + log[f].top.vx + " and frame " + (f + 1) + " read " + log[f + 1].top.vx);
  }

  /* THE BUN CATCHES THE AIR. It used to be 3.2 a frame straight down, no
     drift, dead on the first thing it touched -- which from throwing height
     over the main floor was five frames of bun, and half of this move was
     something nobody ever saw happen. It is now shed BACKWARD off the same
     launch that threw the sausage forward, popped upward as it comes free,
     and eased down to a fall it never exceeds. */
  const half = log[split].half;
  assert.ok(half, "and a bottom bun should be falling from the split");
  // Where the two came apart: the top has moved one frame on, and this is the
  // point it moved on FROM.
  const splitX = top.x - top.vx;
  assert.ok(half.x < splitX,
    "the bun is shed BACKWARD from the split at " + splitX + " -- the equal and opposite half " +
    "of the launch that threw the sausage forward; it was at " + half.x);
  assert.equal(S.n.bottom.shed, 0.16, "shed is 0.16 of that launch -- retune on purpose");
  assert.ok(half.vy < 0,
    "and it is popped UP as the dog leaves rather than dropping the instant it is free; vy was " +
    half.vy);
  assert.equal(S.n.bottom.pop, -0.7, "the pop is -0.7 -- retune on purpose");

  let air = 0, fastest = -Infinity, wentLeft = false, wentRight = false;
  for (let f = split; f < log.length && log[f].half; f++) {
    air++;
    fastest = Math.max(fastest, log[f].half.vy);
    if (log[f].half.vx < 0) wentLeft = true;
    if (log[f].half.vx > 0) wentRight = true;
    assert.ok(log[f].half.vy <= S.n.bottom.fall + 1e-9,
      "it never falls faster than the speed it planes at (" + S.n.bottom.fall +
      "); on frame " + f + " vy was " + log[f].half.vy);
  }
  assert.equal(S.n.bottom.fall, 1.25, "which is 1.25, down from 3.2 -- retune on purpose");
  assert.ok(near(fastest, S.n.bottom.fall, 0.01),
    "and it does settle onto that speed rather than stopping short of it; the fastest it ever " +
    "fell was " + fastest);
  assert.ok(wentLeft && wentRight,
    "it tips one way and then the other and slides whichever way it is tipped, so a whole fall " +
    "has to show its vx going BOTH ways -- a bun that only ever drifts one way is a rock with " +
    "a wind behind it; left " + wentLeft + ", right " + wentRight);
  assert.ok(air >= 30,
    "and it is in the air long enough to be somebody's problem: this same drop was over in " +
    "five frames at the old flat 3.2 and has to take at least thirty now; it lasted " + air);

  const hit = log.findIndex((r) => r.fhp < 100);
  assert.ok(hit > split, "the foe under the split should have been hit; his health never moved");
  assert.equal(100 - log[hit].fhp, S.n.bottom.damage,
    "the bun takes " + S.n.bottom.damage + "; he lost " + (100 - log[hit].fhp));
  assert.equal(S.n.bottom.damage, 7, "which is 7 -- retune on purpose");
  assert.ok(log[hit - 1].half && !log[hit].half, "the bun is spent on the hit");
  /* And it was the BUN that took them. The top left at twenty degrees over a
     man standing sixty pixels below the split and is off the side of the
     screen long before the bread lands, so the only thing that can have been
     in contact is the half that planed down onto him -- which is the whole
     claim that one throw covers two lanes. */
  assert.ok(log.slice(split, hit).every((r) => r.fhp === 100),
    "and nothing touched him between the split and the bun arriving");
  assert.notEqual(S.n.bottom.damage, S.n.top.damage,
    "precondition: the two halves have to deal different numbers, or the line above could not " +
    "tell which of them landed");
  return { split, hit };
}

test("HOTDOG: the second press splits it -- a sausage that peels out and a bun that planes down for 7", async () => {
  /* Ninety frames, not sixty. The bun used to be on the floor nineteen frames
     after the split and now takes forty, so a sixty-frame recording ends with
     the bread still in the air and every check that reads the hit comes back
     undefined -- which reads like a move that stopped working rather than a
     recording that was too short. */
  const run = await simonVsReese();
  const S = SPEC(run);
  checkSplit(drive(run, SPLIT_SETUP, 90, HOTDOG_SPLIT), S);
});

test("negative control: a top that never gets faster fails the split test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "this.launchVx = this.vx * top.speedMul;", "this.launchVx = this.vx;") });
  const S = SPEC(run);
  const log = drive(run, SPLIT_SETUP, 90, HOTDOG_SPLIT);
  expectToFail(() => checkSplit(log, S),
    "with the sausage easing towards the speed it already had the split test should fail, " +
    "and it passed");
});

test("negative control: a bun that drops like a stone fails the split test", async () => {
  /* Exactly the bun this replaced: settle 1 puts it on its fall speed the
     first frame it exists, and 3.2 is what that speed used to be. Both at
     once, because either on its own is still a glide -- what is pinned is the
     four times longer it now takes to come down. */
  const run = await simonVsReese({ engine: sabotage(
    "fall: 1.25, settle: 0.18,", "fall: 3.2, settle: 1,") });
  const S = SPEC(run);
  const log = drive(run, SPLIT_SETUP, 90, HOTDOG_SPLIT);
  expectToFail(() => checkSplit(log, S),
    "with the bun back on a flat 3.2 the split test should fail, and it passed");
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
   payout() does with a result, not how the reels arrive at one. Every line
   gets its own RESET, so no prize is ever read on top of another one -- and
   because RESET clears buffTimer, a jackpot cannot leak its transformation
   into the reel measured after it. */
const PAYOUTS = `(function () {
    var out = {};
    ${RESET} foe.x = me.x + 30; me.mana = 10; me.ultMeter = 10; me.reels = [0, 0, 0]; me.payout(DOWN);
    out.jackLost = 100 - foe.health; out.jackFoe = foe.state; out.jackMana = me.mana;
    out.jackHealth = me.health; out.jackUlt = me.ultMeter;
    out.jackBuff = me.buffTimer; out.jackDmgMul = me.damageMul;
    ${RESET} foe.x = me.x + 30; me.mana = 10; me.reels = [0, 0, 1]; me.payout(DOWN);
    out.pairLost = 100 - foe.health; out.pairFoe = foe.state; out.pairMana = me.mana;
    out.pairBuff = me.buffTimer;
    ${RESET} foe.x = me.x + 60; me.mana = 10; me.reels = [0, 0, 1]; me.payout(DOWN);
    out.farLost = 100 - foe.health;
    ${RESET} me.mana = 10; me.reels = [1, 1, 1]; me.payout(DOWN); out.blue3 = me.mana;
    ${RESET} me.mana = 10; me.reels = [1, 1, 0]; me.payout(DOWN); out.blue2 = me.mana;
    ${RESET} me.health = 30; me.reels = [2, 2, 2]; me.payout(DOWN); out.green3 = me.health;
    ${RESET} me.health = 30; me.reels = [2, 2, 0]; me.payout(DOWN); out.green2 = me.health;
    ${RESET} me.ultMeter = 10; me.reels = [3, 3, 3]; me.payout(DOWN); out.spade3 = me.ultMeter;
    ${RESET} me.ultMeter = 10; me.reels = [3, 3, 0]; me.payout(DOWN); out.spade2 = me.ultMeter;
    ${RESET} me.reels = [0, 1, 2]; me.payout(DOWN);
    out.bust = me.health;
    ${RESET} me.health = 2; me.reels = [0, 1, 2]; me.payout(DOWN); out.bustFloor = me.health;
    ${RESET} me.health = 2; me.reels = [3, 2, 1]; me.payout(DOWN); out.bustFloorAgain = me.health;
    return JSON.stringify(out);
  })()`;

function checkPayouts(p, S) {
  /* THREE SEVENS PAY IN ONE CURRENCY AND IT IS NOT A NUMBER. No damage, no
     mana, no health, no meter -- the transformation and nothing else. A
     payout that also handed him a blast and a full bar was three rewards
     wearing one hat, and it was the reason no other symbol on the reel was
     worth chasing. Each of the four is asserted separately rather than as one
     "nothing happened", because a jackpot that quietly started paying mana
     again is exactly the regression this line is here to catch. */
  assert.equal(p.jackLost, 0,
    "three sevens take NOTHING off a foe standing well inside the ring; he lost " + p.jackLost);
  assert.equal(p.jackFoe, "idle", "and do not even put him in hitstun; he was " + p.jackFoe);
  assert.equal(p.jackMana, 10,
    "no mana either -- blue is the mana symbol, and sevens paying a full bar as well is what " +
    "made blue the one nobody ever had a reason to chase; it read " + p.jackMana);
  assert.equal(p.jackHealth, 100, "no health; it read " + p.jackHealth);
  assert.equal(p.jackUlt, 10, "and no meter; it read " + p.jackUlt);
  assert.ok(p.jackBuff > 0, "what it pays instead is the transformation; buffTimer read " + p.jackBuff);
  assert.equal(p.jackDmgMul, S.d.jackpot.damageMul,
    "which is live from the frame it lands: damageMul read " + p.jackDmgMul);

  /* A PAIR IS THE RING, and the ring is the only thing a near miss pays.
     Half a transformation is not a thing, so jackpot.damage is only ever read
     at k = 0.5 -- 22 is written down so a pair stays legibly HALF of
     something the way every other pair on this reel is, and 11 is what lands. */
  assert.equal(p.pairLost, S.d.jackpot.damage / 2,
    "a pair of sevens hits a foe inside the ring for half of " + S.d.jackpot.damage +
    "; he lost " + p.pairLost);
  assert.equal(S.d.jackpot.damage, 22, "so the ring lands 11 -- retune on purpose");
  assert.equal(p.pairFoe, "hitstun", "and it is a real hit; he was " + p.pairFoe);
  assert.equal(p.pairMana, 10, "a pair pays no mana either; it read " + p.pairMana);
  assert.equal(p.pairBuff, 0,
    "and it does NOT transform him -- a jackpot a near miss mostly delivers is not a jackpot; " +
    "buffTimer read " + p.pairBuff);
  assert.equal(p.farLost, 0,
    "a foe outside the " + S.d.jackpot.radius + "px ring is untouched; he lost " + p.farLost);

  assert.equal(p.blue3, S.manaMax,
    "three blues pay " + S.d.chips.mana + " mana, which from 10 is the cap of " + S.manaMax +
    "; it read " + p.blue3);
  assert.equal(S.d.chips.mana, 100, "and that is 100 -- retune on purpose");
  assert.equal(p.blue2, 10 + S.d.chips.mana / 2,
    "and a pair pays half of it; it read " + p.blue2);

  assert.equal(p.green3, 30 + S.d.heal.health,
    "three greens heal " + S.d.heal.health + " from 30; health read " + p.green3);
  assert.equal(S.d.heal.health, 50,
    "and that is 50 now, not the old 24: green is the symbol you chase when you are losing, " +
    "so three of them is half a bar -- retune on purpose");
  assert.equal(p.green2, 30 + S.d.heal.health / 2,
    "and a pair heals half of it; it read " + p.green2);

  /* THE HOUSE IS THE ONE REEL THAT DOES NOT HALVE, in either direction.
     Three spades fill the bar OUTRIGHT however empty it was -- "you may use
     your ult now" reads cleaner off a symbol than a number you have to go
     and find on the HUD -- and a pair adds the roster's number FLAT rather
     than half of it, which is why payout() keeps this branch out of k
     entirely. */
  assert.ok(S.ultMax > 10 + S.d.house.ult,
    "precondition: filling the bar outright and adding " + S.d.house.ult + " to 10 have to be " +
    "different numbers or the next line cannot tell them apart; ultMax " + S.ultMax);
  assert.equal(p.spade3, S.ultMax,
    "three spades set the bar to " + S.ultMax + " outright from 10, not to 10 + " +
    S.d.house.ult + "; it read " + p.spade3);
  assert.equal(p.spade2, 10 + S.d.house.ult,
    "and a pair adds " + S.d.house.ult + " FLAT, not half of it; it read " + p.spade2);
  assert.equal(S.d.house.ult, 50, "and that is 50 -- retune on purpose");

  assert.equal(p.bust, 100 - S.d.bust.damage,
    "no pair busts for " + S.d.bust.damage + " off his own bar; it read " + p.bust);
  assert.equal(S.d.bust.damage, 3, "and that is 3 -- retune on purpose");
  assert.equal(p.bustFloor, 1, "a bust never takes him below 1 health; from 2 it read " + p.bustFloor);
  assert.equal(p.bustFloorAgain, 1, "whatever three different symbols came up; it read " + p.bustFloorAgain);
}

test("SLOTS: the payout table -- sevens pay a transformation, every other reel pays a number, and a bust costs 3", async () => {
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

test("negative control: a jackpot that pays mana again fails the payout test", async () => {
  /* The inverse of the control that used to stand here. Sevens paying a full
     bar on top of everything else was the shipped behavior once and is the
     thing that was taken away, so the sabotage is putting it back: a hundred
     mana into the sevens branch, ahead of the transformation, halved for a
     pair like every other reel. */
  const run = await simonVsReese({ engine: sabotage(
    "        addEffect('ring', this.x, this.y - 8, '#ffd60a');\n",
    "        addEffect('ring', this.x, this.y - 8, '#ffd60a');\n" +
    "        this.mana = Math.min(COMBAT.manaMax, this.mana + 100 * k);\n") });
  const S = SPEC(run);
  const p = JSON.parse(run(PAYOUTS));
  expectToFail(() => checkPayouts(p, S),
    "with the sevens paying mana again the payout test should fail; it passed");
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
  let carried = 0;
  for (let f = u.startup; f < u.startup + u.active; f++) {
    const dx = log[f].x - log[f - 1].x;
    assert.ok(dx >= 1 && dx <= u.lunge + 1e-9,
      "the lunge carries him forward on every active frame, up to the roster's " + u.lunge +
      " per frame; frame " + f + " moved him " + dx);
    carried += dx;
  }
  assert.equal(u.lunge, 4.2, "and the lunge is 4.2, up from 2.4 -- retune on purpose");
  /* The lunge is what turns this from a move you had to already be in range
     for into an approach. The box is live for exactly the frames he is
     moving, so contact during the lunge IS the catch -- it simply did not
     travel far enough to reach anybody. Measured as the whole trip rather
     than per frame because per frame is friction's business and the trip is
     the move's: eight active frames carried him ten and a half pixels at 2.4
     and carry him eighteen and a half now. */
  assert.ok(carried > 15,
    "and eight active frames of it have to carry him more than fifteen pixels -- at the old " +
    "2.4 they carried him ten and a half; he travelled " + carried);

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

  /* The blade takes NOTHING off. It used to land for 14 on the last frame of
     the hold, which was the choke being paid for twice -- seven ticks of a
     slow squeeze and then the single biggest hit in the game on the way out.
     All of the move's damage is in the choke now; the finish only moves
     them. */
  const finished = log[F - 1].fhp - log[F].fhp;
  assert.equal(finished, u.finish.damage,
    "on the last frame of the hold the blade takes " + u.finish.damage +
    "; he lost " + finished);
  assert.equal(u.finish.damage, 0,
    "and that is 0 -- the throw costs no health at all any more, retune on purpose");
  assert.equal(log[F].nan, false, "and his health is a number");

  // It takes nothing and still throws: that half of the move is the point.
  assert.equal(log[F].fst, "hitstun", "and he is launched out of the hold");
  assert.equal(log[F].gr, -1, "and let go of");
  assert.ok(log[F].fvy > 0, "launched DOWN: vy should be positive, it was " + log[F].fvy);
  assert.equal(Math.sign(log[F].fvx), 1, "and forward, the way Simon faces; vx was " + log[F].fvx);
  assert.ok(u.finish.base > 0 && u.finish.scale > 0,
    "a throw with no force behind it is not a throw; base/scale read " +
    u.finish.base + "/" + u.finish.scale);
  assert.equal(u.finish.base + "/" + u.finish.scale + "@" + u.finish.angle, "2.6/4.2@340",
    "and the blade is 2.6/4.2 at 340 -- retune on purpose");
  /* 340, not 300, and this is the half of that retune that can be seen. 300
     is sixty degrees BELOW the horizontal, so nearly all of a small force was
     going straight into a floor that was already there -- a man slammed
     downward while standing on the ground does not move, he just stops, and
     the throw read as no knockback at all. 340 is twenty degrees below, so
     most of the force is TRAVEL. Pinned as a ratio of the two velocities
     rather than as either number, because that is the claim: still down, but
     mostly along. */
  assert.ok(Math.abs(log[F].fvx) > Math.abs(log[F].fvy),
    "most of the blade's force is travel rather than floor: |vx| has to beat |vy|, and they " +
    "read " + Math.abs(log[F].fvx) + " against " + Math.abs(log[F].fvy));

  /* Which leaves the choke holding every point the move costs: the catch,
     then the ticks, and nothing added on the way out. */
  const choked = ticks.length * u.choke.damage;
  assert.ok(choked > 0, "the choke is where the damage lives; the ticks took " + choked);
  assert.ok(near(100 - log[F].fhp, u.grab.damage + choked),
    "and the catch plus the choke is the whole bill -- " + u.grab.damage + " + " + choked +
    "; total lost " + (100 - log[F].fhp));
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

test("negative control: a blade that takes health again fails the choke test", async () => {
  /* The retune the whole check now hangs on. The spec still reads 0, so this
     is not a number the checker can be talked out of by reading it back --
     the blade is handed a patched copy with the old 14 on it, and the frame
     the hold ends has to show the health going. */
  const run = await simonVsReese({ engine: sabotage(
    "      releaseGrab(this);\n      applyHit(this, victim, s.finish, from);\n",
    "      releaseGrab(this);\n" +
    "      applyHit(this, victim, Object.assign({}, s.finish, { damage: 14 }), from);\n") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 14;", 120, CHOKE);
  expectToFail(() => checkChoke(log, S),
    "with the blade taking 14 again the choke test should fail; it passed");
});

test("negative control: a finish with no force left fails the choke test", async () => {
  /* Damage 0 on its own would be a move that lets go rather than a throw.
     With base and scale gone too the hold ends with the foe standing where
     he was, which is what this half of the check exists to catch. */
  const run = await simonVsReese({ engine: sabotage(
    "      finish: { damage: 0, base: 2.6, scale: 4.2, angle: 340,",
    "      finish: { damage: 0, base: 0, scale: 0, angle: 340,") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 14;", 120, CHOKE);
  expectToFail(() => checkChoke(log, S),
    "with nothing behind the blade the choke test should fail; it passed");
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
  " sl: !!me.slouching(), sd: me.slouchDamage, bite: me.slouchBite, stk: me.stocks," +
  " mf: me.manaFree, soul: countOf(Soul)," +
  " fd: foe.drowsy, fst: foe.state, fhp: foe.health, fgr: foe.grounded }";

/* Health at 40 and mana at 10, so a health bar that moves has room to move in
   BOTH directions and the free-mana window has room to be seen; the ult meter
   is full. `at` is where the foe stands. */
/* 700 by default, not 360. Ten seconds of sleep plus the 24 nodding off and
   the 18 getting up is 642 frames, and a recording that stopped at 360 ended
   mid-sleep -- every check that reads the wake frame came back undefined,
   which reads like a move that never ends rather than a recording that was
   too short. */
const slouch = (run, at, extra, frames) => drive(run,
  "me.ultMeter = 999; me.health = 40; me.mana = 10; foe.x = me.x + " + at + ";",
  frames || 700, { mana: false, p0: `i === 0 ? ${ULT} : 0`, pre: extra || "", rec: SLOUCH_REC });

function checkSleep(log, S) {
  const u = S.ult, sleepFrom = u.startup, wake = u.startup + u.active;
  assert.equal(u.startup + "/" + u.active, "24/600",
    "24 frames of nodding off, then TEN seconds asleep -- it was five, retune on purpose");
  assert.equal(log[0].st, "ult", "precondition: the press was heard");
  assert.equal(log[wake + u.recovery - 1].st, "ult", "the move runs its whole length");
  assert.equal(log[wake + u.recovery].st, "idle", "and ends on schedule");
  for (let f = 0; f < wake + u.recovery; f++) {
    assert.equal(log[f].x, log[0].x, "rooted from the first nod: x moved on frame " + f);
  }
  for (let f = 1; f < sleepFrom; f++) {
    assert.equal(log[f].inv, 0, "not yet untouchable while he nods off; invuln was " + log[f].inv + " on frame " + f);
  }
  /* HE CARRIES NO I-FRAMES, AND THAT IS ON PURPOSE RATHER THAN AN OMISSION.

     Nothing can take his health -- see the test below this one -- but that is
     NOT done by pinning `invuln`, and the difference is the whole mechanic.
     An invulnerable body is a body every blow MISSES, and a blow that misses
     cannot pay for anything: the damage has to land and be measured before it
     can be spent on the clock. So he is un-damageable and not invulnerable,
     which also keeps the ring-type AoEs that skip i-frames reaching him.

     Asserted from BOTH sides, because "invuln is 0" alone would also be true
     of a Simon who was never in the ult at all: he is asleep by the engine's
     own reckoning on every one of these frames, and guarded on none. */
  for (let f = sleepFrom; f < wake; f++) {
    assert.equal(log[f].inv, 0,
      "the sleeping body carries no invulnerability now; invuln was " +
      log[f].inv + " on frame " + f + " (attackFrame " + log[f].af + ")");
    assert.ok(log[f].sl,
      "and the engine has to agree he is asleep on every one of those frames; " +
      "slouching() was null on frame " + f + " (attackFrame " + log[f].af + ")");
  }
  assert.ok(!log[sleepFrom - 1].sl && !log[wake].sl,
    "asleep for exactly the active window and not a frame either side");
  /* AND HIS HEALTH DOES NOT MOVE, IN EITHER DIRECTION.

     It used to climb: forty over the six hundred frames, which is what the
     ult was paid when the body stopped being invulnerable. Measured on the
     shipped 2.85 build it returned about 28 of that forty per nap against 5
     to 16 taken, so lying down was worth health. It is gone, and nothing is
     put in its place -- the sleep buys the ten seconds and not a point. */
  assert.equal(u.heal, undefined,
    "there is no `heal` on the slouch any more and there is not supposed to " +
    "be one; the roster says " + u.heal);
  for (let f = 0; f < wake + u.recovery; f++) {
    assert.equal(log[f].hp, log[0].hp,
      "his health does not move for the whole move -- no heal going in and " +
      "nothing takes it coming out; it went " + log[0].hp + " -> " +
      log[f].hp + " on frame " + f);
  }

  /* The mana is not refilled, it is suspended: while the window runs the bar
     is simply pinned full. The pin runs at the top of update(), one frame
     behind the runSpecial frame that opens it, so the frame it is armed on
     is the one frame it cannot have covered yet.

     One clock, not two. The window opens on the frame the eyes close -- not
     the frame he commits -- and it is the same length as the sleep, so the
     bar emptying IS the ult ending. It used to be five seconds of sleep
     inside ten seconds of free specials, and the second half was a countdown
     to nothing anyone could see. */
  assert.equal(u.manaFree, u.active,
    "one clock: the free window is exactly as long as the sleep (" + u.active +
    "); manaFree is " + u.manaFree);
  assert.ok(log[0].mana < S.manaMax, "precondition: the bar was low going in; it read " + log[0].mana);
  assert.equal(log[sleepFrom - 1].mf, 0,
    "nothing is free while he is still nodding off; on frame " + (sleepFrom - 1) +
    " manaFree read " + log[sleepFrom - 1].mf);
  assert.equal(log[sleepFrom].mf, u.manaFree,
    "and the whole window is on the clock the frame the eyes close (" + sleepFrom +
    ") at the roster's " + u.manaFree + "; manaFree read " + log[sleepFrom].mf);
  for (let f = sleepFrom + 1; f <= sleepFrom + u.manaFree; f++) {
    assert.equal(log[f].mana, S.manaMax,
      "the bar reads full on every frame of the window; on frame " + f + " it read " + log[f].mana);
  }
  for (let f = sleepFrom + 1; f <= sleepFrom + u.manaFree; f++) {
    assert.equal(log[f].mf, log[f - 1].mf - 1,
      "and it ticks down one a frame; it went " + log[f - 1].mf + " -> " + log[f].mf +
      " on frame " + f);
  }
  assert.equal(log[wake - 1].mf, 1, "not closed a frame early; on the last sleeping frame it read " + log[wake - 1].mf);
  assert.equal(log[wake].mf, 0,
    "and empty on the wake frame exactly: the bar running out is how you know the ult is over; " +
    "manaFree read " + log[wake].mf);
  /* ONE NUMBER, NOT TWO THAT AGREE. `manaFree` is exactly the frames left in
     the sleep on every frame of it, which is why damage can be spent on the
     bar and the picture cannot lie about the clock. Undisturbed this is
     implied by the tick above; under fire it is the only thing holding the
     two together, and it is what the drain test leans on. */
  for (let f = sleepFrom; f < wake; f++) {
    assert.equal(log[f].mf, u.startup + u.active - log[f].af,
      "the free window IS the frames left in the sleep, on every frame of it: " +
      "on frame " + f + " attackFrame was " + log[f].af + ", which leaves " +
      (u.startup + u.active - log[f].af) + ", and manaFree read " + log[f].mf);
  }

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

// Past the recovery, which is now the same thing as past the free-mana
// window: 24 + 600 + 18 = 642, and the pair end together.
const SLEEP_FRAMES = 700;

test("SLOUCH: 24 frames to nod off, then ten seconds asleep -- rooted, un-damageable, healing nothing, and every special free for exactly as long", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkSleep(slouch(run, 30, "", SLEEP_FRAMES), S);
});

test("negative control: a sleep that pins i-frames again fails the sleep test", async () => {
  /* The old guard put BACK. It matters more than a rename: an invulnerable
     body is a body every blow MISSES, so a pin quietly reintroduced here
     would leave a move that says damage costs him time and a body no damage
     can reach -- and nothing else in the suite would notice, because every
     other assertion about the sleep is about a Simon nobody is hitting. */
  const run = await simonVsReese({ engine: sabotage(
    "        if (asleep) {",
    "        if (asleep) {\n          this.invuln = Math.max(this.invuln, 2);") });
  const S = SPEC(run);
  const log = slouch(run, 30, "", SLEEP_FRAMES);
  expectToFail(() => checkSleep(log, S),
    "with the sleeping body carrying i-frames again the sleep test should fail; it passed");
});

test("negative control: a sleep that heals again fails the sleep test", async () => {
  /* The forty put back, at the rate it ran at in 2.85. This is the assertion
     the release is about, so it gets the control that restores exactly what
     was taken out rather than a nearby mutation. */
  const run = await simonVsReese({ engine: sabotage(
    "        if (asleep) {",
    "        if (asleep) {\n          this.health = Math.min(COMBAT.maxHealth, this.health + 40 / s.active);") });
  const S = SPEC(run);
  const log = slouch(run, 30, "", SLEEP_FRAMES);
  expectToFail(() => checkSleep(log, S),
    "with the sleep healing him again the sleep test should fail; it passed");
});

/* =====================================================================
   DAMAGE DRAINS THE BAR

   He cannot be hurt in his sleep and he is not healed by it. What a blow
   takes instead is TIME: ten frames of the ten seconds for every point, so
   sixty damage ends the nap outright and anything less shortens it by exactly
   what it was worth. One number does it -- `drain` -- and the bar the player
   is watching is the same clock, so the picture cannot drift from the rule.

   Sixty is not a new number. It is `rouse` 30 behind a `guard` of a half,
   which was sixty swung; what changed is that it now arrives a hit at a time
   instead of as a cliff, and costs him no health on the way.

   Everything here drives synthetic hits through applyHit rather than
   arranging a real swing, because what is under test is the rule and not
   anybody's hitbox. The hits are dealt from the foe so the attacker path is
   the real one.
   ===================================================================== */

const SHAKE = (perHit, every, from, until) => ({
  mana: false,
  /* `me.slouching()` guards the swing so every hit these tests count is one
     that went into the SLEEPING body. Without it the tail of a run that woke
     early keeps landing blows on a man who is awake, and the ledger the
     arithmetic is checked against stops being about the nap. */
  pre: "if (i >= " + from + " && i < " + until + " && (i % " + every + ") === 0" +
       "    && me.slouching()) {" +
       "  applyHit(foe, me, { damage: " + perHit + ", base: 1, scale: 1," +
       "    angle: 45, kx: 0.7071067811865476, ky: 0.7071067811865476 }, foe.x);" +
       "}",
  p0: `i === 0 ? ${ULT} : 0`,
  rec: SLOUCH_REC,
});

/* THE LEDGER, ASSERTED AS ONE LINE OF ARITHMETIC.

   On every frame he is still asleep, attackFrame has run ahead of the wall
   clock by exactly ten frames for every point of damage the nap has absorbed.
   That single equality is the whole mechanic: `af - f` is the time the sleep
   has lost and `sd` is what was spent to lose it.

   Math.round on the RUNNING TOTAL rather than per tick, which is what the
   engine does and why a burn ticking a sixteenth of a point a frame costs the
   same as one blow of the same size. */
function checkDrainLedger(log, S, why) {
  const u = S.ult;
  let paid = 0;
  for (let f = u.startup; f < log.length; f++) {
    if (!log[f].sl) break;
    assert.equal(log[f].af - f, Math.round(log[f].sd * u.drain),
      why + ": on frame " + f + " the nap had absorbed " + log[f].sd +
      " damage, which is " + Math.round(log[f].sd * u.drain) + " frames at " +
      u.drain + " a point, and attackFrame had run " + (log[f].af - f) +
      " frames ahead of the clock");
    paid = log[f].sd;
  }
  return paid;
}

/* The frame the sleep stopped, whatever stopped it. */
const endOfSleep = (log) => {
  for (let i = 1; i < log.length; i++) if (log[i - 1].sl && !log[i].sl) return i;
  return -1;
};

test("every point of damage costs him ten frames of nap, and the soul goes in with him", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  assert.equal(S.ult.drain, 10, "ten frames a point -- retune on purpose");
  assert.equal(S.ult.active / S.ult.drain, 60,
    "which puts the whole nap at sixty damage: " + S.ult.active + " frames at " +
    S.ult.drain + " a point. Sixty is what `rouse` 30 behind a `guard` of a " +
    "half already cost, arriving a hit at a time instead of as a cliff");
  /* The three keys this replaced. They are asserted ABSENT rather than left
     to rot: a `guard` quietly put back would halve the rate with no other
     symptom, and a `lethal` put back would be a branch on a flag nothing
     writes. */
  assert.equal(S.ult.guard, undefined,
    "`guard` is gone from the slouch -- the drain is per point of RAW damage, " +
    "and two multipliers on one number are two knobs doing one job");
  assert.equal(S.ult.rouse, undefined,
    "`rouse` is gone -- the threshold is `active` itself now");
  assert.equal(S.ult.lethal, undefined,
    "`lethal` is gone -- it guarded one subtraction and the subtraction is gone");

  const full = slouch(run, 200, "", SLEEP_FRAMES);
  const natural = endOfSleep(full);
  assert.equal(natural, S.ult.startup + S.ult.active,
    "precondition: undisturbed, the sleep runs its whole length and ends on frame " +
    (S.ult.startup + S.ult.active) + "; it ended on " + natural);
  checkDrainLedger(full, S, "undisturbed, nothing has been spent");

  /* Six twelve-damage swings, forty frames apart. Every one of them has to
     cost exactly a hundred and twenty frames, which the ledger checks on
     every single frame rather than once at the end. */
  const shaken = drive(run, "me.ultMeter = 999; me.health = 90;", SLEEP_FRAMES,
    SHAKE(12, 40, 41, 641));
  const woke = endOfSleep(shaken);
  assert.ok(woke > 0 && woke < natural,
    "twelve-damage swings should shorten the sleep; it ended on frame " +
    woke + " against " + natural + " undisturbed");
  const paid = checkDrainLedger(shaken, S, "under twelve-damage swings");
  assert.ok(paid > 0, "precondition: the swings landed; the ledger read " + paid);
  assert.equal(shaken[woke].soul, 0,
    "the soul goes back in on the same frame; there were " + shaken[woke].soul);
  assert.equal(shaken[woke].af, S.ult.startup + S.ult.active,
    "and it is the WAKE frame he lands on, not some frame in the middle -- the " +
    "stretch ring and the soul both hang off that one number; attackFrame read " +
    shaken[woke].af);
  // Rooted and unflinching the whole way: a hit that moved him would end the
  // move by a route the ledger knows nothing about.
  for (let f = 1; f < woke; f++) {
    assert.equal(shaken[f].x, shaken[0].x,
      "he never moves off his spot; x changed on frame " + f);
    assert.notEqual(shaken[f].st, "hitstun",
      "and is never put in hitstun by a hit; he was on frame " + f);
  }
});

test("a hit too small to end it still costs exactly what it is worth", async () => {
  /* The other half of the same rule, and the half a single "it ended early"
     test would let rot. Eight a swing, forty frames apart, is eighty frames a
     swing: the nap has to get shorter by exactly that much and by nothing
     else, and it has to still end on the bar rather than on a threshold. */
  const run = await simonVsReese();
  const S = SPEC(run);
  const log = drive(run, "me.ultMeter = 999; me.health = 90;", SLEEP_FRAMES,
    SHAKE(8, 40, 41, 641));
  const woke = endOfSleep(log);
  const paid = checkDrainLedger(log, S, "under eight-damage swings");
  assert.ok(paid > 0, "precondition: the swings landed; the ledger read " + paid);
  assert.ok(woke < S.ult.startup + S.ult.active,
    "and enough of them do end it: the sleep ran to frame " + woke);
  assert.equal(log[woke].mf, 0,
    "on the bar, not on a threshold: the free window reads zero on the frame " +
    "the sleep ends and the ult ends there because of it; it read " + log[woke].mf);
  assert.ok(log[woke - 1].mf >= 1,
    "and it had frames left on the frame before; it read " + log[woke - 1].mf);
});

test("negative control: one frame short per hit does not match the ledger", async () => {
  /* The mechanism rather than the constant. `drain` is a retune-on-purpose
     number and a control that changed it would only prove the roster was
     read; what has to be controlled is that attackFrame really moves by
     `drain` times the damage and not by something near it. One frame short a
     hit is the smallest lie the ledger has to catch, and it is invisible
     everywhere else -- the sleep just lasts six frames longer. */
  const run = await simonVsReese({ engine: sabotage(
    "    this.attackFrame = Math.min(end - 1, was + cost);",
    "    this.attackFrame = Math.min(end - 1, was + cost - 1);") });
  const S = SPEC(run);
  const log = drive(run, "me.ultMeter = 999; me.health = 90;", SLEEP_FRAMES,
    SHAKE(12, 40, 41, 641));
  expectToFail(() => checkDrainLedger(log, S, "under twelve-damage swings"),
    "a drain that lands one frame short of what it charged should fail the " +
    "ledger; it passed");
});

test("the tally is per-sleep: what he took last time does not carry into the next one", async () => {
  /* `slouchDamage` is a Fighter field and lives as long as he does. Zeroed on
     the frame the eyes close rather than when he wakes, because the sleep has
     several ways to end and only one way to begin. */
  const run = await simonVsReese();
  const S = SPEC(run);
  const r = JSON.parse(run(`(function () {
    ${RESET}
    me.slouchDamage = 999;
    var before = me.slouchDamage;
    netplay.active = true;
    me.ultMeter = 999;
    for (var i = 0; i <= ROSTER.simon.ult.startup + 1; i++) {
      me.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
      step();
    }
    netplay.active = false; netplay.framePads = null;
    return JSON.stringify({ before: before, after: me.slouchDamage,
                            asleep: !!me.slouching() });
  })()`));
  assert.equal(r.before, 999, "precondition: the field carried a stale number in");
  assert.ok(r.asleep, "precondition: he should be asleep by now");
  assert.equal(r.after, 0,
    "the tally starts this sleep at zero; it read " + r.after);
});

/* The worst single blow in the game plus the worst poison and the worst burn,
   all into the same sleeping man. The DoT is armed on the first sleeping
   frame rather than before the cast, because a status applied to a man who is
   already asleep cannot get in through applyHit -- the nap branch returns
   above the line that sets one -- so this is the only way a sleeping Simon
   can be carrying one, and it is the way that used to kill him. */
const ONSLAUGHT = {
  mana: false,
  p0: `i === 0 ? ${ULT} : 0`,
  rec: SLOUCH_REC,
  pre: "if (me.slouching()) {" +
       "  if (me.burn === 0 && me.poison === 0) {" +
       "    me.burn = 240; me.burnDps = 15 / 240;" +
       "    me.poison = 150; me.poisonDps = 0.09; me.poisonBy = 1;" +
       "  }" +
       "  if (i % 30 === 0) {" +
       "    applyHit(foe, me, { damage: i === 90 ? 999 : 6, base: 1, scale: 1," +
       "      angle: 45, kx: 0.7071067811865476, ky: 0.7071067811865476 }, foe.x);" +
       "  }" +
       "}",
};

function checkNothingTakesHisHealth(log, S, why) {
  const asleep = log.filter((r) => r.sl);
  assert.ok(asleep.length > 20, "precondition: he was asleep for a while; " +
    asleep.length + " frames");
  const paid = Math.max(...asleep.map((r) => r.sd));
  assert.ok(paid > 0,
    "precondition: the blows and the clocks actually reached him -- the " +
    "ledger has to have counted something or this test is vacuous; it read " + paid);
  for (const r of asleep) {
    assert.equal(r.hp, log[0].hp, why + ": his health moved from " + log[0].hp +
      " to " + r.hp + " on a sleeping frame. Nothing takes it while he is " +
      "down -- not a blow, not a poison, not a burn. The damage is real and " +
      "it is spent on the clock");
    assert.notEqual(r.st, "ko", why + ": he was KO'd in his sleep");
    assert.equal(r.stk, log[0].stk, why + ": he lost a stock in his sleep");
  }
}

test("nothing takes his health while he sleeps -- not a blow, not a poison, not a burn", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  /* Ten health, so anything that reached him would kill him and the failure
     would be loud. A 999-damage blow goes in on frame 90, which is the size
     SALAMENCE carries -- the game's one guaranteed kill -- and it takes the
     ult and not the stock. */
  const log = drive(run, "me.ultMeter = 999; me.health = 10; me.stocks = 3;",
    SLEEP_FRAMES, ONSLAUGHT);
  checkNothingTakesHisHealth(log, S, "under everything at once");
  const woke = endOfSleep(log);
  assert.ok(woke > 0 && woke < S.ult.startup + S.ult.active,
    "and 999 damage does end the nap on the spot: it ran to frame " + woke +
    " against " + (S.ult.startup + S.ult.active) + " undisturbed");
});

test("negative control: with the blow back on the health bar he dies in his sleep", async () => {
  /* The 2.85 path restored: a blow lands on the health bar instead of the
     clock. Without `lethal: false` beside it -- which is gone with the rest --
     a ten-health Simon is killed by the first six-damage poke. */
  const run = await simonVsReese({ engine: sabotage(
    "    if (!defender.takeSlouch(dealt)) {", "    if (true) {") });
  const S = SPEC(run);
  const log = drive(run, "me.ultMeter = 999; me.health = 10; me.stocks = 3;",
    SLEEP_FRAMES, ONSLAUGHT);
  expectToFail(() => checkNothingTakesHisHealth(log, S, "with the blow back on the bar"),
    "a blow that reaches the health bar should fail the invincibility test; it passed");
});

test("negative control: with the burn back on the health bar it kills him in his sleep", async () => {
  /* The half a blow cannot reach. A poison or a burn ticks in update(), not
     through applyHit, so it is a second path with its own guard -- and it is
     the one that was live at 2.85: the recon caught burns killing sleeping
     Simons in CPU play. The roster used to argue for that on purpose, which
     is why it gets a control of its own rather than sharing one. */
  const run = await simonVsReese({ engine: sabotage(
    "      if (!this.takeSlouch(this.burnDps)) this.health -= this.burnDps;",
    "      this.health -= this.burnDps;") });
  const S = SPEC(run);
  const log = drive(run, "me.ultMeter = 999; me.health = 10; me.stocks = 3;",
    SLEEP_FRAMES, ONSLAUGHT);
  expectToFail(() => checkNothingTakesHisHealth(log, S, "with the burn back on the bar"),
    "a burn that reaches the health bar should fail the invincibility test; it passed");
});

test("negative control: with the poison back on the health bar it kills him in his sleep", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "      if (!this.takeSlouch(this.poisonDps)) this.health -= this.poisonDps;",
    "      this.health -= this.poisonDps;") });
  const S = SPEC(run);
  const log = drive(run, "me.ultMeter = 999; me.health = 10; me.stocks = 3;",
    SLEEP_FRAMES, ONSLAUGHT);
  expectToFail(() => checkNothingTakesHisHealth(log, S, "with the poison back on the bar"),
    "a poison that reaches the health bar should fail the invincibility test; it passed");
});

/* =====================================================================
   THE BAR IS THE CLOCK

   `manaFree` is the glowing, marching stretch on the mana bar and it is also
   the frames left in the sleep. Damage takes the same amount off both because
   takeSlouch moves them by the same delta rather than assigning either -- and
   it has to be a delta, because it is called from two different points in a
   frame: from update(), where the poison and burn clocks live and attackFrame
   has not been incremented yet, and from resolveCombat, where it has.

   This did not hold before 2.86. `rouse` moved the sleep and left the bar
   running, so a Simon woken at frame 32 kept a glowing meter for another 592
   frames with nothing behind it.
   ===================================================================== */

function checkBarIsTheClock(log, S, why) {
  const u = S.ult, end = u.startup + u.active;
  let last = -1;
  for (let f = u.startup; f < log.length; f++) {
    if (!log[f].sl) break;
    assert.equal(log[f].mf, end - log[f].af,
      why + ": on frame " + f + " the sleep had " + (end - log[f].af) +
      " frames left and the bar read " + log[f].mf);
    last = f;
  }
  assert.ok(last > u.startup, "precondition: he slept; last sleeping frame " + last);
  assert.ok(log[last].mf >= 1,
    why + ": the bar still had something on it on the last sleeping frame; it read " +
    log[last].mf);
  assert.equal(log[last + 1].mf, 0,
    why + ": and it is empty on the frame the ult ends -- the bar running out " +
    "IS the ult ending; it read " + log[last + 1].mf);
}

test("the bar and the clock are one number, under fire and carrying a burn", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkBarIsTheClock(slouch(run, 200, "", SLEEP_FRAMES), S, "undisturbed");
  checkBarIsTheClock(drive(run, "me.ultMeter = 999; me.health = 90;", SLEEP_FRAMES,
    SHAKE(9, 30, 41, 641)), S, "under nine-damage swings");
  /* The burning case is the one that catches an ASSIGNMENT instead of a
     delta. takeSlouch is called from update() there, a frame before
     attackFrame moves, so `manaFree = end - attackFrame` is a frame out on
     every frame of the nap and nothing else in the suite sees it. */
  checkBarIsTheClock(drive(run, "me.ultMeter = 999; me.health = 90;", SLEEP_FRAMES,
    ONSLAUGHT), S, "carrying a poison and a burn");
});

test("negative control: a bar that is assigned rather than moved runs a frame ahead", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "    this.manaFree = Math.max(0, this.manaFree - (this.attackFrame - was));",
    "    this.manaFree = Math.max(0, end - this.attackFrame);") });
  const S = SPEC(run);
  expectToFail(() => checkBarIsTheClock(drive(run,
    "me.ultMeter = 999; me.health = 90;", SLEEP_FRAMES, ONSLAUGHT),
    S, "with the bar assigned"),
    "a bar assigned from attackFrame is a frame out when the poison clock " +
    "drains it and should fail; it passed");
});

test("negative control: a bar that is never drained outlives the ult", async () => {
  /* The bug this release fixed, put back in its purest form: the clock moves
     and the picture does not. */
  const run = await simonVsReese({ engine: sabotage(
    "    this.manaFree = Math.max(0, this.manaFree - (this.attackFrame - was));",
    "") });
  const S = SPEC(run);
  expectToFail(() => checkBarIsTheClock(drive(run,
    "me.ultMeter = 999; me.health = 90;", SLEEP_FRAMES, SHAKE(9, 30, 41, 641)),
    S, "with the bar left running"),
    "a bar that is not drained should fail; it passed");
});

test("the HUD's bite is the chunk the last BLOW took, and a burn underneath does not move it", async () => {
  /* `slouchBite` is what drawHud paints past the end of the bar for eight
     frames after a hit. It is written in applyHit rather than inside
     takeSlouch for exactly this reason: a burn ticking a fraction of a frame
     off underneath would otherwise overwrite the chunk the picture is still
     showing, and the lurch would collapse to a flicker. */
  const run = await simonVsReese();
  const S = SPEC(run);
  const HIT = 120;
  const log = drive(run, "me.ultMeter = 999; me.health = 90;", SLEEP_FRAMES, {
    mana: false, p0: `i === 0 ? ${ULT} : 0`, rec: SLOUCH_REC,
    pre: "if (me.slouching() && me.burn === 0) { me.burn = 240; me.burnDps = 15 / 240; }" +
         "if (i === " + HIT + ") { applyHit(foe, me, { damage: 14, base: 1, scale: 1," +
         "  angle: 45, kx: 0.7071067811865476, ky: 0.7071067811865476 }, foe.x); }",
  });
  assert.equal(log[HIT - 1].bite, 0,
    "nothing is drawn before the blow, however hard the burn is ticking; it read " +
    log[HIT - 1].bite);
  assert.ok(log[HIT - 1].mf < log[HIT - 5].mf,
    "precondition: the burn is draining the bar underneath; it read " +
    log[HIT - 5].mf + " then " + log[HIT - 1].mf);
  assert.equal(log[HIT].bite, 14 * S.ult.drain,
    "fourteen damage is " + (14 * S.ult.drain) + " frames off the bar, and that " +
    "is the size of the chunk the HUD draws; it read " + log[HIT].bite);
  for (let f = HIT; f < HIT + 8; f++) {
    assert.equal(log[f].bite, 14 * S.ult.drain,
      "and it holds still for the eight frames the ghost is drawn over, while " +
      "the burn goes on taking frames off underneath; on frame " + f +
      " it read " + log[f].bite);
  }
});

test("negative control: a bite written by the clock rather than the blow is smeared by the burn", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "      defender.slouchBite = wasLeft - defender.manaFree;",
    "      defender.slouchBite = wasLeft - defender.manaFree;\n" +
    "      if (defender.burn > 0) defender.slouchBite = 1;") });
  const S = SPEC(run);
  const HIT = 120;
  const log = drive(run, "me.ultMeter = 999; me.health = 90;", SLEEP_FRAMES, {
    mana: false, p0: `i === 0 ? ${ULT} : 0`, rec: SLOUCH_REC,
    pre: "if (me.slouching() && me.burn === 0) { me.burn = 240; me.burnDps = 15 / 240; }" +
         "if (i === " + HIT + ") { applyHit(foe, me, { damage: 14, base: 1, scale: 1," +
         "  angle: 45, kx: 0.7071067811865476, ky: 0.7071067811865476 }, foe.x); }",
  });
  expectToFail(() => assert.equal(log[HIT].bite, 14 * S.ult.drain,
    "the bite is the chunk the blow took"),
    "a bite a burn can overwrite should fail; it passed");
});

test("negative control: a free window that does not pin the bar fails the sleep test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "if (this.manaFree > 0) { this.manaFree--; this.mana = COMBAT.manaMax; }",
    "if (this.manaFree > 0) { this.manaFree--; }") });
  const S = SPEC(run);
  const log = slouch(run, 30, "", SLEEP_FRAMES);
  expectToFail(() => checkSleep(log, S), "with the window counting but not paying the sleep test should fail; it passed");
});

test("negative control: a window armed a nod early fails the sleep test", async () => {
  /* Where it used to be armed: attackFrame 1, the frame he commits, twenty-
     three frames ahead of the eyes closing. The window still runs its full
     length, so the only thing that gives it away is that it does not line up
     with the sleep any more -- which is the whole retune. */
  const run = await simonVsReese({ engine: sabotage(
    "        if (this.attackFrame === s.startup) {\n" +
    "          if (s.manaFree) this.manaFree = s.manaFree;\n",
    "        if (this.attackFrame === 1) {\n" +
    "          if (s.manaFree) this.manaFree = s.manaFree;\n") });
  const S = SPEC(run);
  const log = slouch(run, 30, "", SLEEP_FRAMES);
  expectToFail(() => checkSleep(log, S),
    "with the window opening on the commit frame the sleep test should fail; it passed");
});

test("negative control: a window longer than the sleep fails the sleep test", async () => {
  /* The old shape, in miniature: a bar that is still running after he is up
     and awake. It costs nothing in the fiction and it is invisible on the
     HUD, which is exactly why the two lengths are pinned to each other
     rather than to a number. */
  const run = await simonVsReese({ engine: sabotage(
    "    manaFree: 600,\n    aura: { radius: 40, doze: 90 },\n",
    "    manaFree: 900,\n    aura: { radius: 40, doze: 90 },\n") });
  const S = SPEC(run);
  const log = slouch(run, 30, "", SLEEP_FRAMES);
  expectToFail(() => checkSleep(log, S),
    "with the free window outliving the sleep the sleep test should fail; it passed");
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

/* =====================================================================
   THE JACKPOT: WHAT THREE SEVENS ACTUALLY PAY

   Appended here rather than beside the payout table above, and it is not a
   matter of taste: every test in this file draws from one seeded Math stream,
   so a boot inserted in the middle changes what both CPUs do in every test
   after it. New tests go on the end.

   The payout table above pins that the sevens pay no damage, no mana, no
   health and no meter. This is the other half -- the thing they DO pay, and
   the three ways it is unlike every other buff in the game: it ramps rather
   than snapping on, it never counts down, and while it is up the machine that
   handed it to him will not take another coin.
   ===================================================================== */

// payout() reads the reels off him and nothing else, so forcing them and
// calling it is the whole spin without ninety frames of waiting for it.
const JACKPOT = "me.reels = [0, 0, 0]; me.payout(DOWN);";

const GIANT = {
  p0: "0",
  /* `bling` is asked of the DRAW rather than of a flag still sitting on
     buffStats: whether the chain and the sunglasses come off with him is a
     question about what is painted. The context measures AREA rather than
     counting calls, because blingArt emits one rect per lit pixel of the art
     whatever size it is drawn at -- a count would be the same number for a
     man and for a giant, and could not see a chain that failed to shrink. */
  rec: "{ bt: me.buffTimer, dm: me.damageMul, sm: me.sizeMul," +
       " hurt: me.hurtbox().w," +
       " bling: (function () { var n = 0;" +
       "   var g = { fillRect: function (x, y, w, h) { n += w * h; }," +
       "             fillStyle: 0, globalAlpha: 1 };" +
       "   drawBling(g, me); return Math.round(n); })()," +
       " pull: me.canSpecial(bitsToPad(1024)) }",
};

function checkGiant(log, S) {
  const j = S.d.jackpot;
  assert.equal(j.damageMul + "x" + j.sizeMul, "2x3",
    "DOUBLE damage and TRIPLE size. Three was asked for on both and two is what was kept on " +
    "the damage after seeing it played: triple damage on every attack he owns, for the rest of " +
    "a stock, off a pull he can learn the timing of, is the strongest thing in the game by a " +
    "distance. The size is still three, and it costs him -- retune on purpose. It read " +
    j.damageMul + "x" + j.sizeMul);

  /* IT IS A CLOCK. It used to be "until he loses a stock" -- buffTimer pinned
     at 1 with a `hold` flag that stopped update() ever decrementing it -- and
     it is fifteen seconds now, or a lost stock, whichever comes first. The
     death clear is untouched and is pinned in its own test; this is the
     fifteen seconds.

     Read before the size below, because a timer that ran out is a buff that
     is already GONE, and a check that meets that as a sizeMul of 1 reports it
     as a growth that never started. */
  assert.equal(j.duration, 900,
    "fifteen seconds -- retune on purpose; the spec says " + j.duration);
  assert.equal(log[0].bt, j.duration - 1,
    "payout() puts the whole " + j.duration + " on the clock, and the frame it lands " +
    "has already spent one of them; buffTimer read " + log[0].bt);
  for (let f = 1; f < log.length; f++) {
    assert.equal(log[f].bt, log[f - 1].bt - 1,
      "and it ticks down one a frame like every other buff in the game; it went " +
      log[f - 1].bt + " -> " + log[f].bt + " on frame " + f);
  }
  assert.ok(log.every((r) => r.dm === j.damageMul),
    "the damage multiplier is live on every one of those frames; it first read " +
    (log.find((r) => r.dm !== j.damageMul) || {}).dm);
  assert.ok(log.length < j.duration,
    "precondition: this recording has to END inside the buff, or the size checks " +
    "below are reading a man who has already reverted; it was " + log.length +
    " frames against a duration of " + j.duration);

  /* IT RAMPS. The size is read through one getter off the frame the buff
     landed, so the drawing, the hurtbox and his own hitboxes cannot disagree
     about how big he is -- and the point of the ramp is that a man GROWING
     is a thing you can watch, where a sprite swapped for a bigger one is a
     thing you find out about by being hit. */
  assert.ok(log[0].sm > 1,
    "he is already growing on the first frame after the payout; sizeMul read " + log[0].sm);
  assert.ok(log[0].sm < j.sizeMul,
    "and is NOT there yet -- a size that arrives whole on the first frame is the sprite swap " +
    "this ramp exists instead of; sizeMul read " + log[0].sm);
  const grown = log.findIndex((r) => r.sm === j.sizeMul);
  assert.equal(grown, 9,
    "he is full size on the tenth frame after the payout -- a sixth of a second, long enough " +
    "to read as growing and short enough that nobody fights a size he was never meant to be; " +
    "he got there on frame " + grown);
  for (let f = 1; f <= grown; f++) {
    assert.ok(log[f].sm > log[f - 1].sm,
      "climbing on every frame of it; frame " + f + " read " + log[f].sm +
      " against " + log[f - 1].sm + " the frame before");
  }
  for (let f = grown; f < log.length; f++) {
    assert.equal(log[f].sm, j.sizeMul,
      "and he stays there: on frame " + f + " sizeMul read " + log[f].sm);
  }
}

test("JACKPOT: he grows into it over ten frames, and it is on a fifteen-second clock", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkGiant(drive(run, JACKPOT, 300, GIANT), S);
});

test("negative control: a jackpot buff that never counts down fails the giant test", async () => {
  /* The old shape: buffTimer pinned where payout put it, so the giant is
     permanent and the fifteen seconds are a number in the roster that nothing
     reads. This is what the release removed, and a control that did not pin
     it would let a `hold` quietly come back. */
  const run = await simonVsReese({ engine: sabotage(
    "    if (this.buffTimer > 0) {\n      this.buffTimer--;",
    "    if (this.buffTimer > 0) {\n      this.buffTimer -= 0;") });
  const S = SPEC(run);
  const log = drive(run, JACKPOT, 300, GIANT);
  expectToFail(() => checkGiant(log, S),
    "with the timer pinned the giant test should fail; it passed");
});

/* What the end of it looks like, which is the half a duration alone does not
   buy. He deflates over the same ten frames he swelled over, the chain and
   the sunglasses come off with him, the doubled damage stops, and the lever
   he was locked out of comes back. */
function checkGiantEnds(log, S) {
  const j = S.d.jackpot;
  const out = log.findIndex((r) => r.bt <= 0);
  assert.ok(out > 0, "the buff has to actually run out inside the recording; it did not");
  assert.equal(out, j.duration - 1,
    "and it runs out " + j.duration + " frames after the reel landed; it went on frame " + out);

  assert.equal(log[out - 12].sm, j.sizeMul,
    "still full size twelve frames from the end; sizeMul read " + log[out - 12].sm);
  for (let k = 9; k >= 1; k--) {
    assert.ok(log[out - k].sm < log[out - k - 1].sm,
      "then shrinking on every one of the last ten frames: " + k + " from the end read " +
      log[out - k].sm + " against " + log[out - k - 1].sm);
  }
  assert.equal(log[out].sm, 1, "and he is a man again; sizeMul read " + log[out].sm);
  assert.equal(log[out].hurt, log[log.length - 1].hurt,
    "the HURTBOX comes back with him and stays back -- the size is one getter, so a " +
    "drawing that shrank while the target did not would be impossible by construction, " +
    "which is the reason it is one getter");
  assert.equal(log[out].dm, 1,
    "the doubled damage stops with it; damageMul read " + log[out].dm);
  assert.ok(log[out - 2].bling > 0,
    "precondition: the chain and the shades were being drawn before the end");
  assert.equal(log[out].bling, 0,
    "and nothing of them is drawn after it; " + log[out].bling + " pixels went down");
  assert.equal(log[0].pull, false,
    "precondition: no gambling while he IS the jackpot");
  assert.equal(log[out].pull, true,
    "and the lever comes back the moment he is not");
}

test("JACKPOT: fifteen seconds later he deflates, and the chain comes off with him", async () => {
  const run = await simonVsReese();
  const S = SPEC(run);
  checkGiantEnds(drive(run, JACKPOT, S.d.jackpot.duration + 40, GIANT), S);
});

test("negative control: a size that snaps back instead of deflating fails the ending test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "    const down = this.buffTimer >= JACKPOT_GROW ? 1 : this.buffTimer / JACKPOT_GROW;",
    "    const down = 1;") });
  const S = SPEC(run);
  const log = drive(run, JACKPOT, S.d.jackpot.duration + 40, GIANT);
  expectToFail(() => checkGiantEnds(log, S),
    "with no shrink ramp the ending test should fail; it passed");
});

test("negative control: bling hung off the buff's size instead of his own fails the ending test", async () => {
  /* The chain is drawn at `f.sizeMul` and not at `buffStats.sizeMul`, which
     were the same number for as long as the jackpot could only end by dying.
     Now that it runs out, the last ten frames are a man shrinking, and a
     chain built from the buff's own number hangs at full giant scale around
     him until it vanishes. */
  const run = await simonVsReese({ engine: sabotage(
    "  const k = f.sizeMul;", "  const k = b.sizeMul || 1;") });
  const S = SPEC(run);
  const log = drive(run, JACKPOT, S.d.jackpot.duration + 40, GIANT);
  const shrinking = log.findIndex((r) => r.bt > 0 && r.bt < 10);
  assert.ok(shrinking > 0, "precondition: the recording reaches the shrink");
  expectToFail(() => assert.ok(log[shrinking].bling < log[shrinking - 12].bling,
    "a chain hung off the buff's own number covers the same area at every size"),
    "the bling has to be measured against the size he actually is");
});

test("negative control: a size that snaps on instead of growing fails the giant test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "const JACKPOT_GROW = 10;", "const JACKPOT_GROW = 1;") });
  const S = SPEC(run);
  const log = drive(run, JACKPOT, 300, GIANT);
  expectToFail(() => checkGiant(log, S),
    "with the growth over in one frame the giant test should fail; it passed");
});

/* Fourteen pixels ahead is inside an ordinary jab, so the transformed one is
   not being asked to reach any further than the plain one had to -- what is
   being compared is the number on the hit, not whether it landed. The press
   is on frame 30, well clear of anything the payout does. */
const JAB = {
  p0: `i === 30 ? ${ATTACK} : 0`,
  rec: "{ fhp: foe.health, dm: me.damageMul }",
};
const jabbed = (run, setup) => drive(run, setup + " foe.x = me.x + 14;", 46, JAB);

function checkDoubled(plain, giant, S) {
  const plainLost = 100 - Math.min(...plain.map((r) => r.fhp));
  const giantLost = 100 - Math.min(...giant.map((r) => r.fhp));
  assert.equal(plain[0].dm, 1, "precondition: an untransformed Simon multiplies nothing");
  assert.ok(plainLost > 0,
    "precondition: the ordinary jab has to have LANDED, or there is nothing here to double " +
    "and the comparison below is two zeroes agreeing with each other");
  assert.equal(plainLost, S.jab.damage,
    "precondition: and it takes the roster's jab damage of " + S.jab.damage + "; he lost " +
    plainLost);
  assert.ok(giantLost > 0,
    "precondition: the giant's jab has to land too -- he is three times the size, so a whiff " +
    "here is a broken scenario rather than a balance finding; he lost " + giantLost);
  assert.equal(S.d.jackpot.damageMul, 2, "double, not triple -- retune on purpose");
  assert.equal(giantLost, plainLost * 2,
    "and a jackpot Simon's jab takes twice what the same jab took a moment ago: " + plainLost +
    " becomes " + (plainLost * 2) + "; he lost " + giantLost);
  assert.equal(giant[0].dm, 2,
    "off the multiplier every hit in the game already goes through, live from the frame the " +
    "payout landed; damageMul read " + giant[0].dm);
}

test("JACKPOT: every attack he owns takes double -- the same jab, on the same man, twice the number", async () => {
  /* Measured rather than read off the spec. damageMul is a getter that
     applyHit consults at the moment of the hit, and the thing worth pinning
     is that a hit actually goes through it -- a buff that is set correctly
     and read nowhere is the failure this catches. */
  const run = await simonVsReese();
  const S = SPEC(run);
  checkDoubled(jabbed(run, ""), jabbed(run, JACKPOT), S);
});

test("negative control: a damage multiplier nobody reads fails the double-damage test", async () => {
  /* The spec still says 2 -- so this is not a number the checker can be
     talked out of by reading it back. The getter every hit goes through is
     what is broken, and the only thing that notices is the health bar. */
  /* Re-anchored: the getter grew a fade for Kel's LEG DAY and is no longer
     one line. This is still the same sabotage -- the multiplier computed and
     then not returned -- on the branch every FLAT buff takes, which the
     jackpot is. */
  const run = await simonVsReese({ engine: sabotage(
    "    if (!b.decay) return b.damageMul;",
    "    if (!b.decay) return 1;") });
  const S = SPEC(run);
  const plain = jabbed(run, ""), giant = jabbed(run, JACKPOT);
  expectToFail(() => checkDoubled(plain, giant, S),
    "with the multiplier read nowhere the double-damage test should fail; it passed");
});

/* Stale reels are left on him so a pull that WAS heard has something visible
   to do: the lever wipes them to -1,-1,-1 on its startup frame. */
const RE_PULL = {
  p0: `i === 10 ? ${SP_DOWN} : 0`,
  rec: "{ st: me.state, can: me.canSpecial(bitsToPad(" + SP_DOWN + "))," +
       " r: me.reels.join(','), bt: me.buffTimer }",
};

function checkNoRePull(plain, giant) {
  assert.ok(plain.every((r) => r.bt === 0), "precondition: the control Simon is not transformed");
  assert.equal(plain[10].st, "special",
    "precondition: the SAME press on an untransformed Simon does pull the lever, so a refusal " +
    "below is the buff and not a pad bit I got wrong; he was " + plain[10].st);
  assert.ok(giant.every((r) => r.bt > 0),
    "precondition: the other one is a giant for the whole recording");
  assert.equal(giant[10].can, false,
    "canSpecial refuses SLOTS outright while the jackpot is up; it read " + giant[10].can);
  for (let f = 10; f < giant.length; f++) {
    assert.equal(giant[f].st, "idle",
      "and the press does nothing at all -- he never enters the move; on frame " + f +
      " he was " + giant[f].st);
  }
  assert.ok(giant.every((r) => r.r === "2,2,2"),
    "and the stale reels are never even wiped, which is the first thing a pull that was heard " +
    "would do; they read " + giant[giant.length - 1].r);
}

test("JACKPOT: no gambling while he IS the jackpot -- the lever will not take another coin", async () => {
  /* Every outcome of pulling again was wrong: three more sevens re-armed the
     growth and snapped a settled giant back to a man for ten frames, and
     every other symbol paid him a second prize on top of the one he is
     already wearing. */
  const run = await simonVsReese();
  const plain = drive(run, "me.reels = [2, 2, 2];", 40, RE_PULL);
  const giant = drive(run, JACKPOT + " me.reels = [2, 2, 2];", 40, RE_PULL);
  checkNoRePull(plain, giant);
});

test("negative control: a lever that can be pulled mid-jackpot fails the no-re-pull test", async () => {
  const run = await simonVsReese({ engine: sabotage(
    "    if (s.kind === 'slots' && this.buffTimer > 0 &&\n" +
    "        this.buffStats && this.buffStats.sizeMul > 1) return false;",
    "    if (false) return false;") });
  const plain = drive(run, "me.reels = [2, 2, 2];", 40, RE_PULL);
  const giant = drive(run, JACKPOT + " me.reels = [2, 2, 2];", 40, RE_PULL);
  expectToFail(() => checkNoRePull(plain, giant),
    "with the refusal gone the giant pulls the lever again and the test should fail; it passed");
});

/* =====================================================================
   THE REST OF THE CONTROLS FOR THE TESTS ABOVE

   Same reason they are down here: each one is a boot, and a boot in the
   middle of the file moves the seeded Math stream for everything after it.
   ===================================================================== */

test("negative control: a sausage that comes out at full speed fails the split test", async () => {
  /* The split before the slide existed: the dog simply IS the faster thing
     from the frame it comes free, which is the instant swap nobody could read. */
  const run = await simonVsReese({ engine: sabotage(
    "this.vx *= top.kick;", "this.vx = this.launchVx;") });
  const S = SPEC(run);
  const log = drive(run, SPLIT_SETUP, 90, HOTDOG_SPLIT);
  expectToFail(() => checkSplit(log, S),
    "with the sausage starting at its launch speed the split test should fail; it passed");
});

test("negative control: a bun that expires before it can land fails the split test", async () => {
  /* Everything about the glide left alone -- the pop, the shed, the rock,
     the speed it settles to -- and only the bun's life cut, so the one thing
     that can notice is the assertion about how long it stays up. Which is
     the point of that assertion: a bun is only a second lane for as long as
     it is somebody's problem, and it does not matter whether it stops being
     one by falling fast or by vanishing. */
  const run = await simonVsReese({ engine: sabotage(
    "                life: 150 },", "                life: 28 },") });
  const S = SPEC(run);
  const log = drive(run, SPLIT_SETUP, 90, HOTDOG_SPLIT);
  expectToFail(() => checkSplit(log, S),
    "with the bun gone before it lands the split test should fail; it passed");
});

test("negative control: a bun shed forward fails the split test", async () => {
  /* The bun is thrown BACK by the same launch that throws the sausage
     forward -- that is the equal and opposite half of the picture, and a bun
     that leaves the split in front of the dog is two things going one way. */
  const run = await simonVsReese({ engine: sabotage(
    "-this.launchVx * parts.bottom.shed));", "this.launchVx * parts.bottom.shed));") });
  const S = SPEC(run);
  const log = drive(run, SPLIT_SETUP, 90, HOTDOG_SPLIT);
  expectToFail(() => checkSplit(log, S),
    "with the bun shed forward the split test should fail; it passed");
});

test("negative control: a jackpot that also pays the blast fails the payout test", async () => {
  /* The loop that the jackpot branch is skipped for. Running it at k = 1
     gives three sevens the ring as well as the transformation, which is the
     two-prizes-in-one-hat this reel was rewritten to stop. */
  const run = await simonVsReese({ engine: sabotage(
    "for (const other of (n === 3 ? [] : fighters)) {", "for (const other of fighters) {") });
  const S = SPEC(run);
  const p = JSON.parse(run(PAYOUTS));
  expectToFail(() => checkPayouts(p, S),
    "with the jackpot hitting as well as transforming the payout test should fail; it passed");
});

test("negative control: three spades that merely add fails the payout test", async () => {
  /* The house filling the bar OUTRIGHT is the whole difference between "you
     may use your ult now" and a number you have to go and read. Turned back
     into an addition, three spades from 10 leaves him on 60 and still short. */
  const run = await simonVsReese({ engine: sabotage(
    "this.ultMeter = n === 3 ? COMBAT.ultMax",
    "this.ultMeter = n === 3 ? Math.min(COMBAT.ultMax, this.ultMeter + s.house.ult)") });
  const S = SPEC(run);
  const p = JSON.parse(run(PAYOUTS));
  expectToFail(() => checkPayouts(p, S),
    "with three spades merely adding 50 the payout test should fail; it passed");
});

test("negative control: a blade labeled 340 that throws like 300 fails the choke test", async () => {
  /* The angle in the spec is left at 340 on purpose, so the pin that reads it
     back still passes and the only thing that can catch this is the ratio of
     the two velocities the throw actually produced. kx/ky are the baked
     cosine and sine, and these are the pair the finish used to carry: sixty
     degrees below the horizontal, most of the force going into a floor that
     was already there. */
  const run = await simonVsReese({ engine: sabotage(
    "                kx: 0.9396926207859084, ky: -0.3420201433256686 },",
    "                kx: 0.50000000000000011, ky: -0.8660254037844386 },") });
  const S = SPEC(run);
  const log = drive(run, "foe.x = me.x + 14;", 120, CHOKE);
  expectToFail(() => checkChoke(log, S),
    "with the blade throwing at the old 300 the choke test should fail; it passed");
});
