/* Squalls, as 2.60 left him: the dragon came out of the ult slot's back
 * pocket and the placeholder finally went.
 *
 * He used to be SALAMENCE on the up special and REM SLEEP as the ult. Both
 * of those are gone. The up is now a FISHING POLE -- Trev's move, copied
 * whole -- and SALAMENCE is the ult, one slow dragon that kills outright
 * whatever it touches. `remsleep` does not appear anywhere in the engine any
 * more.
 *
 * Three things about that arrangement can rot quietly, and each of them is a
 * different kind of quiet:
 *
 *   The dragon is a 999 in a damage field. Nothing in the engine treats it
 *   as special -- there is no instant-kill flag -- so the whole rule lives in
 *   one number, and a number is the easiest thing in this file to tune by
 *   accident into a merely enormous hit.
 *
 *   The nap now buys SPEED and nothing else. `dreamDamage` and `dreamLife`
 *   are still there, set to nought, because a dragon that cannot hit harder
 *   than instant death has nowhere to put a damage meter -- and a stray edit
 *   that puts the meter back on damage changes what the whole character is
 *   for without changing anything you can see.
 *
 *   And the pole is ONE FIELD different on the two men who carry it. Trev
 *   casts it downward and has his recovery elsewhere; for Squalls it is the
 *   up special, so it is given a `rise` and nothing else. That is exactly the
 *   kind of difference a later tidy-up flattens in either direction, which is
 *   why both halves are pinned in one test rather than one each.
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
   test has no functions of its own. */
const SETUP = `
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0;
  freezeFrames = 0;
  me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
  me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.vy = 0;
  me.grabbing = -1; me.grabbedBy = -1; me.grounded = true; me.facing = 1;
  me.ultMeter = 999; me.x = main.x + 24; me.y = main.y; me.specialSpawned = false;
  foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
  foe.stocks = 3; foe.eliminated = false; foe.health = 100; foe.hasHit = true;
  foe.grounded = true; foe.vx = 0; foe.vy = 0; foe.y = main.y;
  foe.burn = 0; foe.poison = 0; foe.confused = 0; foe.drowsy = 0;
  foe.grabbing = -1; foe.grabbedBy = -1; foe.mana = 100;
  foe.x = main.x + main.w / 2;`;

// The pad bits, as netplay packs them.
const ULT = 256;
const SP_UP = 2048, SP_DOWN = 1024;

// Where each fighter sits in ORDER. Positions, not names, because that is
// what select.cursor takes.
const TREV = 5, REESE = 4, SQUALLS = 8;

/* =====================================================================
   SALAMENCE -- one pass, and whoever it reaches is gone
   ===================================================================== */

/* Press the ult and stand well out of the way. The dragon comes in from off
   the edge BEHIND him and crosses the whole stage at a walking pace, so the
   measurement is long: a hundred and sixty frames is the dragon's own flight
   plus room for the KO to play out.

   The victim is pinned in the dragon's lane only while he is untouched. Once
   he has been hit, the whole sim freezes for about a dozen frames and then he
   is somewhere else entirely -- and a test that kept dragging him back would
   be fighting the KO it is trying to watch. */
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
    var d = projectiles.filter(function (q) {
      return q.constructor.name === 'Salamence';
    })[0];
    // Read off the dragon itself the first frame it exists, because what the
    // dream bought is baked in at construction and never consulted again.
    if (d && seen < 0) {
      seen = i; vx = +d.vx.toFixed(6); dmg = d.spec.damage;
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
    "and reach the man standing in front of it; nothing ever touched him");
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
     still flies, it still connects, it still looks exactly like the ult -- and
     the man it reaches walks away, which is the entire difference. */
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
     of what a nap is worth now: an empty meter strolls out at `speed` and a
     full one arrives at `speed` plus this, which is the difference between
     walking out of the way and having to commit to a jump. */
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
     concludes that sleeping makes the dragon hit harder.

     Measured off the two dragons first and only then read out of the table,
     in that order deliberately: the spec is what a control is most likely to
     move along with the behavior, and an assertion that fires on what was
     actually built cannot be talked round. */
  assert.equal(full.dmg, cold.dmg,
    "the dragon a full nap dreams up should hit for the same as the one a " +
    "cold start does: " + cold.dmg + " against " + full.dmg);
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
     it. Both dragons then leave at 2.1, the nap buys nothing at all, and the
     measurement is the only place that shows -- the ROSTER still reads
     exactly as it does today. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    this.vx = this.dir * (spec.speed + (spec.dreamSpeed || 0) * this.power);",
    "    this.vx = this.dir * spec.speed;") });
  const max = run("ROSTER.squalls.ult.dreamMax");
  expectToFail(() => checkDreamBuysSpeed(run, dragonPass(run, 0), dragonPass(run, max)),
    "with the dream never reaching the dragon the speed test should fail; it passed");
});

