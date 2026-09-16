/* THE SECOND PRESS, AND THE CPU FINALLY MAKING IT.
 *
 * AutisNick's rainbow has always had two halves: a shot on an arc, and a
 * press that detonates it where it is. Until 2.81 the second half existed
 * only for a person. Over 720 seeded matches on the shipping file the CPU
 * threw 1201 rainbows, detonated 32 of them by accident and caught nobody --
 * a zero measured twice -- because the second press is `spUp`, which aiDecide
 * reached for about once every seven hundred and seventy frames, aimed at a
 * shot that lives fifty-five.
 *
 * Nothing about the move changed. What was added is one question -- is there
 * a reason to -- and one bare `spUp` in aiDecide. The things worth pinning
 * are all about what that press is NOT allowed to be:
 *
 *   NOT a cast. `spUp` alone with no `special` can only ever burst: the whole
 *   cast branch in updateFree is gated on `pad.special`, so the press cannot
 *   come out of the far side as a second rainbow, or -- for a chicken, whose
 *   slotFor maps `up` onto a moveset with no up slot -- as a beak thrown at
 *   the sky.
 *
 *   NOT a trigger. A shot that is about to land is left alone. The ball is
 *   free, so "is anybody inside the disc" on its own trades a hit for a hit,
 *   and the version that did measured 0.6 points WORSE.
 *
 *   NOT a field. worthBursting is a prototype method and the aiDecide branch
 *   stores nothing, so a Rainbow's own keys are the twelve they always were
 *   and restoreSim has nothing new to delete.
 *
 * The engine source is loaded directly: Rainbow, `projectiles`, aiDecide and
 * `fighters` are all internals.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

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
const SPRITES_SRC = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {}, __on: {},
    getContext: () => ({
      fillRect() {}, clearRect() {}, drawImage() {}, save() {}, restore() {},
      translate() {}, scale() {}, beginPath() {}, arc() {}, fill() {},
      stroke() {}, ellipse() {}, moveTo() {}, lineTo() {}, closePath() {},
      fillText() {}, setTransform() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      measureText: () => ({ width: 0 }),
    }),
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

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
  vm.runInContext(SPRITES_SRC, sandbox, { filename: "sprites.js" });
  vm.runInContext(
    "var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES," +
      "UI=window.NERDWARS_ASSETS.UI;", sandbox);
  vm.runInContext(engineSrc || readFileSync(ENGINE_PATH, "utf8"), sandbox,
                  { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return (src) => vm.runInContext(src, sandbox);
}

function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

const SETUP = [
  "var MAIN = STAGE.platforms.find(function (p) { return p.main; });",
  "var UP = ROSTER.autisnick.specials.up;",
  "function seat(gap) {",
  "  projectiles.length = 0; effects.length = 0; freezeFrames = 0;",
  "  fighters.forEach(function (f) {",
  "    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;",
  "    f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;",
  "    f.grounded = true; f.y = MAIN.y; f.stocks = 9; f.health = 100;",
  "    f.eliminated = false; f.poison = 0; f.burn = 0; f.confused = 0;",
  "    f.chicken = false; f.chickenSince = -1; f.sinceHitFrames = 999;",
  "    f.attackFrame = 0; f.chargeTimer = 0; f.rainbowBurst = false;",
  "    f.ai.cooldown = 99999;",
  "  });",
  "  fighters[0].x = MAIN.x + 60; fighters[0].facing = 1;",
  "  for (var i = 1; i < fighters.length; i++) {",
  "    fighters[i].x = MAIN.x + 60 + (gap || 60) * i; fighters[i].facing = -1;",
  "  }",
  "  netplay.active = true;",
  "}",
  "function tick(bits) {",
  "  var pads = [];",
  "  for (var i = 0; i < fighters.length; i++) pads.push(bitsToPad(i === 0 ? (bits || 0) : 0));",
  "  netplay.framePads = pads; step();",
  "}",
  "function shots() {",
  "  return projectiles.filter(function (b) { return b instanceof Rainbow && !b.dead; });",
  "}",
  // A rainbow parked exactly where the probe wants it, rather than thrown and
  // waited on: the arc is data and a probe that waited for it would be
  // asserting about wherever a retune happened to put the ball.
  "function park(owner, x, y, vx, vy) {",
  "  var r = new Rainbow(owner, UP);",
  "  r.x = x; r.y = y; r.vx = vx; r.vy = vy;",
  "  projectiles.push(r); return r;",
  "}",
  /* Over somebody's head, inside the burst disc and CLEAR of the hurtbox,
     travelling away. That is the only placement worthBursting can answer yes
     to: a ball resting inside a man is a ball that is landing on him, which
     the look-ahead deliberately leaves alone. */
  "function parkOver(owner, mark) {",
  "  var b = mark.hurtbox();",
  "  return park(owner, b.x + b.w / 2, b.y - 10, 0, -2);",
  "}",
  "var SPU = 2048, SPECIAL_UP = 2048;",
].join("\n");

