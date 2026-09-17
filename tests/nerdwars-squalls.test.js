/* Squalls, as 2.65 left him: three of his four moves replaced in one go.
 *
 * He spent the placeholder years as an uppercut wearing four labels, then
 * 2.60 gave him a yawn, a nap, a borrowed fishing pole and the dragon. Three
 * of those four are gone again. What is there now is:
 *
 *   STAR OF DAVID on the neutral, which is one slow six-pointed star until
 *   you press the button a second time, at which point it comes APART along
 *   its own seam into two triangles that climb and dive.
 *
 *   BANANA on the down as of 2.83, which took over the old nap's job of
 *   filling the DREAM the dragon is made of and does it by being CAUGHT
 *   rather than by being stood still for. It lives in its own file,
 *   nerdwars-squalls-banana.test.js, because it is an item rather than a
 *   move and almost nothing about it is a frame count.
 *
 *   THE WHIP on the up, where the pole used to be. Forty pixels of box whose
 *   last eight are worth double.
 *
 *   SALAMENCE still on the ult, still an instant kill, but it WANDERS now
 *   rather than flying a straight line across the stage.
 *
 * Each of those is a different kind of quiet failure, and they are why this
 * file drives every move through the real input path rather than reading the
 * spec back at itself:
 *
 *   The dragon is a 999 in a damage field. Nothing in the engine treats it
 *   as special -- there is no instant-kill flag -- so the whole rule lives in
 *   one number, and a number is the easiest thing in this file to tune by
 *   accident into a merely enormous hit. Its wandering is the same shape of
 *   problem from the other end: a hash that stops mixing still returns a
 *   number, and a dragon flying a ruler-straight line looks exactly like a
 *   dragon until you stand still and never get hit.
 *
 *   The star's split is a COMMAND to a thing already in the air rather than
 *   a cast, and the two are one button. A guard that stops working does not
 *   break the split -- it quietly makes the same press pay for a second star
 *   as well, which reads as a mana leak nobody can trace back to the move.
 *
 *   The whip's tip is a sweet spot, and a sweet spot that is always on is a
 *   move that hits for twenty everywhere. That regression is invisible in a
 *   match -- it still swings, it still connects -- so BOTH sides of the
 *   boundary are pinned here, not just the good one.
 *
 *   The down slot is measured next door. What is left in here about it is
 *   the one line that belongs with the other three: which `kind` and which
 *   label sit in that slot, because a replaced move leaves a `kind` nobody
 *   dispatches on and that is the wreckage worth grepping for.
 *
 * HE NO LONGER HAS A FISHING POLE. The tests that used to live here compared
 * his copy of Trev's rod against Trev's, field for field, because it had been
 * borrowed whole and a borrowed move is exactly the kind of thing a later
 * tidy-up retunes on one man and not the other. There is nothing left to
 * compare: Trev keeps the pole and Trev's own tests keep it honest -- reach,
 * throw, the travelling lure, and the cast that must not lift him, which is
 * now guarded next to the rest of them in nerdwars-platforms.test.js.
 *
 * Everything here drives the moves through the real input path and reads what
 * actually happened. Every test has a NEGATIVE CONTROL beside it: the same
 * checker run against a copy of the engine with ONE line changed in memory,
 * and the check is that the same assertions then fail. The mutated copies
 * live in a string and a fresh vm and are never written anywhere.
 *
 * These load the engine source, as nerdwars-255.test.js does, because none of
 * it is reachable through NerdWars.fighters: ROSTER, `projectiles` and the
 * fighter's own `dream` counter are all internals.
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
    __on: {},
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

/* Takes the engine SOURCE rather than always reading it off disk, so a
   negative control can boot a mutated copy in a fresh vm without that copy
   ever touching the filesystem. */
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

/* One line of the engine, changed in memory. Never written to disk, and
   never applied to the copy the real tests run against.

   Both halves are asserted. A needle that is not there, or is there twice,
   makes a control that silently mutates nothing or mutates the wrong thing --
   which is exactly the failure a negative control exists to rule out. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* The other half of a negative control: the SAME checker the real test ran,
   and it has to throw an assertion. Anything else thrown is a broken checker
   rather than a failed test, and is let through so it shows up as itself. */
function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

/* Two fighters on a stage, past the 110 frames of spawn invulnerability.
   `a` and `b` are positions in ORDER. Both seats are CPUs, which costs
   nothing: every measurement below hands both of them pads of its own, and a
   pad from netplay is what the fighter reads. */
async function arena(a, b, opts) {
  const o = opts || {};
  const run = await bootEngine(o.engine);
  run(`select.cursor=[${a},${b}]; twoPlayer=true; playerCount=2; humanCount=0;` +
      ` stagePick=${o.stage || 0}; startBattle();`);
  run("for (var i=0;i<130;i++) step();");
  return run;
}

/* The world put somewhere known, at the top of every measurement. Written as
   a string rather than as a helper because it runs INSIDE the vm, where the
   test has no functions of its own.

   `freezeFrames` is cleared deliberately rather than out of habit: several
   moves in this game set it, nothing else clears it, and a second
   measurement in the same vm that begins inside somebody else's freeze
   spends its one press on a frame where nothing is listening and then
   silently measures nothing at all. */
const SETUP = `
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0;
  freezeFrames = 0;
  me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
  me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.vy = 0;
  me.grabbing = -1; me.grabbedBy = -1; me.grounded = true; me.facing = 1;
  me.ultMeter = 999; me.x = main.x + 24; me.y = main.y; me.specialSpawned = false;
  me.dream = 0; me.health = 100;
  foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
  foe.stocks = 3; foe.eliminated = false; foe.health = 100; foe.hasHit = true;
  foe.grounded = true; foe.vx = 0; foe.vy = 0; foe.y = main.y;
  foe.burn = 0; foe.poison = 0; foe.confused = 0; foe.drowsy = 0;
  foe.grabbing = -1; foe.grabbedBy = -1; foe.mana = 100;
  foe.x = main.x + main.w / 2;`;

// The pad bits, as netplay packs them.
const ULT = 256;
const SP_NEUTRAL = 512, SP_DOWN = 1024, SP_UP = 2048;

// Where each fighter sits in ORDER. Positions, not names, because that is
// what select.cursor takes.
const REESE = 4, SQUALLS = 8;

/* =====================================================================
   SALAMENCE -- one pass, and whoever it reaches is gone
   ===================================================================== */

/* Press the ult and stand a man in the dragon's LANE, on the floor, without
   moving him. It comes in from off the edge behind Squalls and crosses the
   whole stage at a walking pace, so the measurement is long: two hundred
   frames is the dragon's own flight plus room for the KO to play out.

   Standing still on the floor is the right place for him to be even though
   the dragon weaves now, and deliberately so. `wander` is a BAND around the
   height it launched at rather than a free walk, and eleven pixels is the
   width it is because a fighter's hurtbox is fourteen tall and the dragon's
   fifteen -- it is tuned to weave visibly and still land on somebody who
   never moved. If a later re-tune widens that band until it sails over a
   stationary man, this is the test that should say so, and it says so in the
   first assertion rather than by quietly measuring nothing.

   Only pinned while he is untouched. Once he has been hit the whole sim
   freezes for about a dozen frames and then he is somewhere else entirely,
   and a test that kept dragging him back would be fighting the KO it is
   trying to watch. */
const dragonPass = (run, dream) => run(`(function () {
  ${SETUP}
  me.dream = ${dream};
  var stocks0 = foe.stocks, hp0 = foe.health;
  var hitAt = -1, koAt = -1, seen = -1, vx = 0, dmg = 0, hpAtHit = 0;
  netplay.active = true;
  for (var i = 0; i < 200; i++) {
    me.hitstop = 0; me.mana = 999;
    if (hitAt < 0) {
      foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0;
      foe.x = main.x + main.w / 2; foe.y = main.y;
      foe.vx = 0; foe.vy = 0; foe.grounded = true;
    }
    netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
    step();
    var out = projectiles.filter(function (q) {
      return q.constructor.name === 'Salamence';
    })[0];
    // Read off the dragon itself the first frame it exists, because what the
    // dream bought is baked in at construction and never consulted again.
    if (out && seen < 0) {
      seen = i; vx = +out.vx.toFixed(6); dmg = out.spec.damage;
    }
    if (hitAt < 0 && foe.health < hp0) { hitAt = i; hpAtHit = +foe.health.toFixed(3); }
    if (koAt < 0 && foe.state === 'ko') koAt = i;
  }
  netplay.active = false; netplay.framePads = null;
  return { seen: seen, vx: vx, dmg: dmg, hitAt: hitAt, koAt: koAt,
           hpAtHit: hpAtHit, stocks0: stocks0,
           stocks: foe.stocks, dreamAfter: me.dream };
})()`);

function checkInstantKill(run, r) {
  const u = JSON.parse(run("JSON.stringify(ROSTER.squalls.ult)"));
  assert.equal(u.label, "SALAMENCE", "precondition: his ult is the dragon");
  assert.ok(r.seen >= 0, "the dragon should have been dreamed up at all");
  assert.ok(r.hitAt >= 0,
    "and reach the man standing still in its lane -- the weave is a band " +
    "narrow enough to land on somebody who never moved, and a dragon that " +
    "misses him is not a harder dragon, it is a broken one; nothing ever " +
    "touched him");
  /* The rule, stated the only way the engine states it. There is no
     instant-kill flag anywhere in the file -- what makes this an execution is
     a damage number larger than any bar in the game, and the only honest test
     of that is a healthy fighter losing a stock to one pass. */
  assert.ok(u.damage > 100,
    "the whole move is one number: `damage` has to be past anything a full " +
    "health bar can absorb, and it is " + u.damage);
  assert.equal(r.hpAtHit, 0,
    "a foe at full health should be taken to nothing by a single touch of " +
    "it; he was left on " + r.hpAtHit);
  assert.ok(r.koAt >= 0,
    "and be knocked out by it; he never reached the ko state");
  assert.equal(r.stocks0 - r.stocks, 1,
    "which costs him exactly one stock; he went " + r.stocks0 + " -> " +
    r.stocks);
}

test("the dragon is an execution: one pass, one stock, whatever his health", async () => {
  const run = await arena(SQUALLS, REESE);
  checkInstantKill(run, dragonPass(run, 0));
});