/* =====================================================================
   THE FISHING POLE, on two men, one `rise` apart
   ===================================================================== */

/* Cast from well up in the air, where a lift is the only thing that can send
   anybody upward. The cast itself is the measurement: `rise` is written into
   vy on the frame the startup ends, so a move that has one climbs out of its
   own fall and a move that does not simply keeps going down. */
const castFromAir = (run, bits) => run(`(function () {
  ${SETUP}
  me.x = main.x + main.w / 2; me.y = main.y - 70;
  me.grounded = false; me.vy = 0; me.vx = 0;
  // Out of reach, so nothing the line catches can change where he is.
  foe.invuln = 9999; foe.x = main.x + main.w - 8;
  var y0 = me.y, best = me.y, cast = false;
  netplay.active = true;
  for (var i = 0; i < 30; i++) {
    me.hitstop = 0; me.mana = 999;
    netplay.framePads = [bitsToPad(i === 0 ? ${bits} : 0), bitsToPad(0)];
    step();
    if (me.state === 'special') cast = true;
    if (me.y < best) best = me.y;
  }
  netplay.active = false; netplay.framePads = null;
  return { cast: cast, lift: +(y0 - best).toFixed(3), y0: y0,
           best: +best.toFixed(3) };
})()`);

/* The two specs as strings, with the lift taken out of both. `drift` goes
   with `rise` rather than being a second difference: the pole's `drift` is
   only ever read inside the `if (s.rise && ...)` branch in runSpecial, so on
   a move with no rise it is dead weight and on one with a rise it is part of
   the same three lines. Everything else has to match, field for field. */
/* Every field, in a stable order. It used to skip `rise` and `drift`, which
   were the one allowed difference between the two copies while Squalls's
   doubled as a recovery. That lift is gone -- played, it read as a mistimed
   jump and was the first thing anybody noticed about the move -- so the two
   specs are now identical with nothing excused, and this compares all of it. */
const POLE_JSON = (path) => `(function () {
  var s = ROSTER.${path}, out = {};
  Object.keys(s).sort().forEach(function (k) { out[k] = s[k]; });
  return JSON.stringify(out);
})()`;

/* Two builds, not one. Each man's table is read out of the vm he was
   actually measured in -- the earliest draft read both tables from Squalls's
   copy, which meant a sabotage aimed at Trev never showed up in the half of
   the test that reads the spec, and the control passed for the wrong
   reason. */
function checkPole(sq, tv, squalls, trev) {
  const s = JSON.parse(sq("JSON.stringify(ROSTER.squalls.specials.up)"));
  const t = JSON.parse(tv("JSON.stringify(ROSTER.trev.specials.down)"));
  assert.equal(s.label, "FISHING POLE",
    "precondition: Squalls's up special is the pole; it is " + s.label);
  assert.equal(t.label, "FISHING POLE",
    "precondition: Trev's down special is the pole he lent him");

  /* The same move, field for field, with nothing excused. The engine comment
     says it is Trev's borrowed whole, and a placeholder that has been quietly
     retuned is a placeholder nobody can compare to the thing it stands in
     for. */
  assert.equal(sq(POLE_JSON("squalls.specials.up")),
    tv(POLE_JSON("trev.specials.down")),
    "the two poles should be identical; they are not");

  /* The stage before the table, on purpose. What a spec says about a rise is
     one edit away from what a rise does, and a control that moved both would
     otherwise be caught by the half that agrees with it. */
  assert.ok(squalls.cast, "precondition: Squalls should have cast the pole");
  assert.ok(trev.cast, "precondition: Trev should have cast his");
  assert.equal(squalls.lift, 0,
    "casting the pole must not jolt him upward -- it briefly did, and that " +
    "jolt is the thing that was taken back out; he gained " + squalls.lift + "px");
  assert.equal(trev.lift, 0,
    "and Trev's identical cast must not lift him either, or his down " +
    "special has quietly become a recovery; he gained " + trev.lift + "px");

  // And neither table carries the field that used to do it.
  assert.equal(s.rise, undefined,
    "Squalls's copy must not carry a `rise` any more; it is " + s.rise);
  assert.equal(t.rise, undefined,
    "and Trev's never did; his `rise` is " + t.rise);
}