async function arena(engineSrc, players) {
  const run = await bootEngine(engineSrc);
  const O = JSON.parse(run("JSON.stringify(ORDER)"));
  const N = O.indexOf("autisnick"), R = O.indexOf("reese");
  assert.ok(N >= 0 && R >= 0, "precondition: both fighters should be in ORDER");
  const n = players || 2;
  const cursor = [N];
  for (let i = 1; i < n; i++) cursor.push((R + i - 1) % O.length);
  run("select.cursor=[" + cursor.join(",") + "]; twoPlayer=" + (n === 2) + ";" +
      " playerCount=" + n + "; humanCount=0; stagePick=0; practice=false; startBattle();");
  run("netplay.active = true;" +
      " for (var i = 0; i < 130; i++) { netplay.framePads = fighters.map(function () { return bitsToPad(0); }); step(); }");
  assert.equal(run("fighters[0].key"), "autisnick",
    "precondition: autisnick should be in seat 0");
  run(SETUP);
  return run;
}

/* ===================================================================== */
/* 1. IT IS A METHOD, NOT A KEY                                          */
/* ===================================================================== */

const KEYS = `(function () {
  seat(60);
  var r = park(fighters[0], fighters[0].x + 40, MAIN.y - 30, 2, -1);
  return JSON.stringify({
    own: Object.keys(r).sort(),
    onProto: Object.prototype.hasOwnProperty.call(Rainbow.prototype, 'worthBursting'),
    onInstance: Object.prototype.hasOwnProperty.call(r, 'worthBursting'),
    inSnapshot: Object.keys(saveSim().projectiles[0]).sort().indexOf('worthBursting') >= 0
  });
})()`;

const TWELVE = ["age", "base", "dead", "hue", "life", "owner",
                "spec", "trail", "vx", "vy", "x", "y"];

function checkKeys(r) {
  assert.equal(r.onProto, true,
    "worthBursting has to be a PROTOTYPE method: restoreSim rebuilds " +
    "projectiles with Object.create and deletes any key the snapshot does " +
    "not carry, so a function assigned in the constructor is a function a " +
    "rewind is entitled to make vanish");
  assert.equal(r.onInstance, false,
    "and not an own key of the shot; it was found on the instance");
  assert.deepEqual(r.own, TWELVE,
    "and the shot's own keys are the identical twelve they were before this " +
    "landed -- the whole rule re-derives from `fighters` and its own position " +
    "every time it is asked, the same question burstRainbows already asks. " +
    "They were: " + r.own.join(", "));
  assert.equal(r.inSnapshot, false,
    "so nothing new is cloned into every snapshot sixty times a second");
}

test("worthBursting is a method on the prototype and adds no field", async () => {
  const run = await arena();
  checkKeys(JSON.parse(run(KEYS)));
});