test("negative control: a dragon that merely hurts fails the execution test", async () => {
  /* Nine damage rather than 999, and nothing else about the move touched. It
     still flies, it still wanders, it still connects -- and the man it
     reaches walks away, which is the entire difference. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    damage: 999, base: 5.0, scale: 10.0, angle: 46,",
    "    damage: 9, base: 5.0, scale: 10.0, angle: 46,") });
  const r = dragonPass(run, 0);
  expectToFail(() => checkInstantKill(run, r),
    "with the dragon down to nine damage the execution test should fail; it passed");
});

function checkDreamBuysSpeed(run, cold, full) {
  const u = JSON.parse(run("JSON.stringify(ROSTER.squalls.ult)"));
  assert.ok(cold.seen >= 0 && full.seen >= 0,
    "precondition: both dragons should have been dreamed up");
  assert.equal(cold.dreamAfter, 0,
    "precondition: casting spends the meter; it is still on " + cold.dreamAfter);
  assert.equal(full.dreamAfter, 0, "precondition: and spends a full one too");

  /* Speed, and exactly the speed the spec offers. `dreamSpeed` is the whole
     of what a full meter is worth now: an empty one strolls out at `speed`
     and a full one arrives at `speed` plus this, which is the difference
     between walking out of the way and having to commit to a jump. */
  assert.ok(u.dreamSpeed > 0,
    "precondition: the dream has to buy something (" + u.dreamSpeed + ")");
  assert.ok(Math.abs(Math.abs(cold.vx) - u.speed) < 1e-9,
    "an undreamed dragon flies at the spec's `speed` (" + u.speed +
    "); it flew at " + cold.vx);
  assert.ok(Math.abs(Math.abs(full.vx) - Math.abs(cold.vx) - u.dreamSpeed) < 1e-9,
    "and a full meter buys exactly `dreamSpeed` (" + u.dreamSpeed +
    ") on top of it; nought gave " + cold.vx + " and a hundred gave " +
    full.vx);

  /* And NOTHING else. The damage is the point: it cannot go up, because it
     is already past any health bar, so a meter wired to it would be a meter
     wired to nothing -- which is fine until somebody reads the spec and
     concludes that dreaming makes the dragon hit harder.

     Measured off the two dragons first and only then read out of the table,
     in that order deliberately: the spec is what a control is most likely to
     move along with the behavior, and an assertion that fires on what was
     actually built cannot be talked round. */
  assert.equal(full.dmg, cold.dmg,
    "the dragon a full meter dreams up should hit for the same as the one " +
    "a cold start does: " + cold.dmg + " against " + full.dmg);
  assert.equal(cold.dmg, u.damage,
    "and both of them for what the spec says (" + u.damage + ")");
  assert.equal(u.dreamDamage, 0,
    "the meter must not buy damage -- there is nowhere above an instant kill " +
    "for it to go; `dreamDamage` is " + u.dreamDamage);
}

test("the dream buys the dragon's speed and nothing else", async () => {
  const run = await arena(SQUALLS, REESE);
  const max = run("ROSTER.squalls.ult.dreamMax");
  checkDreamBuysSpeed(run, dragonPass(run, 0), dragonPass(run, max));
});

test("negative control: a dream spent on damage as well fails the speed test", async () => {
  /* The speed is left exactly as it is and the meter is wired to damage
     BESIDE it, which is the version worth ruling out: a dragon that gets both
     still gets visibly faster, so everything the eye can check still looks
     right and only the number it carries has changed. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    dreamMax: 100, dreamDamage: 0, dreamSpeed: 3.0, dreamLife: 0,",
    "    dreamMax: 100, dreamDamage: 50, dreamSpeed: 3.0, dreamLife: 0,") });
  const max = run("ROSTER.squalls.ult.dreamMax");
  expectToFail(() => checkDreamBuysSpeed(run, dragonPass(run, 0), dragonPass(run, max)),
    "with the meter buying damage too the speed test should fail; it passed");
});

test("negative control: a dragon that never reads the dream fails the speed test", async () => {
  /* The other way round, and taken out of the dragon rather than the table:
     the spec still promises 1.5 and the constructor simply stops asking for
     it. Both dragons then leave at 2.1, the meter buys nothing at all, and
     the measurement is the only place that shows -- the ROSTER still reads
     exactly as it does today. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    this.vx = this.dir * (spec.speed + (spec.dreamSpeed || 0) * this.power);",
    "    this.vx = this.dir * spec.speed;") });
  const max = run("ROSTER.squalls.ult.dreamMax");
  expectToFail(() => checkDreamBuysSpeed(run, dragonPass(run, 0), dragonPass(run, max)),
    "with the dream never reaching the dragon the speed test should fail; it passed");
});

/* =====================================================================
   AND IT DOES NOT FLY IN A STRAIGHT LINE
   ===================================================================== */

/* The whole crossing, with nobody in the way, sampled every frame it is on
   screen. Nobody is in the way on purpose: this measures the PATH, and a
   dragon that kills the man it hits also freezes the sim for a dozen frames
   in the middle of the sample.

   The last x and the life left over are both recorded, because there are two
   ways for a dragon to stop existing and they mean opposite things. Running
   off the far edge is the move working. Expiring over the stage is what
   `life: 280` was raised to stop: a dragon that dies mid-screen is one you
   beat by standing behind it and waiting. */
const dragonFlight = (run) => run(`(function () {
  ${SETUP}
  // Parked at the far end and untouchable, so nothing it does to him can
  // freeze the frames this is counting.
  foe.invuln = 9999; foe.x = main.x + main.w - 8; foe.stocks = 99;
  var ys = [], lastX = 0, lifeLeft = -1, firstX = 0;
  netplay.active = true;
  for (var i = 0; i < 280; i++) {
    me.hitstop = 0; me.mana = 999; me.ultMeter = 999;
    foe.invuln = 9999;
    netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
    step();
    /* Remembered every frame rather than read at the end: a dragon that has
       left is pruned inside step(), so the last frame it was alive is only
       reachable as the last one this ever saw. */
    var d = projectiles.filter(function (q) {
      return q.constructor.name === 'Salamence';
    })[0];
    if (d) {
      if (!ys.length) firstX = +d.x.toFixed(2);
      ys.push(+d.y.toFixed(3));
      lastX = +d.x.toFixed(2); lifeLeft = d.life;
    }
  }
  netplay.active = false; netplay.framePads = null;
  return { ys: ys.join(','), n: ys.length, firstX: firstX, lastX: lastX,
           lifeLeft: lifeLeft, VW: VW, VH: VH };
})()`);

function checkWander(run, r) {
  const u = JSON.parse(run("JSON.stringify(ROSTER.squalls.ult)"));
  assert.ok(u.wander > 0,
    "precondition: `wander` is how far off its launch height it may get (" +
    u.wander + ")");
  assert.ok(u.veer > 0,
    "precondition: `veer` is how often it picks a new one (" + u.veer + ")");
  assert.ok(r.n > 60,
    "the dragon should be on screen long enough to have a path at all; it " +
    "was there for " + r.n + " frames");

  const ys = r.ys.split(",").map(Number);
  const spread = Math.max(...ys) - Math.min(...ys);
  /* The assertion a straight line fails, and the floor under it is set by
     what `wander` promises rather than by a number somebody liked: the band
     is eleven either side of the launch height, so a working weave covers a
     good part of twenty-two and a dragon that does not weave covers about
     one. Measured: a little over fourteen. Well clear of both. */
  assert.ok(spread > 8,
    "its path has to actually vary: across " + r.n + " frames it should " +
    "wander a good part of the band `wander` gives it (" + u.wander +
    " either side), and it covered " + spread.toFixed(2) + "px");
  assert.ok(spread <= u.wander * 2 + 2,
    "and stay INSIDE that band, because the band is what keeps it a threat " +
    "rather than a coin flip; it covered " + spread.toFixed(2) + "px of a " +
    "permitted " + (u.wander * 2) + "px");

  /* And vary more than once. A single constant drift also produces a spread
     -- it is a diagonal, and a diagonal is a lane like any other -- so what
     is counted here is how many DIFFERENT vertical speeds it flew at. `veer`
     promises a fresh height to make for every seventeen frames, and easing
     onto each of them at a different moment is what makes the line ragged
     rather than sawtoothed. */
  const drifts = new Set();
  for (let i = 1; i < ys.length; i++) {
    drifts.add((ys[i] - ys[i - 1]).toFixed(2));
  }
  assert.ok(drifts.size >= 3,
    "and it should change its mind on the way across rather than flying one " +
    "slope; it used " + drifts.size + " different vertical speeds");

  // Never off the top or the bottom of the stage it is crossing.
  assert.ok(Math.min(...ys) > 0 && Math.max(...ys) < r.VH,
    "and it must stay on the screen while it does it; it flew between y " +
    Math.min(...ys).toFixed(1) + " and " + Math.max(...ys).toFixed(1) +
    " on a " + r.VH + "px stage");

  /* It LEAVES. Both halves, because they fail differently: a short `life`
     makes it evaporate over the stage, and that shows on the clock rather
     than on the map. */
  assert.ok(r.lastX > r.VW,
    "it should cross and go off the far side; the last anybody saw of it was " +
    "x " + r.lastX + " on a " + r.VW + "px stage");
  assert.ok(r.lifeLeft > 0,
    "and leave with time to spare rather than expiring mid-screen -- that is " +
    "what `life` was raised for; it had " + r.lifeLeft + " frames left");
}

test("the dragon wanders across the stage and leaves the far side", async () => {
  const run = await arena(SQUALLS, REESE);
  checkWander(run, dragonFlight(run));
});

test("negative control: a dragon that flies straight fails the wander test", async () => {
  /* `wander` to nought, which is not a made-up state: it is the branch the
     engine still keeps for a dragon without one, a lazy rise and fall of a
     tenth of a pixel. It still crosses, it still leaves, it still kills --
     it is simply a lane again. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    wander: 11, veer: 17, ease: 0.9,",
    "    wander: 0, veer: 17, ease: 0.9,") });
  const r = dragonFlight(run);
  expectToFail(() => checkWander(run, r),
    "with the wander switched off the wander test should fail; it passed");
});

test("negative control: a dragon that expires mid-screen fails the wander test", async () => {
  /* The other half, and the one `life: 280` was written against: the path is
     left exactly as ragged as it is and the clock is cut instead. It wanders
     beautifully for ninety frames and then simply is not there any more,
     which on screen is a dragon you beat by waiting. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    speed: 2.1, life: 280, flap: 6, hitEvery: 60,",
    "    speed: 2.1, life: 90, flap: 6, hitEvery: 60,") });
  const r = dragonFlight(run);
  expectToFail(() => checkWander(run, r),
    "with the dragon expiring over the stage the wander test should fail; it passed");
});

/* =====================================================================
   STAR OF DAVID -- one star, or the six points it is made of
   ===================================================================== */

/* Cast a star, then press the same button again on frame `splitAt` and watch
   what is in the air.

   The bar is deliberately NOT topped up here, unlike every other measurement
   in this file. The second press has to be shown not to SPEND anything, and
   a bar refilled to 999 every frame cannot show that; it starts on a hundred
   and pays for the first cast out of its own pocket.

   Everything is read BEFORE step() rather than after: a star that split is
   dead on the frame it split, and dead projectiles are pruned inside step(),
   so the one frame where the whole star and its halves could overlap is only
   visible from in front. */
const starFlight = (run, splitAt) => run(`(function () {
  ${SETUP}
  // Nobody in the way: this measures where the pieces GO, not what they hit.
  foe.invuln = 9999; foe.x = main.x + main.w - 8;
  var rows = [], manaBefore = -1, manaAfter = -1, castAgain = false;
  netplay.active = true;
  for (var i = 0; i < 60; i++) {
    me.hitstop = 0;
    var live = projectiles.filter(function (q) {
      return q.constructor.name === 'Star' && !q.dead;
    });
    var whole = live.filter(function (q) { return q.piece === 'whole'; });
    var bits = live.filter(function (q) { return q.piece !== 'whole'; });
    rows.push({ i: i, whole: whole.length, pieces: bits.length,
                at: bits.map(function (q) {
                  return { p: q.piece, x: +q.x.toFixed(4), y: +q.y.toFixed(4) };
                }) });
    if (i === ${splitAt}) manaBefore = +me.mana.toFixed(3);
    netplay.framePads = [bitsToPad(i === 0 || i === ${splitAt} ? ${SP_NEUTRAL} : 0),
                         bitsToPad(0)];
    step();
    if (i === ${splitAt}) manaAfter = +me.mana.toFixed(3);
    // Anything after the split press that puts him back into a cast is a
    // second star being paid for, whatever the bar happens to read.
    if (i >= ${splitAt} && me.state === 'special') castAgain = true;
  }
  netplay.active = false; netplay.framePads = null;
  return { rows: JSON.stringify(rows), manaBefore: manaBefore,
           manaAfter: manaAfter, castAgain: castAgain };
})()`);

/* What each piece is worth, measured one piece at a time. The foe is parked
   out of reach and untouchable until the wanted piece exists, and is then
   walked onto it -- x and y both, because a shard thrown off a fan is not at
   head height for long and a test that waited for one to arrive would be
   measuring the arc instead of the damage. */
const starDamage = (run, splitAt, piece) => run(`(function () {
  ${SETUP}
  foe.invuln = 9999; foe.x = main.x + main.w - 8;
  var took = 0, at = -1;
  netplay.active = true;
  for (var i = 0; i < 70; i++) {
    me.hitstop = 0;
    var st = projectiles.filter(function (q) {
      return q.constructor.name === 'Star' && !q.dead &&
             q.piece === ${JSON.stringify(piece)};
    })[0];
    if (st && i > ${splitAt < 0 ? 14 : splitAt + 4}) {
      foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0;
      foe.x = st.x; foe.y = st.y + 7; foe.vx = 0; foe.vy = 0; foe.grounded = false;
    }
    netplay.framePads = [bitsToPad(i === 0 || i === ${splitAt} ? ${SP_NEUTRAL} : 0),
                         bitsToPad(0)];
    var h0 = foe.health;
    step();
    if (foe.health < h0) { took = +(h0 - foe.health).toFixed(3); at = i; break; }
  }
  netplay.active = false; netplay.framePads = null;
  return { took: took, at: at };
})()`);

// The six pieces, in the order STAR_FAN numbers them: clockwise from twelve.
const PIECES = ["p0", "p1", "p2", "p3", "p4", "p5"];

function checkSplit(run, flight, whole, shards) {
  const s = JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.neutral)"));
  assert.equal(s.label, "STAR OF DAVID",
    "precondition: his neutral special is the star; it is " + s.label);
  const rows = JSON.parse(flight.rows);

  /* SIX BEARINGS, READ OFF THE ENGINE. The fan is a constant of the figure
     rather than a tuning number, so it is checked as one: six of them, all
     unit length, or the pieces are not leaving on the star's own seams. */
  const fan = JSON.parse(run("JSON.stringify(STAR_FAN)"));
  assert.equal(fan.length, 6,
    "a hexagram comes apart into the six points it is made of, so there are " +
    "six bearings to come apart along; STAR_FAN has " + fan.length);
  for (const v of fan) {
    assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-9,
      "and every one of them is a DIRECTION, not a speed -- `spread` is where " +
      "the speed lives; " + JSON.stringify(v) + " is " +
      Math.hypot(v[0], v[1]).toFixed(6) + " long");
  }

  // One star, whole, until somebody presses the button a second time.
  const before = rows.filter((r) => r.whole > 0);
  assert.ok(before.length > 0, "the star should have been thrown at all");
  const wasWhole = before[before.length - 1].i;
  assert.ok(rows.filter((r) => r.i <= wasWhole).every((r) => r.pieces === 0),
    "and be one thing until it is told otherwise; a piece turned up before " +
    "the second press");

  /* SIX, AND EXACTLY SIX, ON THE FRAME AFTER THE PRESS. A hexagram is a
     hexagon with six triangles on it, so a split that yields two pieces or
     five is not the move it is drawn as -- and the hexagon is not one of the
     six, it leaves as the sparks.

     Counted from the frame after the press rather than over the rest of the
     flight, because the pieces are SUPPOSED to leave: they live twenty-six
     frames and the ones aimed downward are off the bottom of the screen
     before that, and a test that demanded all six for as long as any
     survived would be failing the move for working. */
  const after = rows.filter((r) => r.i > wasWhole && (r.pieces > 0 || r.whole > 0));
  assert.ok(after.length > 0, "the second press should have split it");
  assert.equal(after[0].pieces, 6,
    "the frame after the press should hold the six points the star was made " +
    "of; it held " + after[0].pieces);
  for (const r of after) {
    assert.ok(r.pieces <= 6,
      "a star comes apart into six and no more; on frame " + r.i +
      " there were " + r.pieces);
    assert.equal(r.whole, 0,
      "and the whole one stops existing when it does; frame " + r.i +
      " still had " + r.whole);
  }
  const seen = new Set();
  for (const p of after[0].at) seen.add(p.p);
  assert.deepEqual([...seen].sort(), PIECES,
    "and they are the six points by name, one each; the split made " +
    JSON.stringify([...seen].sort()));

  /* AND THEY OPEN. Measured as every PAIR getting further apart rather than
     as six directions, because six pieces that all left on slightly different
     headings would pass a direction test and still cover one lane between
     them. `off` is what puts them where their points were on the frame of the
     press; `spread` is what takes them away from each other afterwards. */
  const full = after.filter((r) => r.pieces === 6);
  assert.ok(full.length > 8,
    "precondition: all six should stay up long enough to diverge; they were " +
    "all in the air for " + full.length + " frames");
  const at = (r, p) => r.at.find((q) => q.p === p);
  const gap = (r, a, b) =>
    Math.hypot(at(r, a).x - at(r, b).x, at(r, a).y - at(r, b).y);
  const first = full[0], last = full[full.length - 1];
  const span = last.i - first.i;
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      const a = PIECES[i], b = PIECES[j];
      assert.ok(gap(last, a, b) > gap(first, a, b) + span,
        "every pair of pieces has to get FURTHER apart -- six lanes where the " +
        "star covered one; " + a + " and " + b + " went from " +
        gap(first, a, b).toFixed(1) + "px to " + gap(last, a, b).toFixed(1) +
        "px over " + span + " frames");
    }
  }

  /* And no two of them go the same way. Read as a bearing away from where the
     six of them are between them, because they all inherit the star's forward
     speed and a heading measured against the stage would say six pieces sharing
     one direction were six pieces doing the same thing. */
  const cx = PIECES.reduce((t, p) => t + at(last, p).x, 0) / 6;
  const cy = PIECES.reduce((t, p) => t + at(last, p).y, 0) / 6;
  const away = PIECES.map((p) =>
    (Math.atan2(at(last, p).y - cy, at(last, p).x - cx) * 180 / Math.PI + 360) % 360);
  const sorted = [...away].sort((a, b) => a - b);
  for (let i = 0; i < 6; i++) {
    const d = clockwiseFrom(sorted[i], sorted[(i + 1) % 6]);
    assert.ok(d > 30,
      "no two pieces may leave on the same bearing, or the fan is not a fan; " +
      "two of them are " + d.toFixed(1) + " degrees apart (all six: " +
      sorted.map((v) => v.toFixed(1)).join(", ") + ")");
  }

  /* What they cost you, off the stage rather than off the table. Splitting is
     a choice about COVERAGE: six lanes for half the damage each. HALF OF
     ELEVEN IS FIVE AND A HALF AND ELEVEN IS ODD, so the number the move was
     asked for rounds DOWN -- six would be 30 damage against somebody pinned
     in place, out of one press. A piece worth what the whole star is worth
     makes the second press free, and a free second press is not a decision. */
  assert.ok(whole.at >= 0, "the whole star should have connected");
  assert.equal(whole.took, s.damage,
    "and hit for the spec's `damage` (" + s.damage + "); it took " + whole.took);
  for (const p of PIECES) {
    assert.ok(shards[p].at >= 0, "and so should " + p + "; it never connected");
    assert.equal(shards[p].took, s.shard.damage,
      p + " hits for `shard.damage` (" + s.shard.damage + "); it took " +
      shards[p].took);
    assert.ok(shards[p].took < whole.took,
      "and for LESS than the whole star -- splitting buys reach, not damage; " +
      "the whole took " + whole.took + " and " + p + " took " + shards[p].took);
    assert.equal(shards[p].took, Math.floor(s.damage / 2),
      "and for exactly half of it rounded down (" + Math.floor(s.damage / 2) +
      "), which is the rule this move was asked for; " + p + " took " +
      shards[p].took);
  }
}

const allShards = (run, splitAt) => {
  const out = {};
  for (const p of PIECES) out[p] = starDamage(run, splitAt, p);
  return out;
};

test("the star comes apart into the six points it is made of", async () => {
  const run = await arena(SQUALLS, REESE);
  checkSplit(run, starFlight(run, 25), starDamage(run, -1, "whole"),
             allShards(run, 25));
});

test("negative control: pieces that hit as hard as the star fail the split test", async () => {
  /* The upgrade nobody would notice. It still splits, it still covers six
     lanes, it still looks exactly right -- and the second press has stopped
     costing anything, so there is no longer a reason not to press it every
     single time, six times over. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      shard: { damage: 5, base: 2.6, scale: 5.0, angle: 45,",
    "      shard: { damage: 11, base: 2.6, scale: 5.0, angle: 45,") });
  expectToFail(() => checkSplit(run, starFlight(run, 25), starDamage(run, -1, "whole"),
                                allShards(run, 25)),
    "with the pieces hitting for the whole star's damage the split test " +
    "should fail; it passed");
});

test("negative control: a fan that never opens fails the split test", async () => {
  /* `spread` taken to nothing and nothing else touched. Six pieces still come
     off, all six still fly, they still hit for five each -- and they travel
     in a clump two pixels across for the whole twenty-six frames, so the move
     covers exactly the lane the star already covered. It is the edit that
     looks like tidying a magic number away, and on screen it is a star that
     got blurry rather than a star that came apart. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      off: 2, spread: 3.0,",
    "      off: 2, spread: 0,") });
  expectToFail(() => checkSplit(run, starFlight(run, 25), starDamage(run, -1, "whole"),
                                allShards(run, 25)),
    "with the fan never opening the split test should fail; it passed");
});

function checkSplitIsNotACast(run, flight) {
  const s = JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.neutral)"));
  const rows = JSON.parse(flight.rows);
  const wasWhole = rows.filter((r) => r.whole > 0).pop();
  assert.ok(wasWhole, "precondition: a whole star should have been in the air");
  assert.ok(rows.some((r) => r.pieces === 6),
    "precondition: and the second press should have split it");

  /* The bar is the honest witness. The split is a COMMAND to something
     already flying rather than a cast, so the press that sends it must not
     also pay `mana` for a fresh star -- and what arranges that is one line in
     updateAttack, which is exactly the sort of line a later tidy-up deletes
     because it looks redundant next to splitStars(). */
  assert.ok(s.mana > 0,
    "precondition: a star costs something to throw (" + s.mana + ")");
  assert.ok(flight.manaAfter >= flight.manaBefore,
    "the press that splits a star must not spend the bar again; it went " +
    flight.manaBefore + " -> " + flight.manaAfter + ", and a star costs " +
    s.mana);
  assert.equal(flight.castAgain, false,
    "and must not put him back into a cast at all");
  assert.ok(rows.every((r) => r.i <= wasWhole.i || r.whole === 0),
    "so no second whole star may appear behind the pieces; one did");
}

test("the press that splits a star does not also throw another", async () => {
  const run = await arena(SQUALLS, REESE);
  checkSplitIsNotACast(run, starFlight(run, 25));
});

test("negative control: without the guard the split press casts as well", async () => {
  /* The guard removed and nothing else touched. splitStars() still runs at
     the top of update() and still splits what is in the air; what is gone is
     the line that stops the SAME press falling through to the cast below it.
     On screen that is two halves and a brand new star, and a bar
     twenty-two lighter than it should be. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      if (intent && intent.kind === 'star' && this.starSplit) return;",
    "      if (false && intent && intent.kind === 'star' && this.starSplit) return;") });
  expectToFail(() => checkSplitIsNotACast(run, starFlight(run, 25)),
    "with the guard gone the second-press test should fail; it passed");
});

/* =====================================================================
   THE STAR AND THE DREAM -- what a shot that lands is worth on the meter
   ===================================================================== */

/* One star, and the meter read either side of the frame it connects.

   This exists because of HOW it is wired. A star that reaches somebody pays
   dream from Star.burst -- and `burst` is not a name the star chose, it is
   the hook resolveCombat calls on a shot that has just landed instead of
   simply killing it. Rename it, or add an early return above it, and the
   star still flies, still hits, still does its damage and still dies on
   contact; the only thing that stops is the meter, and the only thing that
   shows is a dragon that is slower than it should be four casts later.

   Two arms, because the miss is the half that can go wrong invisibly. The
   banana fills the same meter, so a probe that only watched a star that hit
   would pass just as happily if catching fruit were doing the work. */
const starDream = (run, connect) => run(`(function () {
  ${SETUP}
  me.dream = 0;
  foe.invuln = ${connect ? 0 : 9999}; foe.x = main.x + main.w - 8;
  var before = -1, after = -1, at = -1;
  netplay.active = true;
  for (var i = 0; i < 90; i++) {
    me.hitstop = 0;
    var st = projectiles.filter(function (q) {
      return q.constructor.name === 'Star' && !q.dead;
    })[0];
    // Walked onto the star rather than waited for, so the frame it lands on
    // is not a property of where the probe happened to park him.
    if (st && i > 12 && ${connect}) {
      foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0;
      foe.x = st.x; foe.y = st.y + 7; foe.vx = 0; foe.vy = 0; foe.grounded = false;
    }
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_NEUTRAL} : 0), bitsToPad(0)];
    var h0 = foe.health, d0 = me.dream;
    step();
    if (foe.health < h0) {
      before = +d0.toFixed(4); after = +me.dream.toFixed(4); at = i; break;
    }
  }
  netplay.active = false; netplay.framePads = null;
  return { before: before, after: after, at: at, dream: +me.dream.toFixed(4) };
})()`);

function checkStarDream(run, hit, miss) {
  const s = JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.neutral)"));
  assert.ok(s.dream > 0,
    "precondition: a star is specified to pay `dream` when it lands; it pays " +
    s.dream);
  assert.ok(hit.at >= 0, "precondition: the star should have connected at all");
  assert.ok(Math.abs(hit.after - hit.before - s.dream) < 1e-6,
    "a star that connects should add `dream` (" + s.dream + ") to the meter " +
    "the dragon reads; it went " + hit.before + " -> " + hit.after);

  assert.equal(miss.at, -1,
    "precondition: the control star should have reached nobody; it hit on " +
    "frame " + miss.at);
  assert.equal(miss.dream, 0,
    "and a star that reaches nobody should pay nothing at all -- the meter " +
    "is a reward for landing shots, not for throwing them; it reached " +
    miss.dream);
}

test("a star that lands pays the dream, and one that misses pays nothing", async () => {
  const run = await arena(SQUALLS, REESE);
  checkStarDream(run, starDream(run, true), starDream(run, false));
});

test("negative control: a star that pays nothing fails the dream test", async () => {
  /* The hook left in place and emptied, which is what a tidy-up does to it:
     `burst` looks like a method that only exists to set `dead`, and setting
     `dead` is what the branch above it in resolveCombat does anyway. Delete
     the two lines under it and every visible thing about the star is
     identical. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    const d = this.spec.dream || 0;",
    "    const d = 0;") });
  expectToFail(() => checkStarDream(run, starDream(run, true), starDream(run, false)),
    "with the star paying no dream the meter test should fail; it passed");
});

/* =====================================================================
   THE WHIP -- and the twenty-two pixels at the end of it
   ===================================================================== */

/* One cast, one victim pinned at one distance, and the first damage he takes.
   He is re-pinned every frame -- position, hitstun, i-frames -- because what
   is being measured is the size of ONE hit at ONE range, and a victim allowed
   to fly takes the next one somewhere else entirely.

   `foe.vy` comes back alongside the damage because the sweet spot is a whole
   separate spec rather than a multiplier: it launches on its own angle as
   well as hitting harder, and that is most of what makes it worth standing
   at the right distance for. */
const whipHit = (run, atX) => run(`(function () {
  ${SETUP}
  foe.invuln = 0; foe.x = me.x + ${atX};
  var took = 0, at = -1, vy = 0;
  netplay.active = true;
  for (var i = 0; i < 60; i++) {
    me.hitstop = 0; me.mana = 999;
    foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.x = me.x + ${atX}; foe.y = main.y; foe.vx = 0; foe.vy = 0;
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_UP} : 0), bitsToPad(0)];
    var h0 = foe.health;
    step();
    if (foe.health < h0) {
      took = +(h0 - foe.health).toFixed(3); at = i; vy = +foe.vy.toFixed(3);
      break;
    }
  }
  netplay.active = false; netplay.framePads = null;
  return { took: took, at: at, vy: vy };
})()`);

/* The four distances are derived from `sweet.from` rather than written down,
   because the boundary IS the move: a whip retuned to reach further has to
   drag its sweet spot along with it or this measures the wrong two sides.
   Two comfortably inside it and two comfortably past, so a pixel of rounding
   at the edge is nobody's problem. As it stands they come out at 14, 26, 38
   and 44. */
const whipRange = (run) => {
  const s = JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.up)"));
  return {
    s,
    close: whipHit(run, s.sweet.from - 18),
    mid: whipHit(run, s.sweet.from - 6),
    tip: whipHit(run, s.sweet.from + 6),
    far: whipHit(run, s.sweet.from + 12),
  };
};

function checkWhip(r) {
  const s = r.s;
  assert.equal(s.label, "THE WHIP",
    "precondition: his up special is the whip; it is " + s.label);
  assert.ok(s.sweet && s.sweet.from > 0,
    "precondition: `sweet.from` names where the good part of the box starts");
  assert.equal(s.sweet.damage, s.damage * 2,
    "the end of it is worth DOUBLE the rest -- that is the whole move; the " +
    "spec says " + s.damage + " and " + s.sweet.damage);

  for (const [where, hit] of [["close", r.close], ["mid", r.mid],
                              ["tip", r.tip], ["far", r.far]]) {
    assert.ok(hit.at >= 0,
      "the whip should reach somebody standing at " + where + " range at " +
      "all; nothing landed");
  }

  /* BOTH sides, and the near one first. A sweet spot that has come loose is
     a sweet spot that is always ON -- the boundary is a `>=` against a
     distance, so its two failure modes are "always true" and "never true",
     and a test that only checked the tip would sail through the likelier of
     the two. Measured: 10 at 14px and 26px, 20 at 38px and 44px. */
  assert.equal(r.close.took, s.damage,
    "up close it is an ordinary long poke worth `damage` (" + s.damage +
    "); it took " + r.close.took);
  assert.equal(r.mid.took, s.damage,
    "and still is at arm's length, a step inside `sweet.from` (" +
    s.sweet.from + "); it took " + r.mid.took);
  assert.equal(r.tip.took, s.sweet.damage,
    "at tip range it is worth `sweet.damage` (" + s.sweet.damage +
    "); it took " + r.tip.took);
  assert.equal(r.far.took, s.sweet.damage,
    "and stays worth it to the end of the box; it took " + r.far.took);

  // And the tip throws harder, which is the other half of what it buys.
  assert.ok(Math.abs(r.tip.vy) > Math.abs(r.mid.vy) + 1,
    "the tip launches on its own angle as well as hitting harder; the body " +
    "of the whip sent him off at " + r.mid.vy + " and the end of it at " +
    r.tip.vy);
}

test("the whip's tip hits for double, and the rest of it does not", async () => {
  const run = await arena(SQUALLS, REESE);
  checkWhip(whipRange(run));
});

test("negative control: a sweet spot that is always on fails the whip test", async () => {
  /* The likely regression, and the invisible one: the distance test stops
     being a test. Every hit is a tip hit now, which in a match is a whip
     that feels wonderful and is worth twenty from point-blank range -- there
     is nothing on screen that says otherwise. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "          if (Math.abs(near - a.x) >= move.sweet.from) {",
    "          if (true || Math.abs(near - a.x) >= move.sweet.from) {") });
  expectToFail(() => checkWhip(whipRange(run)),
    "with the sweet spot always on the whip test should fail; it passed");
});

test("negative control: a sweet spot out past the box fails the whip test", async () => {
  /* The other way it dies. `from` pushed past the forty pixels the box
     actually covers, so the good part is somewhere nobody can stand and the
     move is a long poke with a lot of recovery and no reason to space it.
     The spec still advertises a sweet spot; the stage never hands one out. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      sweet: { from: 22, damage: 16, base: 5.0, scale: 8.6, angle: 58,",
    "      sweet: { from: 999, damage: 16, base: 5.0, scale: 8.6, angle: 58,") });
  expectToFail(() => checkWhip(whipRange(run)),
    "with the sweet spot out of reach the whip test should fail; it passed");
});

/* =====================================================================
   AND THE MOVES THAT ARE NOT THERE ANY MORE
   ===================================================================== */

test("REM SLEEP, the yawn, the nap and the bakery are gone from the engine entirely", async () => {
  /* A replaced move leaves two kinds of wreckage: a label nobody reads and a
     `kind` nobody dispatches on. The second is the dangerous one -- a stale
     case in runSpecial costs nothing and says nothing, right up until a spec
     is edited to point at it again. Read off the SOURCE rather than out of
     the ROSTER, because a dead case is not in the ROSTER at all; that is the
     entire reason this greps a file instead of walking a table.

     Three moves went this way, not one. REM SLEEP was the ult until 2.60;
     SLEEP ON IT and the YAWN were the down and the neutral until 2.65, and
     those two are the ones that had a class and a dispatch arm of their own
     to leave behind. */
  const src = readFileSync(ENGINE_PATH, "utf8");
  assert.equal(/remsleep/i.test(src), false,
    "nothing in the engine should still say remsleep; the ult is SALAMENCE");
  assert.equal(/class\s+Yawn\b/.test(src), false,
    "and the Yawn class went with the move that threw it");

  /* `bakery` joined them in 2.83. It is the third move to go this way and
     the second to leave a whole class behind -- Loaf went with it, the way
     Yawn went with the yawn -- and it is the one that proves why this test
     greps the source instead of walking the ROSTER: napping() dispatched on
     `kind === 'bakery'` from OUTSIDE the table, and the day no entry carried
     that kind it became a question with one answer and nothing on screen to
     say so. It was deleted with the move. */
  for (const dead of ["yawn", "sleep", "bakery"]) {
    assert.equal(new RegExp("kind: '" + dead + "'").test(src), false,
      "no move may still be declared `kind: '" + dead + "'`");
    assert.equal(new RegExp("case '" + dead + "':").test(src), false,
      "and runSpecial must not still keep an arm for '" + dead + "' -- a " +
      "dead case is invisible from the ROSTER and free to dispatch on again");
  }

  const run = await arena(SQUALLS, REESE);
  const kinds = run(`[ROSTER.squalls.ult.kind,
    ROSTER.squalls.specials.up.kind, ROSTER.squalls.specials.down.kind,
    ROSTER.squalls.specials.neutral.kind].join(',')`);
  assert.equal(kinds, "salamence,whip,toss,star",
    "his four moves should be the dragon, the whip, the banana and the star; " +
    "they are " + kinds);
  const labels = run(`[ROSTER.squalls.ult.label,
    ROSTER.squalls.specials.up.label, ROSTER.squalls.specials.down.label,
    ROSTER.squalls.specials.neutral.label].join(',')`);
  assert.equal(labels, "SALAMENCE,THE WHIP,BANANA,STAR OF DAVID",
    "and wear the names the roster screen shows; they are " + labels);
  assert.equal(/class\s+Loaf\b/.test(src), false,
    "and the Loaf class went with the move that baked it, the same way Yawn " +
    "went with the yawn");
});

/* =====================================================================
   THE STAR OF DAVID, AS A PICTURE

   Everything above this line is about what the star DOES. This is about what
   it looks like, and it is here because looking wrong is the failure this
   move actually shipped with.

   The art before 2.65 was two SOLID triangles stacked base to base. Every
   test above passed on it: it flew, it split, the halves climbed and dived
   and hit for the right numbers. It just did not look like a Star of David.
   Solid, at eleven pixels, two triangles are a pale rhombus with a stripe
   across the waist -- there is no middle to see through, and there are no
   points, because a point is only a point when there is background on both
   sides of it. Nothing anybody could measure about the move would have
   caught that, and nothing did; the player did.

   So these read the PIXELS. The canvas this file boots the engine with is a
   Proxy that answers every method with a no-op and remembers nothing, which
   means a drawing test run against it passes no matter what is drawn -- or
   whether anything is drawn at all. Each measurement below therefore builds
   a recorder of its own: an object whose fillRect keeps the rectangle and
   the fillStyle it was issued under. drawStarArt emits nothing else; the
   entire picture is fillStyle and fillRect.

   What is pinned here is the SHAPE, not the artwork. A hexagram has six
   points around a hollow middle, it stays inside its own hitbox, it is the
   flag's blue, and it turns. Any pixel may move that keeps those true. */

/* One Star, drawn at each of `spins` in a single trip into the vm, because
   the turn is a property of the frames TOGETHER and one frame cannot show it.

   Parked on whole numbers on purpose: draw() rounds the position before it
   lays anything down, so a star at x.5 is the same picture shifted over, and
   a test that had to allow for the shift could no longer say where the edges
   of the art are. The owner is a real fighter only because the constructor
   wants one; drawing never looks at him.

   box() and the three color constants come back alongside the frames so that
   everything below can be written against what the engine says a star is,
   rather than against numbers copied out of it into here. */
const starShots = (run, piece, spins) => JSON.parse(run(`JSON.stringify((function () {
  var st = new Star(fighters[0], ROSTER.squalls.specials.neutral,
                    ${JSON.stringify(piece)}, 40, 40, 0, 0);
  var list = ${JSON.stringify(spins)}, frames = [];
  for (var i = 0; i < list.length; i++) {
    st.spin = list[i];
    var rects = [];
    var rec = { globalAlpha: 1, fillStyle: '#000',
      fillRect: function (x, y, w, h) {
        rects.push({ x: x, y: y, w: w, h: h, c: this.fillStyle });
      },
      drawImage: function () {}, beginPath: function () {}, arc: function () {},
      fill: function () {}, save: function () {}, restore: function () {},
      translate: function () {}, scale: function () {} };
    st.draw(rec);
    frames.push(rects);
  }
  return { frames: frames, box: st.box(), cx: Math.round(st.x), cy: Math.round(st.y),
           blue: STAR_BLUE, field: STAR_FIELD, spark: STAR_SPARK,
           ids: STAR_POINTS[${JSON.stringify(piece)}].join('') };
})())`));

/* What a star's own spin counter does while it flies. Every drawing above is
   handed a spin chosen by the test; this is the only thing that shows the
   engine ever hands it a DIFFERENT one. */
const starSpinsInFlight = (run, frames) => run(`(function () {
  var st = new Star(fighters[0], ROSTER.squalls.specials.neutral, 'whole', 40, 40, 0, 0);
  var seen = [];
  for (var i = 0; i < ${frames}; i++) { st.update(); seen.push(st.spin); }
  return seen.join(',');
})()`);

/* The recorded rectangles painted flat, keyed "column,row", last write wins --
   which is what a screen does, and what drawStarArt counts on: the pale field
   goes down first and the blue goes over the top of it. Everything it emits
   is one row tall, but nothing here assumes that. */
function starPixels(frame) {
  const px = new Map();
  for (const r of frame) {
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) px.set((r.x + dx) + "," + (r.y + dy), r.c);
    }
  }
  return px;
}

const cellAt = (key) => key.split(",").map(Number);

// Every pixel of one color, and every pixel that is NOT the pale field.
const colored = (px, c) => [...px].filter((e) => e[1] === c).map((e) => e[0]);
const inkOf = (shot, px) =>
  new Set([...px].filter((e) => e[1] !== shot.field).map((e) => e[0]));

/* Where a clump of pixels sits, as a bearing in degrees from the middle of
   the star. Screen y grows downward, so an angle that INCREASES is a clump
   moving clockwise, which is the way the star is drawn turning. */
function bearing(shot, cells) {
  let sx = 0, sy = 0;
  for (const k of cells) { const [x, y] = cellAt(k); sx += x; sy += y; }
  return Math.atan2(sy / cells.length - shot.cy, sx / cells.length - shot.cx) *
         180 / Math.PI;
}
const clockwiseFrom = (a, b) => (((b - a) % 360) + 360) % 360;

/* Every 4-connected run of pale pixels, and whether the star SEALS it.
   `leaky` means some pixel of the run touches somewhere the star did not draw
   at all, which matters because a gap in the outline would otherwise read as
   a hole -- and a hexagram whose points have leaked open is a snowflake. A
   hole is only a hole if the star closes around it. */
function paleHoles(px, field) {
  const seen = new Set(), out = [];
  for (const [key, c] of px) {
    if (c !== field || seen.has(key)) continue;
    const stack = [key], cells = [];
    let leaky = false;
    seen.add(key);
    while (stack.length) {
      const cur = stack.pop();
      cells.push(cur);
      const [x, y] = cellAt(cur);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = (x + dx) + "," + (y + dy);
        if (!px.has(nk)) { leaky = true; continue; }
        if (px.get(nk) === field && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    out.push({ size: cells.length, leaky, cells });
  }
  return out;
}

/* ---------------------------------------------------------------------
   SIX POINTS AROUND A HOLLOW MIDDLE
   --------------------------------------------------------------------- */

function checkHexagram(shot) {
  const px = starPixels(shot.frames[0]);
  assert.ok(px.size > 40,
    "precondition: the star should have been drawn at all; " + px.size +
    " pixels reached the recorder");

  /* THE ONE PROPERTY THE OLD ART DID NOT HAVE. Two triangle outlines crossing
     leave the middle empty; two solid triangles fill it in. Read at the exact
     middle of the star, because that is the pixel both versions own and the
     only one whose color tells them apart. */
  const middle = px.get(shot.cx + "," + shot.cy);
  assert.equal(middle, shot.field,
    "the middle of the star has to be the pale field showing through -- that " +
    "is what makes it a hexagram and not a lump; it is " + middle);
  assert.notEqual(middle, shot.blue,
    "and specifically not the blue, which is the old solid star coming back");

  const holes = paleHoles(px, shot.field);
  for (const h of holes) {
    assert.equal(h.leaky, false,
      "every pale patch inside the star has to be SEALED by the star; one of " +
      h.size + " pixels touches open background, which means the outline has " +
      "a gap in it and the shape is coming undone");
  }

  /* ONE sealed patch, and it is the middle. The assertion that used to stand
     here demanded SEVEN -- six points plus the middle -- and it passed on the
     art the player complained about, because what it was counting in the
     points was six one-pixel white pips buried in flat vertical walls. A
     checker that cannot tell a point from a nick in a wall is not measuring
     six-pointedness. The points are solid now and the only hole is the
     middle. */
  assert.equal(holes.length, 1,
    "the only pale patch the star encloses is its middle; this one encloses " +
    holes.length + " (sizes " +
    holes.map((h) => h.size).sort((a, b) => a - b).join(", ") + ")");
  const inner = holes[0];
  assert.ok(inner.cells.includes(shot.cx + "," + shot.cy),
    "and it is the one the middle of the star is in");

  /* SO THE SHAPE IS ASSERTED ON THE BLUE SILHOUETTE INSTEAD, and this is the
     fault somebody actually reported. A point-up hexagram is widest at the
     shoulders, where two points and the hexagon share a row, and it BITES
     inward between the two o'clock point and the four o'clock one.
     Rasterize the honest figure at eleven pixels and the side point protrudes
     1.59px over a run of 2.75, which rounds to one column with a three-row
     flat either side of it -- a wall with a nick in it. Two columns is a bite,
     and a bite is the only thing at this size that reads as a point. */
  const rowSpan = new Map();
  for (const [k, c] of px) {
    if (c === shot.field) continue;
    const [x, y] = cellAt(k);
    const e = rowSpan.get(y) || [Infinity, -Infinity];
    rowSpan.set(y, [Math.min(e[0], x), Math.max(e[1], x)]);
  }
  const ys = [...rowSpan.keys()].sort((a, b) => a - b);
  const span = (y) => rowSpan.get(y)[1] - rowSpan.get(y)[0] + 1;
  const shoulder = Math.max(...ys.map(span));
  const wide = ys.filter((y) => span(y) === shoulder);
  const waist = Math.min(...ys.filter((y) => y > wide[0] && y < wide[wide.length - 1])
                              .map(span));
  assert.ok(waist <= shoulder - 4,
    "the star has to bite INWARD between its two o'clock point and its " +
    "four o'clock one, or the side of it is a wall and there are only " +
    "two points on this star; the shoulder is " + shoulder +
    " columns across and the waist is " + waist);

  /* AND THERE ARE SIX OF THEM, read off the grid that numbers the points
     rather than off the holes that used to stand in for them. The numbering is
     not decoration: it is what drawStarArt lights as the star turns, and it is
     the same numbering split() hands STAR_FAN, so the piece that flies at two
     o'clock is the one the star lit at two o'clock. If these six stop
     being six points around a middle, the fan is aiming at something else. */
  const ids = [...new Set(shot.ids.split("").filter((c) => /[0-9]/.test(c)))].sort();
  assert.equal(ids.length, 6,
    "the star numbers six points; it numbers " + ids.length);
  const points = ids.map(() => ({ cells: [] }));
  for (let i = 0; i < shot.ids.length; i++) {
    const id = shot.ids[i];
    if (!/[0-9]/.test(id)) continue;
    points[ids.indexOf(id)].cells.push(
      (shot.cx - 5 + (i % 11)) + "," + (shot.cy - 5 + Math.floor(i / 11)));
  }
  for (let k = 0; k < points.length; k++) {
    assert.ok(points[k].cells.length >= 2,
      "a point is a clump rather than a speck; point " + ids[k] + " is " +
      points[k].cells.length + " pixels");
  }

  /* And they are AROUND it rather than inside it. A middle that had burst open
     and swallowed its own points could still be counted as seven patches once,
     so the arrangement is checked too: every point sits further out than any
     pixel of the middle reaches. */
  const reach = (k) => {
    const [x, y] = cellAt(k);
    return Math.hypot(x - shot.cx, y - shot.cy);
  };
  const innerReach = Math.max(...inner.cells.map(reach));
  for (const p of points) {
    const near = Math.min(...p.cells.map(reach));
    assert.ok(near > innerReach,
      "a point has to sit outside the middle, not inside it; one is " +
      near.toFixed(2) + "px out and the middle already reaches " +
      innerReach.toFixed(2) + "px");
  }

  /* Spread evenly the whole way round, which is the difference between six
     points and three points drawn twice. Sixty degrees apart is the honest
     figure; the band is wider than that because each point is three pixels
     and where three pixels average out wobbles either side of the angle. */
  const angles = points.map((p) => bearing(shot, p.cells)).sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i < angles.length; i++) {
    const gap = clockwiseFrom(angles[i], angles[(i + 1) % angles.length]);
    assert.ok(gap > 40 && gap < 80,
      "the six points should sit about sixty degrees apart the whole way " +
      "round; two of them are " + gap.toFixed(1) + " degrees apart");
    total += gap;
  }
  assert.ok(Math.abs(total - 360) < 1,
    "and between them go round once, not twice; they cover " + total.toFixed(1) +
    " degrees");
}

test("the star is a hexagram: six points around a hollow middle", async () => {
  const run = await arena(SQUALLS, REESE);
  checkHexagram(starShots(run, "whole", [0]));
});

test("negative control: a star with its middle filled in fails the hexagram test", async () => {
  /* The old art, brought back the way it would actually come back -- not by
     anybody redrawing the grid, but by the blue band being told to cover the
     middle as well. The outline, the six tips and every pixel of the
     silhouette are untouched, and on screen it is a pale rhombus with a
     stripe across it again, which is the exact thing the player reported. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "starBand(g, grid, '#=X', STAR_BLUE, ox, oy);",
    "starBand(g, grid, '#=Xo', STAR_BLUE, ox, oy);") });
  expectToFail(() => checkHexagram(starShots(run, "whole", [0])),
    "with the middle filled in the hexagram test should fail; it passed");
});

test("negative control: a star with a wall down each side fails the hexagram test", async () => {
  /* The bite filled back in, and nothing else touched. The star is still nine
     by eleven, still six-numbered, still hollow in the middle, still the
     flag's blue -- and its left and right sides are flat vertical walls
     three rows tall again, which is the art that shipped and the thing the
     player was looking at when he said it still looked weird. This is also the
     edit somebody would make on purpose: a straight edge is tidier than a
     bitten one, and at eleven pixels the bite is the entire difference between
     six points and two. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    '...XoooX...',",
    "    '.==XoooX==.',") });
  expectToFail(() => checkHexagram(starShots(run, "whole", [0])),
    "with a flat wall down each side the hexagram test should fail; it passed");
});

/* ---------------------------------------------------------------------
   THE SIX PIECES ARE THE STAR'S SIX POINTS
   --------------------------------------------------------------------- */

function checkPiecesAreTheStar(shots, fan) {
  const ink = {}, pale = {};
  for (const p of PIECES) {
    const px = starPixels(shots[p].frames[0]);
    ink[p] = [...px].filter((e) => e[1] !== shots[p].field).map((e) => e[0]);
    pale[p] = [...px].filter((e) => e[1] === shots[p].field).map((e) => e[0]);
    assert.ok(ink[p].length > 0, "precondition: " + p + " should have drawn something");
  }

  /* SIX DRAWINGS, NOT THREE. A rhombus is the same shape upside down, so the
     six pieces rasterize to three silhouettes and 1/4 and 2/5 come back
     outline-for-outline identical. What makes them six is the pale pip in the
     nose, which is why the pip is checked below and not just noted in a
     comment: with it gone the star would come apart into three pairs of twins
     and a player could not tell which way any of them was going. */
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      assert.notEqual([...ink[PIECES[i]]].sort().join("|"),
                      [...ink[PIECES[j]]].sort().join("|"),
        PIECES[i] + " and " + PIECES[j] + " are the same drawing, so two of " +
        "the six pieces are indistinguishable in the air");
    }
  }

  for (let i = 0; i < 6; i++) {
    const p = PIECES[i], f = fan[i], sh = shots[p];
    const rel = ink[p].map((k) => {
      const [x, y] = cellAt(k);
      return [x - sh.cx, y - sh.cy];
    });

    /* IT REACHES THE EDGE OF ITS OWN BOX AND NO FURTHER. Three either way
       inside a six-square hitbox: a piece that draws four columns out teaches
       a reach it does not have, and one that draws two sits inside its own box
       looking like a mistake. */
    const far = Math.max(...rel.map((v) => Math.max(Math.abs(v[0]), Math.abs(v[1]))));
    assert.equal(far, 3,
      p + " should fill its three-pixel radius exactly; its ink reaches " + far);

    /* AND IT IS LONGER ALONG ITS BEARING THAN IT IS ACROSS IT. That is what
       makes it a shard thrown off a wheel rather than a chip: the thing has to
       point where it is going. Measured against STAR_FAN, which is the bearing
       split() actually hands it. */
    const along = Math.max(...rel.map((v) => v[0] * f[0] + v[1] * f[1]));
    const across = Math.max(...rel.map((v) => Math.abs(v[0] * -f[1] + v[1] * f[0])));
    assert.ok(along > across,
      p + " has to be longer along the bearing it leaves on than it is across " +
      "it; it reaches " + along.toFixed(2) + " along and " + across.toFixed(2) +
      " across");

    /* THE PALE PIP IS IN THE NOSE, and it is the whole direction read. One
       pixel of the flag's white, one cell off centre TOWARD the apex, on the
       apex side of centre along the piece's own bearing. Put it in the tail
       and the shard looks like it is flying backwards. */
    assert.equal(pale[p].length, 1,
      p + " carries exactly one pale pixel, which is its nose; it has " +
      pale[p].length);
    const [px0, py0] = cellAt(pale[p][0]);
    const dot = (px0 - sh.cx) * f[0] + (py0 - sh.cy) * f[1];
    assert.ok(dot > 0,
      p + " should wear its pale pip on the apex side of centre along " +
      JSON.stringify(f) + "; the pip is at " +
      JSON.stringify([px0 - sh.cx, py0 - sh.cy]) + ", which projects to " +
      dot.toFixed(2));
  }

  /* And the fan itself: six bearings, sixty degrees apart, IN ORDER, clockwise
     from twelve. In order matters because the numbering is shared with
     STAR_POINTS -- the piece that flies at two o'clock has to be the one the
     star lit at two o'clock, or the split stops explaining itself. */
  const deg = fan.map((v) => (Math.atan2(v[1], v[0]) * 180 / Math.PI + 450) % 360);
  for (let i = 0; i < 6; i++) {
    const d = clockwiseFrom(deg[i], deg[(i + 1) % 6]);
    assert.ok(Math.abs(d - 60) < 1e-9,
      "the six bearings should sit sixty degrees apart going clockwise from " +
      "twelve; STAR_FAN[" + i + "] to [" + ((i + 1) % 6) + "] is " +
      d.toFixed(4) + " degrees (all six: " +
      deg.map((v) => v.toFixed(1)).join(", ") + ")");
  }
}

const pieceShots = (run) => {
  const out = {};
  for (const p of PIECES) out[p] = starShots(run, p, [0]);
  return out;
};

test("the six pieces are the star's six points, and each knows which way it is going", async () => {
  const run = await arena(SQUALLS, REESE);
  checkPiecesAreTheStar(pieceShots(run),
                        JSON.parse(run("JSON.stringify(STAR_FAN)")));
});

test("negative control: a piece drawn as another piece fails the six-pieces test", async () => {
  /* The piece that dives handed the picture of the piece that climbs. It still
     splits, all six still come off, they all still hit for five -- and two of
     the six are now the same drawing wearing its pip in the wrong end, so the
     one aimed at the floor reads as aimed at the sky. Between them the six no
     longer say six things, which is what the pip is for. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "const grid = STAR_ART[piece], pts = STAR_POINTS[piece];",
    "const grid = STAR_ART[piece === 'p3' ? 'p0' : piece], pts = STAR_POINTS[piece];") });
  expectToFail(() => checkPiecesAreTheStar(pieceShots(run),
                                           JSON.parse(run("JSON.stringify(STAR_FAN)"))),
    "with two pieces drawn the same the six-pieces test should fail; it passed");
});

/* ---------------------------------------------------------------------
   EVERY LIT CELL IS A CELL THE STAR ACTUALLY DREW
   --------------------------------------------------------------------- */

/* The mechanical guard on the two hand-authored grid blocks, and the reason it
   exists is that STAR_ART and STAR_POINTS are two separate pictures of the
   same object typed by hand. A numbered cell that lands on a '+' lights the
   white pip instead of the blue, and a numbered cell that lands on a '.' paints
   a pixel the star never drew -- one dims a pose and the other grows a speck
   outside the shape, and neither is visible in any other assertion here. */
function checkBandsSitOnInk(run) {
  const art = JSON.parse(run("JSON.stringify(STAR_ART)"));
  const pts = JSON.parse(run("JSON.stringify(STAR_POINTS)"));
  const all = ["whole"].concat(PIECES);
  assert.deepEqual(Object.keys(art).sort(), all.slice().sort(),
    "precondition: the star is drawn as a whole and six pieces");
  assert.deepEqual(Object.keys(pts).sort(), all.slice().sort(),
    "precondition: and every one of them numbers its own points");
  for (const p of all) {
    for (let row = 0; row < 11; row++) {
      for (let col = 0; col < 11; col++) {
        const id = pts[p][row][col];
        if (id === ".") continue;
        const c = art[p][row][col];
        assert.ok("#=X".indexOf(c) >= 0,
          p + " lights " + row + "," + col + ", and the star drew " +
          (c === "." ? "nothing" : "the pale field") + " there (" + c + "). A " +
          "lit cell has to be a cell the blue band already painted, or the " +
          "highlight is either a speck outside the shape or a hole punched in " +
          "the white");
      }
    }
  }
}

/* The same thing again off the RENDER, which is the one that counts. The
   silhouette is already pinned frame to frame by the turning test; what is
   pinned here is the COLOURS: the pale set and the blue-or-lit set must both
   be the same on every pose, because the highlight is only ever allowed to
   re-colour blue. A band that has slipped onto a pip steals a pixel from the
   white on the one pose that lights it. */
function checkLitStaysOnTheBlue(shot, what) {
  const sets = shot.frames.map((f) => {
    const px = starPixels(f);
    const paleSet = [], inkSet = [];
    for (const [k, c] of px) (c === shot.field ? paleSet : inkSet).push(k);
    return [paleSet.sort().join("|"), inkSet.sort().join("|")];
  });
  for (let i = 1; i < sets.length; i++) {
    assert.equal(sets[i][0], sets[0][0],
      what + " changes which pixels are the pale field between poses; the " +
      "highlight is only ever allowed to re-colour the blue");
    assert.equal(sets[i][1], sets[0][1],
      what + " changes which pixels are ink between poses, so a lit point is " +
      "landing somewhere the star did not draw");
  }
}

test("every lit cell is a cell the star actually drew", async () => {
  const run = await arena(SQUALLS, REESE);
  checkBandsSitOnInk(run);
  checkLitStaysOnTheBlue(starShots(run, "whole", [0, 5, 10, 15, 20, 25]),
                         "the whole star");
  for (const p of PIECES) {
    checkLitStaysOnTheBlue(starShots(run, p, [0, 5, 10]), p);
  }
});

test("negative control: a band cell on the white pip fails the lit-cell test", async () => {
  /* One numbered cell moved one row, onto the pale pip in the nose of p0. It
     is a single character in a grid of dots and it is the exact edit somebody
     makes while nudging a highlight to look better centred. Nothing crashes,
     nothing moves, the silhouette is identical -- and for five frames out of
     fifteen the piece loses its white nose to the highlight, which is the one
     thing telling a player which way it is going. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    '...........', '....111....', '...........', '....000....',",
    "    '.....1.....', '....111....', '...........', '....000....',") });
  expectToFail(() => {
    checkBandsSitOnInk(run);
    checkLitStaysOnTheBlue(starShots(run, "p0", [0, 5, 10]), "p0");
  }, "with a band cell sitting on the white pip the lit-cell test should " +
     "fail; it passed");
});

/* ---------------------------------------------------------------------
   NOTHING DRAWN OUTSIDE THE HITBOX
   --------------------------------------------------------------------- */

function checkFitsItsHitbox(shot, what) {
  const px = starPixels(shot.frames[0]);
  assert.ok(px.size > 0, "precondition: " + what + " should have drawn something");

  /* Read off box() rather than typed in here, because the number that matters
     is the one the engine hits people with. A whole star and a half have
     different ones, and a test carrying its own copy of the pair is only
     right by accident.

     box() is a square 2r across centered on the star, so the pixel columns it
     covers run from the middle minus r to the middle plus r. Art outside that
     range is a star that looks bigger than it hits: the player learns a reach
     from what he can see, and is then not hit at it. */
  const r = shot.box.w / 2;
  assert.equal(shot.box.h / 2, r, "precondition: the hitbox is square");
  assert.equal(shot.box.x + r, shot.cx,
    "precondition: and centered on the star itself");

  let far = 0;
  for (const key of px.keys()) {
    const [x, y] = cellAt(key);
    assert.ok(Math.abs(x - shot.cx) <= r && Math.abs(y - shot.cy) <= r,
      what + " draws a pixel at " + key + ", which is outside a hitbox " +
      (r * 2) + " across centered on " + shot.cx + "," + shot.cy);
    far = Math.max(far, Math.abs(x - shot.cx), Math.abs(y - shot.cy));
  }

  /* The other side of the same coin. Everything above is satisfied by a star
     that draws nothing, and by one drawn at half size in the middle of its
     own box -- which teaches the reach wrong in the other direction and looks
     like a mistake besides. It has to reach the edge. */
  assert.equal(far, r,
    what + " should fill its hitbox out to the edge rather than sit inside " +
    "it; the art reaches " + far + "px from the middle and the box is " + r);
}

function checkEveryPieceFits(run) {
  checkFitsItsHitbox(starShots(run, "whole", [0]), "the whole star");
  for (const p of PIECES) checkFitsItsHitbox(starShots(run, p, [0]), "piece " + p);
}

test("neither the whole star nor any of its pieces draws outside its own hitbox", async () => {
  const run = await arena(SQUALLS, REESE);
  checkEveryPieceFits(run);
});

/* ---------------------------------------------------------------------
   SIX OF ONE THING, NOT TWO OF ONE AND FOUR OF ANOTHER
   --------------------------------------------------------------------- */

/* The split is supposed to be the star coming apart along its own seams, so
   what leaves is one object at six angles. A rotation moves a BOUNDING BOX --
   five wide by seven tall against seven by five is right, and the existing
   reach test already allows it -- but a rotation does not change how much of
   the thing there is.

   It shipped changing it. p0 and p3, the two that fly straight up and
   straight down, carried TWENTY-TWO blue cells against the four diagonals'
   sixteen: thirty-five per cent more ink. Rendered, the two verticals came
   out as fat octagonal blobs while the four diagonals were two-pixel streaks,
   and a fan that should read as six of one thing read as two of one and four
   of another. Nothing mechanical depended on it -- all six carry radius three
   and five damage -- which is exactly why no assertion here caught it, and
   why this one is about ink and not about anything a hitbox knows. */
function checkSixOfOneThing(art) {
  const count = (k) => {
    let ink = 0, pale = 0;
    for (const row of art[k]) {
      for (const ch of row) {
        if (ch === "#" || ch === "=") ink++;
        if (ch === "+") pale++;
      }
    }
    return { ink, pale };
  };
  const n = PIECES.map(count);
  const ink = n.map((v) => v.ink);
  const want = ink[0];
  for (let i = 0; i < PIECES.length; i++) {
    assert.equal(ink[i], want,
      "ALL SIX PIECES ARE THE SAME AMOUNT OF STAR. " + PIECES[i] + " draws " +
      ink[i] + " blue cells and " + PIECES[0] + " draws " + want + " (all " +
      "six: " + PIECES.map((p, j) => p + "=" + ink[j]).join(", ") + "). The " +
      "six are one shape at six bearings, so the bounding box may turn and " +
      "the ink may not change: a piece a third heavier than its neighbours " +
      "reads as a different object, and the split stops looking like one " +
      "thing coming apart");
    assert.equal(n[i].pale, 1,
      PIECES[i] + " carries exactly one pale pip, which is its nose");
  }
}

test("all six pieces are the same amount of star", async () => {
  const run = await arena(SQUALLS, REESE);
  checkSixOfOneThing(JSON.parse(run("JSON.stringify(STAR_ART)")));
});

test("negative control: the fat vertical shard fails the same-amount test", async () => {
  /* p0 as it shipped: a five-wide body three rows deep instead of a
     three-wide one, which is twenty-two cells against sixteen. Every other
     assertion in this file is satisfied by it -- it fits its box, it reaches
     the edge, it is longer along its bearing than across, its pip is in its
     nose, and it is distinct from all five others. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    '....#+#....', '....###....', '....###....', '....###....',",
    "    '...##+##...', '...#####...', '...#####...', '....###....',") });
  expectToFail(() => checkSixOfOneThing(JSON.parse(run("JSON.stringify(STAR_ART)"))),
    "with one piece a third heavier than the others the same-amount test " +
    "should fail; it passed");
});

test("negative control: a piece drawn wider than its box fails the hitbox test", async () => {
  /* One of p0's rows run out toward the full width of the grid. One character,
     and it is the character somebody adds to make a piece look like it fills
     the space it is drawn in: a piece is drawn in an eleven-wide grid and only
     ever allowed to use seven of it, which reads like an off-by-one waiting to
     be tidied away. The piece then paints a pixel a whole column outside the
     six-square box it hits with, and a player learns a reach the shard does
     not have. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    '....#+#....', '....###....', '....###....', '....###....',",
    "    '....#+#....', '.#######...', '....###....', '....###....',") });
  expectToFail(() => checkEveryPieceFits(run),
    "with a piece drawn a column wider than its box the hitbox test should " +
    "fail; it passed");
});

/* ---------------------------------------------------------------------
   THE FLAG'S BLUE
   --------------------------------------------------------------------- */

function checkFlagBlue(shot) {
  /* Written out here on purpose, and it is the one number in this section not
     read back off the engine. #0038b8 is a fact about a flag rather than
     about this game: it cannot be derived, it has no tolerance, and the only
     way it goes wrong is somebody eyeballing a blue they like better. A test
     that asked the engine which blue it used would agree with whatever it had
     drifted to. */
  assert.equal(shot.blue, "#0038b8",
    "the star is drawn in the Israeli flag's blue; STAR_BLUE is " + shot.blue);
  assert.notEqual(shot.blue, shot.field,
    "which has to differ from the pale field it sits on, or there is no star " +
    "to see");
  assert.notEqual(shot.spark, shot.blue,
    "and from the lit point, or the star stops showing which way it is turning");

  const px = starPixels(shot.frames[0]);
  const body = colored(px, shot.blue).length;
  const lit = colored(px, shot.spark).length;
  const pale = colored(px, shot.field).length;
  assert.equal(body + lit + pale, px.size,
    "nothing should be drawn in a fourth color; " + (px.size - body - lit - pale) +
    " pixels are in none of the blue, the field or the highlight");

  /* And the blue is the star, not a trim on it. The highlight is one point out
     of six and the field is what shows through the gaps, so a drawing where
     either of them outweighs the blue is not this drawing. */
  assert.ok(body > lit,
    "the flag's blue should be most of the star rather than a highlight on " +
    "it; " + body + " pixels are blue and " + lit + " are the lit point");
  assert.ok(body > pale,
    "and more of it than of the field showing through; " + body + " blue " +
    "against " + pale + " pale");
}

test("the star is drawn in the flag's blue", async () => {
  const run = await arena(SQUALLS, REESE);
  checkFlagBlue(starShots(run, "whole", [0]));
});

test("negative control: a star in some other blue fails the flag-blue test", async () => {
  /* A blue that is perfectly defensible and is not the flag's. This is the
     edit that gets made while tuning a stage's palette, from a screenshot, by
     somebody with no reason to know the number was quoted rather than chosen
     -- which is why the comment beside it in the engine says so, and why this
     test is here to say it a second time. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "const STAR_BLUE = '#0038b8';",
    "const STAR_BLUE = '#2b5bd7';") });
  expectToFail(() => checkFlagBlue(starShots(run, "whole", [0])),
    "with the star drawn in a different blue the flag-blue test should fail; " +
    "it passed");
});

test("negative control: a star drawn in the highlight blue fails the flag-blue test", async () => {
  /* The constant left alone and the drawing pointed at the wrong one of the
     three. Everything a reader greps for is still correct -- STAR_BLUE is
     still the flag's blue and still sits under a comment saying so -- while
     the star on screen is the pale highlight from top to bottom, with the lit
     point now invisible against it. Nothing but the pixels can catch this. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "starBand(g, grid, '#=X', STAR_BLUE, ox, oy);",
    "starBand(g, grid, '#=X', STAR_SPARK, ox, oy);") });
  expectToFail(() => checkFlagBlue(starShots(run, "whole", [0])),
    "with the star drawn in the highlight color the flag-blue test should " +
    "fail; it passed");
});

/* ---------------------------------------------------------------------
   IT TURNS, AND EVERY POSE IS THE SAME STAR
   --------------------------------------------------------------------- */

function checkItTurns(shot, what, flightSpins, fan) {
  /* How many numbers this piece carries, counted off the grid that numbers
     them rather than written down here: six for the star, three for a shard.
     Everything below is derived from that one figure, so the same checker says
     the right thing about a whole star and about a piece.

     `fan` is the bearing the piece left on, or null for the whole star, and it
     is what decides what "goes round" means at the bottom. The star lights six
     TIPS and they go round it; a piece lights three BANDS down its length and
     they run to its nose. */
  const ids = [...new Set(shot.ids.split("").filter((c) => /[0-9]/.test(c)))];
  assert.ok(ids.length >= 3,
    "precondition: " + what + " should have points to light; the grid numbers " +
    ids.length);
  const period = ids.length * 5;
  assert.ok(shot.frames.length > period,
    "precondition: the frames measured have to cover a full turn (" + period +
    ") and then some; there are " + shot.frames.length);

  const frames = shot.frames.map(starPixels);

  /* THE REASON THE STAR CAN TURN AT ALL. Sixty degrees leaves a hexagram
     sitting exactly on top of itself, so the sprite is drawn once, point up,
     and never redrawn -- which is also why every pose is the pose people
     recognize instead of a smear. If the silhouette ever starts changing
     between frames, something has begun drawing poses in between, and those
     are the poses that do not survive eleven pixels. */
  const silhouette = (px) => [...px.keys()].sort().join("|");
  const shape0 = silhouette(frames[0]);
  for (let i = 1; i < frames.length; i++) {
    assert.equal(silhouette(frames[i]), shape0,
      what + " should be exactly the same shape on every frame -- a hexagram " +
      "turned sixty degrees is itself; frame " + i + " is a different outline");
  }

  /* What actually moves. The lit point is the only thing that changes, so a
     frame with nothing lit is a frame on which the star has stopped, and that
     is what it looks like too: a flat dead sprite for as long as it lasts. */
  const litSets = frames.map((px) => colored(px, shot.spark).sort().join("|"));
  for (let i = 0; i < litSets.length; i++) {
    assert.ok(litSets[i].length > 0,
      what + " should have a point lit on every frame; frame " + i + " has " +
      "none, which reads on screen as the star going flat");
  }

  const distinct = [...new Set(litSets)];
  assert.equal(distinct.length, ids.length,
    what + " should light each of its " + ids.length + " points and no others " +
    "over a turn; it used " + distinct.length + " different poses");

  /* One point clockwise every five frames. Held for five is what makes the
     turn readable rather than a flicker; moving at all is what makes it a
     turn. Both are pinned, because a pose held for one frame and a pose held
     forever fail in opposite directions and look nothing like each other. */
  for (let i = 0; i < period; i++) {
    assert.equal(litSets[i], litSets[i - i % 5],
      what + " should hold each pose for five frames; frame " + i +
      " does not match frame " + (i - i % 5));
    if (i % 5 === 0 && i > 0) {
      assert.notEqual(litSets[i], litSets[i - 5],
        what + " should move the lit point every five frames; frames " +
        (i - 5) + " and " + i + " light the same one");
    }
  }
  for (let i = 0; i + period < litSets.length; i++) {
    assert.equal(litSets[i + period], litSets[i],
      what + " should come all the way round in " + period + " frames; frame " +
      i + " and frame " + (i + period) + " light different points");
  }

  if (!fan) {
    /* And the STAR goes ROUND, one way, rather than hopping about. Each step is
       a turn of 360 divided by the points it has; the band is loose either side
       of that because a lit point is three pixels and the middle of three
       pixels does not land exactly on the angle. */
    const step = 360 / ids.length;
    let total = 0;
    for (let k = 0; k < ids.length; k++) {
      const here = bearing(shot, distinct[k].split("|"));
      const next = bearing(shot, distinct[(k + 1) % ids.length].split("|"));
      const turn = clockwiseFrom(here, next);
      assert.ok(turn > step * 0.6 && turn < step * 1.4,
        what + " should turn about " + step + " degrees per step, always the " +
        "same way round; one step is " + turn.toFixed(1) + " degrees");
      total += turn;
    }
    assert.ok(Math.abs(total - 360) < 1,
      what + " should go round exactly once per turn; it covers " +
      total.toFixed(1) + " degrees");
  } else {
    /* And a PIECE runs to its nose. A rhombus does not land on itself at any
       turn worth drawing, so its three numbers are bands down its length
       rather than tips around its edge, and what has to be true of them is not
       an angle but an ORDER: projected onto the bearing the piece left on,
       band 0 then 1 then 2 must come out strictly increasing. Backwards, the
       glint crawls up the shard toward the thing that threw it, which is the
       one reading the eye is guaranteed to get wrong. */
    let prev = -Infinity;
    for (let k = 0; k < ids.length; k++) {
      const cells = distinct[k].split("|");
      let sx = 0, sy = 0;
      for (const c of cells) { const [x, y] = cellAt(c); sx += x; sy += y; }
      const proj = (sx / cells.length - shot.cx) * fan[0] +
                   (sy / cells.length - shot.cy) * fan[1];
      assert.ok(proj > prev,
        what + " should light its bands tail first and nose last, so the " +
        "glint runs the way the shard is going; band " + k + " sits at " +
        proj.toFixed(2) + " along " + JSON.stringify(fan) + " and the one " +
        "before it at " + (prev === -Infinity ? "nothing" : prev.toFixed(2)));
      prev = proj;
    }
  }

  /* And the counter the drawing reads has to be moving. Everything above hands
     the art a spin of the test's own choosing, so on its own it would pass
     just as happily on a star that crosses the stage frozen. */
  const spins = flightSpins.split(",").map(Number);
  for (let i = 0; i < spins.length; i++) {
    assert.equal(spins[i], i + 1,
      "a star in flight should advance its spin once a frame, or the art is " +
      "handed the same pose forever; after " + (i + 1) + " frames it read " +
      spins[i]);
  }
}

// A whole turn of the star (thirty frames) with a few frames past it, so the
// checks that compare a frame with the one a revolution later have somewhere
// to look.
const TURN_FRAMES = [];
for (let i = 0; i < 35; i++) TURN_FRAMES.push(i);

test("the star turns, and every pose is the same hexagram", async () => {
  const run = await arena(SQUALLS, REESE);
  const flight = starSpinsInFlight(run, 12);
  checkItTurns(starShots(run, "whole", TURN_FRAMES), "the whole star", flight, null);

  /* A piece comes round TWICE AS FAST, and the reason is the shape rather than
     a number somebody picked: it carries three numbers against the star's six
     and the step is five frames either way, so a revolution is half as long.
     It is also the right thing to say about a lighter thing that has just been
     flung off something. */
  const fan = JSON.parse(run("JSON.stringify(STAR_FAN)"));
  for (let i = 0; i < PIECES.length; i++) {
    checkItTurns(starShots(run, PIECES[i], TURN_FRAMES), "piece " + PIECES[i],
                 flight, fan[i]);
  }
  const pointsOn = (piece) => new Set(
    run("STAR_POINTS." + piece + ".join('')").split("")
      .filter((c) => /[0-9]/.test(c))).size;
  assert.equal(pointsOn("whole"), pointsOn("p0") * 2,
    "a piece should come round twice for every once the star does; the star " +
    "has " + pointsOn("whole") + " points and a piece " + pointsOn("p0"));
});

test("negative control: a star whose lit point never moves fails the turning test", async () => {
  /* The star still drawn every frame, still flying, still counting its own
     spin -- and the highlight nailed to the top point. On screen that is a
     sprite sliding across the stage without rotating, which is exactly what a
     hexagram drawn once and never re-posed looks like the moment the one
     thing that showed the turn stops moving. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "const step = Math.floor(spin / 5);",
    "const step = Math.floor(spin / 5) * 0;") });
  expectToFail(() => checkItTurns(starShots(run, "whole", TURN_FRAMES),
                                  "the whole star", starSpinsInFlight(run, 12), null),
    "with the lit point nailed in place the turning test should fail; it passed");
});

test("negative control: a piece turning at the star's rate fails the turning test", async () => {
  /* The pieces given the star's six-step cadence over the three bands a shard
     actually has. It is the tidy-up anybody would make -- one number instead of
     a conditional -- and it does not stop the piece turning. What it does is
     spend half of every revolution pointing at bands the shard does not have,
     and a step that lights nothing is a frame where the piece goes flat and
     dead in the air. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "const n = piece === 'whole' ? 6 : 3;",
    "const n = 6;") });
  const fan = JSON.parse(run("JSON.stringify(STAR_FAN)"));
  expectToFail(() => checkItTurns(starShots(run, "p0", TURN_FRAMES),
                                  "piece p0", starSpinsInFlight(run, 12), fan[0]),
    "with a piece turning at the star's rate the turning test should fail; " +
    "it passed");
});

test("negative control: a star that never spins fails the turning test", async () => {
  /* The counter itself taken out of update(). The art is untouched and every
     pose it can strike is still correct -- it is simply handed nought on every
     frame of the star's life, so the thing that turns beautifully in a test
     harness sits dead still in an actual match. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    this.spin++;\n    this.life--;\n    this.x += this.vx;",
    "    this.life--;\n    this.x += this.vx;") });
  expectToFail(() => checkItTurns(starShots(run, "whole", TURN_FRAMES),
                                  "the whole star", starSpinsInFlight(run, 12), null),
    "with the spin counter gone the turning test should fail; it passed");
});
