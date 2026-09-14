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
 *   SOMEDAY, A BAKERY on the down, which is the old nap's job -- filling the
 *   DREAM the dragon is made of -- done standing up, and it leaves LOAVES on
 *   the floor that heal whoever reaches them first, opponent included.
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
 *   And the loaves are a healing item that does not care whose side it is
 *   on. The whole balance of the move is that last part, and "heals the man
 *   who baked it" is the version anybody would write by accident.
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
  me.dream = 0; me.wakeUp = false; me.health = 100;
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
     of what a daydream is worth now: an empty meter strolls out at `speed`
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
    "the dragon a full daydream dreams up should hit for the same as the one " +
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
    "    dreamMax: 100, dreamDamage: 0, dreamSpeed: 1.5, dreamLife: 0,",
    "    dreamMax: 100, dreamDamage: 50, dreamSpeed: 1.5, dreamLife: 0,") });
  const max = run("ROSTER.squalls.ult.dreamMax");
  expectToFail(() => checkDreamBuysSpeed(run, dragonPass(run, 0), dragonPass(run, max)),
    "with the meter buying damage too the speed test should fail; it passed");
});

test("negative control: a dragon that never reads the dream fails the speed test", async () => {
  /* The other way round, and taken out of the dragon rather than the table:
     the spec still promises 1.5 and the constructor simply stops asking for
     it. Both dragons then leave at 2.1, the daydream buys nothing at all, and
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
   STAR OF DAVID -- one star, or two triangles
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
    var up = live.filter(function (q) { return q.piece === 'up'; })[0];
    var down = live.filter(function (q) { return q.piece === 'down'; })[0];
    rows.push({ i: i, whole: whole.length, halves: live.length - whole.length,
                uy: up ? +up.y.toFixed(3) : null,
                dy: down ? +down.y.toFixed(3) : null });
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
   walked onto it -- x and y both, because a half that climbs or dives is not
   at head height for long and a test that waited for one to arrive would be
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

function checkSplit(run, flight, whole, up, down) {
  const s = JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.neutral)"));
  assert.equal(s.label, "STAR OF DAVID",
    "precondition: his neutral special is the star; it is " + s.label);
  const rows = JSON.parse(flight.rows);

  // One star, whole, until somebody presses the button a second time.
  const before = rows.filter((r) => r.whole > 0);
  assert.ok(before.length > 0, "the star should have been thrown at all");
  const wasWhole = before[before.length - 1].i;
  assert.ok(rows.filter((r) => r.i <= wasWhole).every((r) => r.halves === 0),
    "and be one thing until it is told otherwise; a half turned up before " +
    "the second press");

  /* TWO, and exactly two. A Star of David is two overlapping triangles, so a
     split that yields one piece or three is not the move it is drawn as.

     Counted over a window rather than over the rest of the flight, because
     the halves are SUPPOSED to leave: the diving one is off the bottom of
     the screen about twenty-six frames after the split, and a test that
     demanded a pair for as long as either survived would be failing the move
     for working. The ceiling below is the one that runs the whole way. */
  const after = rows.filter((r) => r.i > wasWhole && (r.halves > 0 || r.whole > 0));
  assert.ok(after.length > 0, "the second press should have split it");
  for (const r of after) {
    assert.ok(r.halves <= 2,
      "a star comes apart into two triangles and no more; on frame " + r.i +
      " there were " + r.halves);
    assert.equal(r.whole, 0,
      "and the whole one stops existing when it does; frame " + r.i +
      " still had " + r.whole);
  }
  const pair = after.filter((r) => r.i <= wasWhole + 20);
  assert.ok(pair.length > 15, "precondition: the split should leave something " +
    "in the air for a while; it lasted " + pair.length + " frames");
  for (const r of pair) {
    assert.equal(r.halves, 2,
      "and both of them should fly -- a split that yields one piece is a " +
      "star that got smaller; on frame " + r.i + " there were " + r.halves);
  }

  /* And they go DIFFERENT WAYS. `up.climb` is negative and `down.climb` is
     positive, which on a screen whose y grows downward means one leaves over
     your head and the other under your feet. Measured as a gap that OPENS
     rather than as two directions, because two halves that both climb at
     slightly different rates would pass a direction test and still cover one
     lane between them. */
  assert.ok(s.up.climb < 0 && s.down.climb > 0,
    "precondition: the halves are specified to climb and dive (" +
    s.up.climb + " / " + s.down.climb + ")");
  const both = after.filter((r) => r.uy !== null && r.dy !== null);
  assert.ok(both.length > 5,
    "both halves should stay up long enough to diverge; saw " + both.length +
    " frames with the pair of them");
  const first = both[0], last = both[both.length - 1];
  assert.ok(last.dy - last.uy > first.dy - first.uy + 20,
    "the gap between them has to OPEN -- that is the whole move, two lanes " +
    "where the star covered one; it went from " +
    (first.dy - first.uy).toFixed(1) + "px to " +
    (last.dy - last.uy).toFixed(1) + "px apart");
  assert.ok(last.uy < first.uy,
    "the up half should climb; it went " + first.uy + " -> " + last.uy);
  assert.ok(last.dy > first.dy,
    "and the down half dive; it went " + first.dy + " -> " + last.dy);

  /* What they cost you, off the stage rather than off the table. Splitting is
     a choice about COVERAGE: two lanes for less damage each. A half worth
     what the whole star is worth makes the second press free, and a free
     second press is not a decision. */
  assert.ok(whole.at >= 0, "the whole star should have connected");
  assert.equal(whole.took, s.damage,
    "and hit for the spec's `damage` (" + s.damage + "); it took " + whole.took);
  assert.ok(up.at >= 0 && down.at >= 0, "and so should each half");
  assert.equal(up.took, s.up.damage,
    "the climbing half hits for `up.damage` (" + s.up.damage + "); it took " +
    up.took);
  assert.equal(down.took, s.down.damage,
    "and the diving one for `down.damage` (" + s.down.damage + "); it took " +
    down.took);
  assert.ok(up.took < whole.took && down.took < whole.took,
    "and both of them for LESS than the whole star -- splitting buys reach, " +
    "not damage; the whole took " + whole.took + " and the halves " +
    up.took + " / " + down.took);
}

test("the star comes apart into two halves that diverge and hit for less", async () => {
  const run = await arena(SQUALLS, REESE);
  checkSplit(run, starFlight(run, 25), starDamage(run, -1, "whole"),
             starDamage(run, 25, "up"), starDamage(run, 25, "down"));
});

test("negative control: halves that hit as hard as the star fail the split test", async () => {
  /* The upgrade nobody would notice. It still splits, it still covers two
     lanes, it still looks exactly right -- and the second press has stopped
     costing anything, so there is no longer a reason not to press it every
     single time. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      up: { damage: 6, base: 2.6, scale: 5.2, angle: 66,",
    "      up: { damage: 9, base: 2.6, scale: 5.2, angle: 66,") });
  expectToFail(() => checkSplit(run, starFlight(run, 25), starDamage(run, -1, "whole"),
                                starDamage(run, 25, "up"), starDamage(run, 25, "down")),
    "with the halves hitting for the whole star's damage the split test " +
    "should fail; it passed");
});

test("negative control: halves that both climb fail the split test", async () => {
  /* The diving half taken off its dive and handed the climbing one's, which
     is the version that survives every count: two pieces, two triangles,
     both on screen, both hitting for six. They simply fly in company, and
     the move is a star that got smaller. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "              climb: 1.9, life: 95 },",
    "              climb: -1.5, life: 95 },") });
  expectToFail(() => checkSplit(run, starFlight(run, 25), starDamage(run, -1, "whole"),
                                starDamage(run, 25, "up"), starDamage(run, 25, "down")),
    "with both halves climbing the split test should fail; it passed");
});

function checkSplitIsNotACast(run, flight) {
  const s = JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.neutral)"));
  const rows = JSON.parse(flight.rows);
  const wasWhole = rows.filter((r) => r.whole > 0).pop();
  assert.ok(wasWhole, "precondition: a whole star should have been in the air");
  assert.ok(rows.some((r) => r.halves === 2),
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
    "so no second whole star may appear behind the halves; one did");
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
   THE WHIP -- and the eight pixels at the end of it
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
    "      sweet: { from: 32, damage: 20, base: 4.4, scale: 9.0, angle: 42,",
    "      sweet: { from: 999, damage: 20, base: 4.4, scale: 9.0, angle: 42,") });
  expectToFail(() => checkWhip(whipRange(run)),
    "with the sweet spot out of reach the whip test should fail; it passed");
});

/* =====================================================================
   SOMEDAY, A BAKERY -- the meter, and the bread it leaves lying about
   ===================================================================== */

/* He stands and daydreams for four seconds, and then somebody else walks
   over the results.

   Two things are collected in one pass because they are one move: the DREAM
   the dragon is made of, and the loaves. The foe is held out of reach and
   untouchable for the first two hundred frames -- a foe left to his own
   devices wanders into the bread, which is the point of the move and useless
   for counting it -- and is then walked onto whatever is on the floor.

   His health is knocked down first so the healing has somewhere to go: at a
   hundred it is clamped, and a clamped heal is indistinguishable from no
   heal at all. */
const daydream = (run) => run(`(function () {
  ${SETUP}
  foe.invuln = 9999; foe.x = main.x + main.w - 8; foe.health = 40;
  /* Both counts are kept BY IDENTITY -- every loaf object is remembered the
     frame it first appears, and counted eaten when it leaves the live set.

     The obvious versions of both do not work, and they fail in the same
     direction, which is the quiet one. Counting bakes as a length
     against a high-water mark is a running MAXIMUM: once the foe eats, the
     live count falls, and the fourth loaf landing while three are on the
     floor never exceeds it, so it is never counted. And counting eats
     as the net change in that length loses any loaf eaten on the same frame
     another is baked -- minus one plus one is nought, and the health went up
     by eleven with nothing to show for it. Both bugs hid while the move
     happened to bake three loaves and finish baking before the eating
     started; the fourth loaf found them the day it arrived. */
  var dreams = [], bakedAt = [], healed = 0, eaten = 0, known = [];
  var hp0 = foe.health;
  netplay.active = true;
  for (var i = 0; i < 330; i++) {
    me.hitstop = 0; me.mana = 999;
    var loaves = projectiles.filter(function (q) {
      return q.constructor.name === 'Loaf' && !q.dead;
    });
    for (var k = 0; k < loaves.length; k++) {
      if (known.indexOf(loaves[k]) < 0) { known.push(loaves[k]); bakedAt.push(i); }
    }
    /* Off to eat, once the daydream has run its COURSE -- not merely once it
       has been going a while.

       262 is after the last loaf lands (they come on 72, 132, 192 and 252),
       and the gap matters: walking him onto the bread while more is still
       being baked had him standing seven pixels from where the fourth loaf
       was about to spawn, and a loaf is eaten by Loaf.update on the same
       step it is pushed. It was created and gone inside one step() -- never
       live at any point a probe could look -- so it healed him for eleven
       that no counter here could attribute to anything. Bake first, then
       eat; then both counts are of things that were actually on the floor. */
    if (i >= 262 && loaves.length) {
      foe.invuln = 0; foe.x = loaves[0].x; foe.y = loaves[0].y;
      foe.vx = 0; foe.vy = 0; foe.grounded = true;
    }
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_DOWN} : 0), bitsToPad(0)];
    var h0 = foe.health;
    step();
    if (foe.health > h0) healed += foe.health - h0;
    var live = projectiles.filter(function (q) {
      return q.constructor.name === 'Loaf' && !q.dead;
    });
    /* Recomputed rather than accumulated, so it cannot drift. Nothing here
       expires of old age -- a loaf lives 420 frames and the last is baked
       around 250 -- so anything gone was eaten. */
    eaten = 0;
    for (var k = 0; k < known.length; k++) {
      if (live.indexOf(known[k]) < 0) eaten++;
    }
    // Two consecutive dreaming frames, read off the middle of the stand.
    if (i === 120 || i === 121) dreams.push(+me.dream.toFixed(4));
  }
  var seen = known.length;
  netplay.active = false; netplay.framePads = null;
  return { dreams: dreams.join(','), baked: seen, bakedAt: bakedAt.join(','),
           dream: +me.dream.toFixed(3), healed: +healed.toFixed(3),
           eaten: eaten, hp0: hp0, foeHp: +foe.health.toFixed(3) };
})()`);

function checkBakery(run, r) {
  const s = JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.down)"));
  const u = JSON.parse(run("JSON.stringify(ROSTER.squalls.ult)"));
  assert.equal(s.label, "SOMEDAY, A BAKERY",
    "precondition: his down special is the bakery; it is " + s.label);

  /* The meter, per frame and against the spec. This is the only thing that
     fills the dream and the dragon is the only thing that spends it, so a
     daydream that quietly stops filling it takes his ult down with it and
     says nothing on the way. */
  const [d1, d2] = r.dreams.split(",").map(Number);
  assert.ok(Math.abs(d2 - d1 - s.dream) < 1e-6,
    "standing there should add `dream` (" + s.dream + ") a frame; two " +
    "consecutive frames went " + d1 + " -> " + d2);
  assert.equal(r.dream, u.dreamMax,
    "and a full stand should fill the meter the dragon reads (" + u.dreamMax +
    "); he finished on " + r.dream);

  /* The bread. Counted rather than assumed, and spaced against `every`
     rather than against a frame number written down here -- the interval IS
     the move's pacing, and a loaf every ten frames is a different move.

     `loaves` is a ceiling and is asserted as one rather than as an exact
     count -- the number of loaves a stand delivers is the move's business,
     and the property worth pinning is that it never exceeds what it
     advertises. (It used to under-deliver: `active` was 240, and the fourth
     loaf needs the frame counter to REACH 240, which a 240-frame window
     never does. The window is 245 now and all four land.) */
  const at = r.bakedAt.split(",").map(Number);
  assert.ok(r.baked > 0, "the daydream should leave bread on the floor at all");
  assert.ok(r.baked <= s.loaves,
    "and never more than `loaves` (" + s.loaves + "); it left " + r.baked);
  assert.ok(at.length > 1,
    "more than one of them, or there is nothing to pace; it left " + r.baked);
  for (let i = 1; i < at.length; i++) {
    assert.equal(at[i] - at[i - 1], s.every,
      "one every `every` frames (" + s.every + "); they landed on frames " +
      r.bakedAt);
  }

  /* And it is not his bread. The whole balance of the move is here: he
     stopped dead in the middle of a fight to think about a bakery, and what
     he got for it is bread in the middle of a fight. The man he is fighting
     eats it. */
  assert.ok(r.eaten > 0,
    "his opponent should be able to walk over a loaf and eat it; nothing " +
    "was picked up");
  assert.equal(r.healed, r.eaten * s.loaf.heal,
    "and be healed `loaf.heal` (" + s.loaf.heal + ") for each one; he ate " +
    r.eaten + " and gained " + r.healed);
  assert.ok(r.foeHp > r.hp0,
    "so he leaves better off than he arrived; he went " + r.hp0 + " -> " +
    r.foeHp);
}

test("the bakery fills the dream and leaves loaves his opponent can eat", async () => {
  const run = await arena(SQUALLS, REESE);
  checkBakery(run, daydream(run));
});

test("negative control: bread only its baker can eat fails the bakery test", async () => {
  /* The version anybody would write by accident, and the one that quietly
     turns a gamble into free healing: the loaf checks whose it is before it
     checks whether anybody is standing on it. Everything else is identical --
     same stand, same meter, same four seconds, same bread on the floor. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      if (Math.abs(f.x - this.x) > 9) continue;",
    "      if (f !== this.owner) continue;\n      if (Math.abs(f.x - this.x) > 9) continue;") });
  expectToFail(() => checkBakery(run, daydream(run)),
    "with the loaves reserved for their baker the bakery test should fail; it passed");
});

test("negative control: a daydream that fills nothing fails the bakery test", async () => {
  /* The other half, taken out where it would actually go missing: the meter
     stops climbing and everything you can see about the move is unchanged.
     He still stands there, still bakes, still hands the other man the bread
     -- and the dragon he is paying for never gets any faster. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "          this.dream = Math.min(100, this.dream + s.dream);",
    "          this.dream = Math.min(100, this.dream);") });
  expectToFail(() => checkBakery(run, daydream(run)),
    "with the daydream filling nothing the bakery test should fail; it passed");
});

/* =====================================================================
   AND THE MOVES THAT ARE NOT THERE ANY MORE
   ===================================================================== */

test("REM SLEEP, the yawn and the nap are gone from the engine entirely", async () => {
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

  for (const dead of ["yawn", "sleep"]) {
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
  assert.equal(kinds, "salamence,whip,bakery,star",
    "his four moves should be the dragon, the whip, the bakery and the star; " +
    "they are " + kinds);
  const labels = run(`[ROSTER.squalls.ult.label,
    ROSTER.squalls.specials.up.label, ROSTER.squalls.specials.down.label,
    ROSTER.squalls.specials.neutral.label].join(',')`);
  assert.equal(labels, "SALAMENCE,THE WHIP,SOMEDAY, A BAKERY,STAR OF DAVID",
    "and wear the names the roster screen shows; they are " + labels);
});