test("negative control: the same rule assigned in the constructor is an own key", async () => {
  const run = await arena(sabotage(
    "    this.trail = [];\n    this.dead = false;\n  }",
    "    this.trail = [];\n    this.dead = false;\n" +
    "    this.worthBursting = function () { return false; };\n  }"));
  expectToFail(() => checkKeys(JSON.parse(run(KEYS))),
    "a worthBursting written onto the instance must fail the key test");
});

/* ===================================================================== */
/* 2. A BARE spUp BURSTS AND CANNOT CAST                                 */
/* ===================================================================== */

const BARE = `(function () {
  seat(120);
  var me = fighters[0], foe = fighters[1];
  // Just over his head, inside the disc, so the geometry is not in question
  // and the only thing being measured is what the press does.
  parkOver(me, foe);
  var pad = aiDecide(me, foe);
  var before = { state: me.state, mana: +me.mana.toFixed(3), shots: shots().length,
                 foe: +foe.health.toFixed(3) };
  // The AI's OWN pad, delivered. Not a bit pattern through bitsToPad, which
  // derives the special flag from any of the three special bits and so
  // cannot express the thing being pinned here. (No backticks in this probe:
  // it is a template literal and one would end the string.)
  netplay.framePads = fighters.map(function (f, i) { return i === 0 ? pad : bitsToPad(0); });
  step();
  var after = { state: me.state, mana: +me.mana.toFixed(3), shots: shots().length,
                foe: +foe.health.toFixed(3) };
  return JSON.stringify({ before: before, after: after, cost: UP.mana,
    askedFor: !!pad.spUp, alsoCast: !!pad.special });
})()`;

function checkBare(r) {
  assert.equal(r.before.shots, 1, "precondition: there should be a shot in the air");
  assert.equal(r.askedFor, true,
    "the AI has to ask for the second press at all; it did not");
  assert.equal(r.alsoCast, false,
    "and it must ask with `spUp` ALONE. updateFree's entire cast branch is " +
    "gated on pad.special, so a bare spUp is a press that can only ever " +
    "burst -- it cannot come out of the far side as a second rainbow, and " +
    "for a chicken it cannot come out as a beak thrown at the sky. The pad " +
    "carried `special`");
  assert.equal(r.after.shots, 0,
    "the press has to burst the shot it found; " + r.after.shots + " left");
  assert.ok(r.after.foe < r.before.foe,
    "and the burst has to have caught the man it went off over; he went from " +
    r.before.foe + " to " + r.after.foe);
  assert.notEqual(r.after.state, "special",
    "and it may not put him into a move. The AI's pad still carries whatever " +
    "it wanted to do with its feet, so walking is fine and casting is not; " +
    "he was in " + r.after.state);
  assert.ok(r.after.mana >= r.before.mana,
    "and it may not SPEND anything -- a press that also cast would take " +
    r.cost + " off the bar. It went " + r.before.mana + " -> " + r.after.mana);
}

test("the AI asks with a bare spUp, which bursts and cannot cast", async () => {
  const run = await arena();
  checkBare(JSON.parse(run(BARE)));
});

/* The sabotage both this and the chicken test use: the branch reaching for
   `special` the way every other press in aiDecide does. It is the obvious
   thing to write and it is the one thing this press may not do. */
const ALSO_CASTS = [
  "        pad.spUp = true;\n        break;",
  "        pad.spUp = true; pad.special = true;\n        break;",
];

test("negative control: a branch that also sets `special` is not a bare press", async () => {
  const run = await arena(sabotage(ALSO_CASTS[0], ALSO_CASTS[1]));
  expectToFail(() => checkBare(JSON.parse(run(BARE))),
    "a burst press that also carries `special` must fail the bare test");
});

/* ===================================================================== */
/* 3. A BIRD STILL OWNS WHAT IT THREW AS A MAN                           */
/* ===================================================================== */