test("the pole is Trev's, whole, and it lifts neither of them", async () => {
  const squalls = await arena(SQUALLS, REESE);
  const trev = await arena(TREV, REESE);
  checkPole(squalls, trev, castFromAir(squalls, SP_UP), castFromAir(trev, SP_DOWN));
});

test("negative control: giving Squalls his lift back fails the pole test", async () => {
  /* The likely regression, because it was real code a version ago: somebody
     decides an up special ought to get him home and puts the rise back. It
     has to fail on the STAGE half -- he visibly climbs out of a fall -- and
     on the table half, which is why the spec is compared with nothing
     excused now. Squalls's copy is the six-space indent; Trev's sits two
     columns out, and that is the only thing telling the identical lines
     apart. */
  const squalls = await arena(SQUALLS, REESE, { engine: sabotage(
    "      ox: 4, oy: -12, w: 46, h: 10,\n      grab: { hold: 32, damage: 0 },",
    "      ox: 4, oy: -12, w: 46, h: 10,\n      rise: -5.2, drift: 0.6,\n      grab: { hold: 32, damage: 0 },") });
  const trev = await arena(TREV, REESE);
  expectToFail(() => checkPole(squalls, trev, castFromAir(squalls, SP_UP),
                               castFromAir(trev, SP_DOWN)),
    "with the lift back in Squalls's table the pole test should fail; it passed");
});

test("negative control: retuning one copy of the pole fails the pole test", async () => {
  /* The other way it rots, and the quieter one: the move is a stand-in, so
     somebody adjusts it on the character who is using it as a stand-in and
     not on the man it was borrowed from. Nothing about that is visible in a
     match -- both poles still cast, still catch, still throw -- which is
     exactly why it is asserted field for field. */
  const squalls = await arena(SQUALLS, REESE, { engine: sabotage(
    "      grab: { hold: 32, damage: 0 },\n      damage: 0, base: 0, scale: 0,",
    "      grab: { hold: 44, damage: 0 },\n      damage: 0, base: 0, scale: 0,") });
  const trev = await arena(TREV, REESE);
  expectToFail(() => checkPole(squalls, trev, castFromAir(squalls, SP_UP),
                               castFromAir(trev, SP_DOWN)),
    "with one copy retuned the pole test should fail; it passed");
});

/* =====================================================================
   AND THE MOVE THAT IS NOT THERE ANY MORE
   ===================================================================== */

test("REM SLEEP is gone from the engine entirely, name and all", async () => {
  /* A replaced move leaves two kinds of wreckage: a label nobody reads and a
     `kind` nobody dispatches on. The second is the dangerous one -- a stale
     case in runSpecial costs nothing and says nothing, right up until a spec
     is edited to point at it again. Read off the source rather than out of
     the ROSTER, because a dead case is not in the ROSTER at all. */
  const src = readFileSync(ENGINE_PATH, "utf8");
  assert.equal(/remsleep/i.test(src), false,
    "nothing in the engine should still say remsleep; the ult is SALAMENCE " +
    "and the up special is the pole");

  const run = await arena(SQUALLS, REESE);
  const kinds = run(`[ROSTER.squalls.ult.kind,
    ROSTER.squalls.specials.up.kind, ROSTER.squalls.specials.down.kind,
    ROSTER.squalls.specials.neutral.kind].join(',')`);
  assert.equal(kinds, "salamence,pole,sleep,yawn",
    "his four moves should be the dragon, the pole, the nap and the yawn; " +
    "they are " + kinds);
  const labels = run(`[ROSTER.squalls.ult.label,
    ROSTER.squalls.specials.up.label].join(',')`);
  assert.equal(labels, "SALAMENCE,FISHING POLE",
    "and wear the names the roster screen shows; they are " + labels);
});