const BIRD = `(function () {
  seat(150);
  var me = fighters[0], foe = fighters[1];
  parkOver(me, foe);
  me.becomeChicken();
  var before = { shots: shots().length, foe: +foe.health.toFixed(3), state: me.state };
  var pad = aiDecide(me, foe);
  netplay.framePads = fighters.map(function (f, i) { return i === 0 ? pad : bitsToPad(0); });
  step();
  var eggs = projectiles.filter(function (q) { return q.constructor.name === 'Egg'; }).length;
  return JSON.stringify({ before: before, askedFor: !!pad.spUp, alsoCast: !!pad.special,
    shots: shots().length, foe: +foe.health.toFixed(3), state: me.state,
    eggs: eggs, chicken: me.chicken });
})()`;

function checkBird(r) {
  assert.equal(r.chicken, true, "precondition: he should be a bird");
  assert.equal(r.before.shots, 1, "precondition: with his own shot still in the air");
  assert.equal(r.askedFor, true,
    "the AI has to ask for it even as a chicken: the branch sits ABOVE both " +
    "the recovery return and the chicken return, because a Rainbow is owned " +
    "by whoever threw it and what its owner has since become is not its " +
    "business");
  assert.equal(r.shots, 0, "the shot bursts; " + r.shots + " left");
  assert.ok(r.foe < r.before.foe, "and catches him; " + r.before.foe + " -> " + r.foe);
  assert.notEqual(r.state, "special",
    "and the bird does not enter a move. This is the half the bare press " +
    "buys: a chicken's slotFor maps `up` onto a moveset with no up slot, so " +
    "the same press carrying `special` comes out as a peck thrown at the " +
    "sky -- and the rainbowBurst guard in updateFree cannot stop it, because " +
    "that guard only knows about a rainbow and a bird's neutral slot is a " +
    "beak. He was in " + r.state);
  assert.equal(r.eggs, 0, "and no egg is laid by it; " + r.eggs + " in the air");
}

test("a chicken still bursts its own rainbow, and does not peck", async () => {
  const run = await arena();
  checkBird(JSON.parse(run(BIRD)));
});

test("negative control: with `special` on the press the bird pecks at the sky", async () => {
  const run = await arena(sabotage(ALSO_CASTS[0], ALSO_CASTS[1]));
  expectToFail(() => checkBird(JSON.parse(run(BIRD))),
    "a burst press that also carries `special` must put the bird into a move " +
    "and fail the bird test");
});

test("negative control: the branch below the chicken return never fires for a bird", async () => {
  /* Gated on not being a chicken, which is where anybody would put it who was
     thinking about a man rather than about a projectile with an owner. */
  const run = await arena(sabotage(
    "  const upMove = me.def.specials && me.def.specials.up;\n" +
    "  if (upMove && upMove.kind === 'rainbow') {",
    "  const upMove = me.def.specials && me.def.specials.up;\n" +
    "  if (!me.chicken && upMove && upMove.kind === 'rainbow') {"));
  expectToFail(() => checkBird(JSON.parse(run(BIRD))),
    "a burst gated on not being a chicken must fail the bird test");
});

/* ===================================================================== */
/* 4. GEOMETRY, NOT `nearestFoe`                                         */
/* ===================================================================== */

/* Four seats. The shot is parked over seat 2 -- who is NOT the nearest man to
   Nick -- with seat 1 standing between them. If the rule asked aiDecide's own
   idea of a target it would leave this alone; it asks the disc. */
const CROWD = `(function () {
  seat(50);
  var me = fighters[0];
  var mark = fighters[2];
  parkOver(me, mark);
  var before = fighters.map(function (f) { return +f.health.toFixed(3); });
  var pad = aiDecide(me, nearestFoe(me));
  tick(SPU);
  return JSON.stringify({ n: fighters.length, before: before,
    after: fighters.map(function (f) { return +f.health.toFixed(3); }),
    nearest: nearestFoe(me) === fighters[1], askedFor: !!pad.spUp,
    shots: shots().length });
})()`;

function checkCrowd(r) {
  assert.equal(r.n, 4, "precondition: this is the four-player case");
  assert.equal(r.nearest, true,
    "precondition: seat 1 should be the nearest man to Nick, so that seat 2 " +
    "is deliberately not the one a nearestFoe rule would find");
  assert.equal(r.askedFor, true,
    "the rule walks `fighters` and asks the disc, so a shot sitting on ANY " +
    "of them is worth bursting -- it is detonate's own geometry asked one " +
    "frame early, not a second opinion about who the target is");
  assert.equal(r.shots, 0, "the shot goes off; " + r.shots + " left");
  assert.ok(r.after[2] < r.before[2],
    "and it catches the man it was actually sitting on; seat 2 went " +
    r.before[2] + " -> " + r.after[2]);
  assert.equal(r.after[1], r.before[1],
    "and nobody else; seat 1 went " + r.before[1] + " -> " + r.after[1]);
  assert.equal(r.after[3], r.before[3],
    "nor seat 3; " + r.before[3] + " -> " + r.after[3]);
  assert.equal(r.after[0], r.before[0], "nor its owner");
}

test("the rule fires on geometry, not on who the AI thinks the target is", async () => {
  const run = await arena(undefined, 4);
  checkCrowd(JSON.parse(run(CROWD)));
});

test("negative control: a rule that only looks at the nearest man misses the crowd", async () => {
  const run = await arena(sabotage(
    "    for (const f of fighters) {\n" +
    "      if (f === this.owner || f.eliminated) continue;\n" +
    "      if (f.state === 'ko' || f.invulnerable) continue;\n" +
    "      const b = f.hurtbox();\n" +
    "      const nx = clamp(this.x, b.x, b.x + b.w);\n" +
    "      const ny = clamp(this.y, b.y, b.y + b.h);\n" +
    "      const dx = nx - this.x, dy = ny - this.y;\n" +
    "      if (dx * dx + dy * dy > r2) continue;",
    "    for (const f of [nearestFoe(this.owner)]) {\n" +
    "      if (!f || f === this.owner || f.eliminated) continue;\n" +
    "      if (f.state === 'ko' || f.invulnerable) continue;\n" +
    "      const b = f.hurtbox();\n" +
    "      const nx = clamp(this.x, b.x, b.x + b.w);\n" +
    "      const ny = clamp(this.y, b.y, b.y + b.h);\n" +
    "      const dx = nx - this.x, dy = ny - this.y;\n" +
    "      if (dx * dx + dy * dy > r2) continue;"),
    4);
  expectToFail(() => checkCrowd(JSON.parse(run(CROWD))),
    "a rule that only asks about the nearest man must fail the crowd test");
});

/* ===================================================================== */
/* 5. A SHOT THAT IS ABOUT TO LAND IS LEFT ALONE                         */
/* ===================================================================== */

const AHEAD = `(function () {
  seat(40);
  var me = fighters[0], foe = fighters[1];
  var b = foe.hurtbox();
  // Just short of him and travelling into him: the next box overlaps, so the
  // hit is landing on its own and there is nothing to buy by bursting.
  var into = park(me, b.x - 4, b.y + b.h / 2, 4, 0);
  var landing = into.worthBursting();
  // The same ball, same place, heading away. Nothing is landing now.
  into.vx = -4;
  var leaving = into.worthBursting();
  // And the disc has to be the reason, not the direction: put it out of reach
  // heading away and it must still be false.
  into.x = b.x - UP.burst.radius - 60;
  var outOfReach = into.worthBursting();
  return JSON.stringify({ landing: landing, leaving: leaving,
                          outOfReach: outOfReach, radius: UP.burst.radius });
})()`;

function checkAhead(r) {
  assert.equal(r.landing, false,
    "a shot whose very next box overlaps him is already landing, and the " +
    "burst would trade that hit for a hit. The ball is free, so 'is anybody " +
    "in the disc' on its own is a thing you always press rather than a thing " +
    "you sometimes press -- 567 detonations, 40 of them pre-empting a connect " +
    "that was landing anyway, and 0.6 points worse. It said " + r.landing);
  assert.equal(r.leaving, true,
    "the same ball in the same place heading AWAY is exactly what the second " +
    "press is for; it said " + r.leaving);
  assert.equal(r.outOfReach, false,
    "and a ball " + r.radius + " px of radius clear of everybody has nothing " +
    "to go off on; it said " + r.outOfReach);
}

test("the rule refuses a shot that is about to land anyway", async () => {
  const run = await arena();
  checkAhead(JSON.parse(run(AHEAD)));
});

test("negative control: without the look-ahead it bursts a hit that was landing", async () => {
  const run = await arena(sabotage(
    "      const ahead = this.box();\n" +
    "      ahead.x += this.vx; ahead.y += this.vy;\n" +
    "      if (overlap(ahead, b)) continue;\n",
    ""));
  expectToFail(() => checkAhead(JSON.parse(run(AHEAD))),
    "without the one-frame look-ahead the rule must fail the landing test");
});

/* ===================================================================== */
/* 6. AND IT FIRES THROUGH THE REAL AI                                   */
/* ===================================================================== */

/* The test the whole change exists to pass, and the one nobody had. Every
   assertion above drives the rule directly; this one lets two CPUs play and
   counts. detonate() is wrapped rather than re-implemented, so what is
   counted is the engine's own explosion. */
const LADDER = `(function () {
  __b = 0; __hit = 0;
  var _d = Rainbow.prototype.detonate;
  Rainbow.prototype.detonate = function () {
    var was = fighters.map(function (f) { return f.health; });
    var r = _d.call(this);
    if (r) {
      __b++;
      for (var i = 0; i < fighters.length; i++) {
        if (fighters[i].health < was[i]) { __hit++; break; }
      }
    }
    return r;
  };
  netplay.active = false; netplay.framePads = null;
  for (var i = 0; i < 4000; i++) step();
  Rainbow.prototype.detonate = _d;
  return JSON.stringify({ bursts: __b, connected: __hit });
})()`;

function checkLadder(r) {
  assert.ok(r.bursts > 0,
    "a CPU AutisNick has to detonate his own rainbows at all. Before 2.81 " +
    "the figure over 720 seeded matches was 32 by accident out of 1201 " +
    "thrown, and not one of them touched anybody. This run burst " + r.bursts);
  assert.ok(r.connected > 0,
    "and the bursts have to CATCH somebody, which is the half that was a " +
    "measured zero twice -- at 216 matches and again at 720. This run " +
    "connected " + r.connected + " of " + r.bursts);
}

test("a CPU AutisNick presses the second button, and it lands", async () => {
  const run = await arena();
  let bursts = 0, connected = 0;
  /* Several stages rather than one long match: the arc only ever gets within
     burst reach of anybody on about 41% of throws, so a single seat and a
     single floor is a thin sample of a rule that is about geometry. */
  for (const stage of [0, 1, 2]) {
    run("stagePick=" + stage + "; startBattle();");
    const r = JSON.parse(run(LADDER));
    bursts += r.bursts; connected += r.connected;
  }
  checkLadder({ bursts, connected });
});

test("negative control: the unpatched aiDecide never presses it on purpose", async () => {
  const run = await arena(sabotage(
    "  const upMove = me.def.specials && me.def.specials.up;\n" +
    "  if (upMove && upMove.kind === 'rainbow') {",
    "  const upMove = me.def.specials && me.def.specials.up;\n" +
    "  if (false && upMove && upMove.kind === 'rainbow') {"));
  let bursts = 0, connected = 0;
  for (const stage of [0, 1, 2]) {
    run("stagePick=" + stage + "; startBattle();");
    const r = JSON.parse(run(LADDER));
    bursts += r.bursts; connected += r.connected;
  }
  expectToFail(() => checkLadder({ bursts, connected }),
    "with the branch switched off the CPU must fail the ladder test -- it " +
    "burst " + bursts + " times and connected " + connected);
});
