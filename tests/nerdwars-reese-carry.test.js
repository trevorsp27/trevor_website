/* HE CAN TAKE THE FART WITH HIM.
 *
 * 2.81 gave CROP DUST a `carryTo`. Holding the charge and pressing the UP
 * special converts the fart into JITTERS, keeping the step he had paid for,
 * and the cloud comes out of the dash rather than out of him standing still.
 * Before this, that press did not get refused -- refusal implies something
 * looked, and nothing did: updateAttack reads five things off the pad and
 * `spUp` was not one of them, so the button went nowhere with no dash, no
 * tell and no cue.
 *
 * What is pinned here is the whole of the rule and, more importantly, the
 * three things it is NOT allowed to be:
 *
 *   NOT a free extra hitbox. The dash it produces is the dash: 19 live
 *   frames, last live box 102.6 pixels forward, three dead frames in front.
 *   Identical numbers on a carrying dash and a plain one.
 *
 *   NOT two clouds for one charge. The old mid-dash vent is shut for the
 *   whole of a carrying dash, including AFTER the carried cloud has come out,
 *   which is what the third state of `dashFart` exists to hold.
 *
 *   NOT a shot. The cloud is placed where he let go, at the fart's own 0.6,
 *   and does not inherit the dash's 5.4. A cloud is a place.
 *
 * The damage relationship between the three burp aims is pinned in
 * nerdwars-reese-reach.test.js, beside the boxes it belongs to.
 *
 * The engine source is loaded directly, the way the other Reese files do:
 * `projectiles`, Cloud, stinkOf, saveSim and Fighter.carryDash are internals.
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

/* Reese in seat 0 on the flat stage, the other man parked out of reach with
   his own AI switched off, and a `seat()` that puts every field this file
   reads back to a known value -- including chargeTimer and attackFrame, which
   setState does not touch and which leak from one probe into the next. */
async function arena(engineSrc) {
  const run = await bootEngine(engineSrc);
  const O = JSON.parse(run("JSON.stringify(ORDER)"));
  const R = O.indexOf("reese"), H = O.indexOf("houston");
  assert.ok(R >= 0 && H >= 0, "precondition: both fighters should be in ORDER");
  run("select.cursor=[" + R + "," + H + "]; twoPlayer=true; playerCount=2;" +
      " humanCount=0; stagePick=0; practice=false; startBattle();");
  run("netplay.active = true;" +
      " for (var i = 0; i < 130; i++) { netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step(); }");
  assert.equal(run("fighters[0].key"), "reese",
    "precondition: reese should be in seat 0");
  run([
    "var MAIN = STAGE.platforms.find(function (p) { return p.main; });",
    "var DOWN = ROSTER.reese.specials.down, UP = ROSTER.reese.specials.up;",
    "function park() {",
    "  var o = fighters[1];",
    "  o.setState('idle'); o.x = MAIN.x + 280; o.y = MAIN.y; o.vx = 0; o.vy = 0;",
    "  o.grounded = true; o.health = 100; o.hitstun = 0; o.hitstop = 0;",
    "  o.stocks = 9; o.invuln = 99999; o.mana = 0; o.ai.cooldown = 99999;",
    "}",
    "function seat() {",
    "  projectiles.length = 0; effects.length = 0; freezeFrames = 0;",
    "  var f = fighters[0];",
    "  f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;",
    "  f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;",
    "  f.grounded = true; f.y = MAIN.y; f.x = MAIN.x + 40; f.facing = 1;",
    "  f.stocks = 9; f.health = 100; f.eliminated = false; f.poison = 0;",
    "  f.burn = 0; f.confused = 0; f.sinceHitFrames = 999; f.slick = 0;",
    "  f.chargeTimer = 0; f.attackFrame = 0; f.dashFart = -1;",
    "  f.dashGassed = false; f.manaDenied = 0; f.specialSpawned = false;",
    "  f.chicken = false; f.chickenSince = -1;",
    "  netplay.active = true; park();",
    "}",
    "function tick(a) { park(); netplay.framePads = [bitsToPad(a || 0), bitsToPad(0)]; step(); park(); }",
    "function clouds() {",
    "  return projectiles.filter(function (b) { return b instanceof Cloud && !b.dead; });",
    "}",
    // The fart button, the fart button HELD, and the dash button. spDown and
    // spUp cannot be or-ed for a cast -- slotFor reads spUp first -- but the
    // HOLD bit is a separate key and is meant to be held across the press.
    "var SPD = 1024, HOLD = 8192, SPU = 2048;",
    // Cast the fart and hold it until chargeTimer reads `n`, then report.
    "function chargeTo(n) {",
    "  seat(); tick(SPD);",
    "  var g = 0;",
    "  while (fighters[0].chargeTimer < n && g++ < 400) tick(HOLD);",
    "  return fighters[0];",
    "}",
  ].join("\n"));
  return run;
}

/* ===================================================================== */
/* 1. WHEN THE PRESS IS HEARD                                            */
/* ===================================================================== */

const WINDOW = `(function () {
  var out = { early: [], atStartup: null, afterResolve: null, committed: 0,
              drain: DOWN.charge.drain, jitters: UP.mana };
  var f;
  // Every frame from the cast up to (but not including) the one the charge
  // engages on. Nothing may happen on any of them.
  for (var k = 1; k <= DOWN.startup; k++) {
    seat(); tick(SPD);
    for (var i = 1; i < k; i++) tick(HOLD);
    var before = { af: f ? 0 : 0, mana: fighters[0].mana, af2: fighters[0].attackFrame };
    tick(SPU | HOLD);
    out.early.push({ af: before.af2, slot: fighters[0].specialSlot,
                     dashFart: fighters[0].dashFart,
                     spent: +(before.mana - fighters[0].mana).toFixed(2) });
  }
  // The first frame the charge has actually counted.
  f = chargeTo(1);
  var m0 = f.mana, af0 = f.attackFrame;
  tick(SPU | HOLD);
  out.atStartup = { af: af0, slot: f.specialSlot, dashFart: f.dashFart,
                    spent: +(m0 - f.mana).toFixed(2), jittersMana: UP.mana };

  // And the far end: hold to the cap, let the cloud resolve, then press.
  f = chargeTo(DOWN.charge.hold);
  tick(HOLD);                                   // the pin lets go, cloud spawns
  var m1 = f.mana;
  tick(SPU | HOLD);
  out.afterResolve = { spawned: f.specialSpawned, slot: f.specialSlot,
                       dashFart: f.dashFart, spent: +(m1 - f.mana).toFixed(2) };
  var n = 0;
  while (f.state === 'special' && n++ < 300) tick(HOLD);
  out.tail = n;
  out.endedIdle = f.state;
  out.committed = DOWN.startup + DOWN.charge.hold + DOWN.active + DOWN.recovery;
  return JSON.stringify(out);
})()`;

function checkWindow(r) {
  r.early.forEach((e) => {
    assert.equal(e.slot, "down",
      "the dash may not be taken before the charge has actually engaged -- " +
      "the same rule the mid-dash vent keeps, that you cannot leave a fart " +
      "before the fart has begun. At attackFrame " + e.af + " the press moved " +
      "him to the " + e.slot + " slot");
    assert.equal(e.dashFart, -1,
      "and nothing may be carried out of a frame the press was refused on; " +
      "dashFart was " + e.dashFart + " at attackFrame " + e.af);
    /* A refused press does not BUY anything. The bar may still move on these
       frames by up to the charge's own `drain` -- holding a fart runs the
       meter backwards at 0.8 a frame whatever else is happening -- so what is
       asserted is that nothing anywhere near JITTERS' price came off. */
    assert.ok(e.spent <= r.drain + 1e-9,
      "and a refused press buys nothing: the most the bar may move on that " +
      "frame is the charge's own drain of " + r.drain + ", and JITTERS costs " +
      r.jitters + ". It spent " + e.spent + " at attackFrame " + e.af);
  });

  assert.equal(r.atStartup.slot, "up",
    "the frame the charge first counts is the frame the press is heard; it " +
    "left him in the " + r.atStartup.slot + " slot");
  assert.ok(r.atStartup.dashFart >= 0,
    "and the fart goes with him; dashFart was " + r.atStartup.dashFart);
  assert.ok(Math.abs(r.atStartup.spent - r.atStartup.jittersMana) < 1e-9,
    "and it costs JITTERS' own price in full, " + r.atStartup.jittersMana +
    "; it spent " + r.atStartup.spent);

  /* THE FAR END. `specialSpawned` is the shutter: once the cloud has come out
     of him standing there, the charge is over and there is nothing left to
     carry. That is one frame past the hold cap, because the cap only releases
     the pin -- the cloud resolves on the frame after. So the LAST carryable
     frame is the frame the pin lets go, which is the one that carries a full
     RANCID, and that is deliberate: the trail is tinted for three clouds and
     the third one has to be reachable. */
  assert.equal(r.afterResolve.spawned, true,
    "precondition: holding past the cap must let the cloud resolve itself");
  assert.equal(r.afterResolve.slot, "down",
    "and once it has, the press is refused: there is no charge left to carry. " +
    "It left him in the " + r.afterResolve.slot + " slot");
  assert.equal(r.afterResolve.dashFart, -1,
    "carrying nothing; dashFart was " + r.afterResolve.dashFart);
  assert.equal(r.afterResolve.spent, 0,
    "and costing nothing; it spent " + r.afterResolve.spent + " mana");
  assert.equal(r.endedIdle, "idle",
    "and the refused press must not strand him: he finishes the fart he was " +
    "holding and stands up. He ended in " + r.endedIdle);
  assert.ok(r.tail <= DOWN_TAIL,
    "on the move's own tail, " + DOWN_TAIL + " frames of active plus recovery " +
    "-- a full charge is " + r.committed + " frames committed end to end, " +
    "which is what makes it the most expensive fart in the game. It took " + r.tail);
}

/* CROP DUST's own active + recovery. Spelled out here so the assertion above
   reads as arithmetic rather than as a number somebody timed. */
const DOWN_TAIL = 4 + 14;

test("the carry opens when the charge does and shuts when the cloud resolves", async () => {
  const run = await arena();
  checkWindow(JSON.parse(run(WINDOW)));
});

test("negative control: without the counted-frame guard he carries a fart of nothing", async () => {
  /* The two guards in front of this window overlap on purpose, and only one
     of them can be taken away and seen. `chargeTimer` cannot be positive
     before `attackFrame` has reached `startup` -- the pin is what counts it --
     so removing the startup test alone changes nothing observable, and it is
     kept because it states the rule rather than because it is the line doing
     the work. Removing the counted-frame test IS visible: the press then
     lands on the frame the pin engages, before it has counted anything, and
     carries a charge of zero out of a fart that never happened. */
  const run = await arena(sabotage(
    "    if (!(this.chargeTimer > 0)) return false;\n",
    ""));
  expectToFail(() => checkWindow(JSON.parse(run(WINDOW))),
    "with the counted-frame guard gone the press must be heard on the pin " +
    "frame itself and fail the window test");
});

test("negative control: without the specialSpawned guard the window never shuts", async () => {
  const run = await arena(sabotage(
    "    if (this.specialSpawned) return false;\n    if (!(this.chargeTimer > 0)) return false;\n",
    "    if (!(this.chargeTimer > 0)) return false;\n"));
  expectToFail(() => checkWindow(JSON.parse(run(WINDOW))),
    "with the spawned guard gone a cloud he has already let go of must still " +
    "be carryable, and fail the window test");
});

/* ===================================================================== */
/* 2. ONE CLOUD PER FART                                                 */
/* ===================================================================== */

const ONE_CLOUD = `(function () {
  var f = chargeTo(40);
  var step = f.chargeTimer;
  tick(SPU | HOLD);
  var carried = f.dashFart, n = 0;
  // Mash the fart button all the way down the dash. The old vent is the one
  // that used to answer this, and it re-arms on the dash's own startup frame.
  while (f.state === 'special' && n++ < 60) tick((n % 2 ? SPD : 0) | HOLD);
  var cs = clouds();
  return JSON.stringify({ step: step, carried: carried, dashFrames: n,
    clouds: cs.length, names: cs.map(function (c) { return c.spec.stinkName; }),
    want: stinkOf(DOWN, step).stinkName });
})()`;

function checkOneCloud(r) {
  assert.ok(r.carried >= 0, "precondition: the press should have been taken; " +
    "dashFart was " + r.carried);
  assert.equal(r.clouds, 1,
    "one charge is one cloud, however many times the fart button is hit on " +
    "the way down the dash. The mid-dash vent re-arms itself on the dash's " +
    "own startup frame, so without the dashFart clause on it the release and " +
    "a vent are two clouds for one charge. There were " + r.clouds + ": " +
    r.names.join(", "));
  assert.equal(r.names[0], r.want,
    "and it is the cloud he paid for -- chargeTimer " + r.step + " is " +
    r.want + "; it came out " + r.names[0]);
}

test("one charge is one cloud, even mashing the fart button through the dash", async () => {
  const run = await arena();
  checkOneCloud(JSON.parse(run(ONE_CLOUD)));
});

test("negative control: -1 doing double duty lays two clouds for one fart", async () => {
  /* This is the bug that shipped into the first draft, and it is the reason
     `dashFart` has a third state rather than two. */
  const run = await arena(sabotage(
    "        !this.dashGassed && this.dashFart === -1 &&",
    "        !this.dashGassed && this.dashFart < 0 &&"));
  expectToFail(() => checkOneCloud(JSON.parse(run(ONE_CLOUD))),
    "with the spent state folded back into -1 the vent must re-open behind " +
    "the release and fail the one-cloud test");
});

/* ===================================================================== */
/* 3. THE CHARGE FREEZES, AND CASHES OUT AT THE STEP HE PRESSED AT       */
/* ===================================================================== */

const FREEZE = `(function () {
  var f = chargeTo(43);
  var at = f.chargeTimer;
  tick(SPU | HOLD);
  var during = [];
  var n = 0;
  while (f.state === 'special' && n++ < 60) { tick(HOLD); during.push(f.chargeTimer); }
  var cs = clouds();
  return JSON.stringify({ at: at, carried: f.dashFart === -2 ? at : f.dashFart,
    during: during, name: cs.length ? cs[0].spec.stinkName : null,
    want: stinkOf(DOWN, at).stinkName, hold: DOWN.charge.hold });
})()`;

function checkFreeze(r) {
  assert.ok(r.during.length > 4, "precondition: the dash should have run for " +
    "several frames; it ran " + r.during.length);
  assert.ok(r.during.every((v) => v === r.at),
    "the charge FREEZES the moment he dashes, with no code written for it: " +
    "JITTERS carries no `charge`, so the pin branch does not run and neither " +
    "the counter nor the 0.8-a-frame drain advances. Standing still buys " +
    "RANCID and dashing cashes out, and you cannot do both. It read " +
    r.at + " at the press and " + r.during.join(",") + " down the dash");
  assert.equal(r.name, r.want,
    "and what comes out is the step he had paid for at the moment of the " +
    "press -- chargeTimer " + r.at + " of " + r.hold + " is " + r.want +
    "; the cloud was " + r.name);
}

test("the charge freezes across the dash and pays out what he pressed at", async () => {
  const run = await arena();
  checkFreeze(JSON.parse(run(FREEZE)));
});

test("negative control: a carry that forgets the step always pays the weakest cloud", async () => {
  const run = await arena(sabotage(
    "    // AFTER the call: startAttack clears this to -1, the way it does for\n" +
    "    // every other way into a move.\n    this.dashFart = step;\n",
    "    this.dashFart = 0;\n"));
  expectToFail(() => checkFreeze(JSON.parse(run(FREEZE))),
    "a carry that drops the charge step must fail the payout test");
});

/* ===================================================================== */
/* 4. NOT A FREE EXTRA HITBOX                                            */
/* ===================================================================== */

/* The platforms test's JITTERS probe, pointed at a CARRYING dash. Whatever it
   says there it has to say here: the dash he gets out of a fart is the dash. */
const DASH_BOX = (carrying) => `(function () {
  seat();
  var f = fighters[0];
  ${carrying ? "tick(SPD); var g = 0; while (f.chargeTimer < 20 && g++ < 200) tick(HOLD);" : ""}
  tick(SPU${carrying ? " | HOLD" : ""});
  var rows = [], x0 = f.x;
  rows.push([f.state === 'special' && f.hitbox() ? 1 : 0, Math.abs(f.vx), 0]);
  for (var i = 1; i < 26; i++) {
    tick(${carrying ? "HOLD" : "0"});
    rows.push([f.state === 'special' && f.hitbox() ? 1 : 0,
               +Math.abs(f.vx).toFixed(4), +(f.x - x0).toFixed(2)]);
  }
  var live = 0, lastLive = -1;
  rows.forEach(function (r, i) { if (r[0]) { live++; lastLive = i; } });
  var dead = rows.slice(0, lastLive).filter(function (r) { return !r[0]; }).length;
  return JSON.stringify({ live: live, lastLive: lastLive,
    reach: rows[lastLive][2], vxAtLast: rows[lastLive][1], deadBefore: dead,
    speed: UP.speed, total: UP.startup + UP.active + UP.recovery,
    dashFart: f.dashFart });
})()`;

function checkDashBox(plain, carried) {
  assert.equal(plain.live, plain.total - 3,
    "precondition: a plain JITTERS is live for every frame from the first " +
    "active one to the last; it was live for " + plain.live);
  assert.ok(carried.dashFart !== -1,
    "precondition: the carrying run should actually have carried something");

  assert.equal(carried.live, plain.live,
    "a dash he arrived at out of a fart is the SAME dash -- this may not be " +
    "a free extra hitbox bolted to the front of a cloud. Plain " + plain.live +
    " live frames, carrying " + carried.live);
  assert.equal(carried.deadBefore, plain.deadBefore,
    "with the same dead startup in front of it: plain " + plain.deadBefore +
    ", carrying " + carried.deadBefore);
  assert.ok(Math.abs(carried.reach - plain.reach) < 0.01,
    "and it covers the same ground under a live box: plain " +
    plain.reach.toFixed(1) + " px, carrying " + carried.reach.toFixed(1));
  assert.ok(carried.vxAtLast >= carried.speed - 0.01,
    "and it is still travelling at dash speed on its last live frame; vx " +
    carried.vxAtLast);
}

test("the dash out of a fart is exactly the dash", async () => {
  const run = await arena();
  checkDashBox(JSON.parse(run(DASH_BOX(false))), JSON.parse(run(DASH_BOX(true))));
});

test("negative control: a box tied to `active` fails it on the carrying dash too", async () => {
  const run = await arena(sabotage("(s.hitActive || s.active)", "(s.active)"));
  expectToFail(
    () => checkDashBox(JSON.parse(run(DASH_BOX(false))), JSON.parse(run(DASH_BOX(true)))),
    "with the box back on `active` the carrying dash must fail the box test");
});

/* ===================================================================== */
/* 5. WHERE THE CLOUD LANDS, AND HOW FAST IT IS GOING                    */
/* ===================================================================== */

const LETGO = (at) => `(function () {
  var f = chargeTo(43);
  tick(SPU | HOLD);
  for (var i = 0; i < ${at}; i++) tick(HOLD);
  tick(0);
  var cs = clouds();
  return JSON.stringify({ n: cs.length,
    x: cs.length ? +cs[0].x.toFixed(3) : null,
    vx: cs.length ? +cs[0].vx.toFixed(4) : null,
    manX: +f.x.toFixed(3), dashFart: f.dashFart,
    fartSpeed: DOWN.speed, dashSpeed: UP.speed });
})()`;

function checkLetGo(early, late) {
  assert.equal(early.n, 1, "letting go on dash frame 3 has to lay a cloud; it laid " + early.n);
  assert.equal(late.n, 1, "and so does letting go on dash frame 9; it laid " + late.n);
  assert.equal(early.dashFart, -2, "and the carry is spent, not re-armed; it read " + early.dashFart);

  const gap = late.x - early.x;
  assert.ok(gap > 25 && gap < 40,
    "WHERE he lets go is the whole of the decision: six more frames of dash " +
    "at 5.4 is about thirty-two pixels of stage, and the two clouds have to " +
    "land that far apart or the release frame is decoration. They landed " +
    gap.toFixed(1) + " apart");

  /* A cloud is a PLACE, not a shot. Cloud's constructor gives it
     facing * spec.speed and nothing of his own velocity, so the fart he was
     doing 5.4 when he dropped sits still and stinks. */
  const oneFrame = early.fartSpeed * 0.86;   // spec.friction, one frame later
  assert.ok(Math.abs(early.vx - oneFrame) < 0.01,
    "and it comes out at the fart's own " + early.fartSpeed + " a frame, not " +
    "at the dash's " + early.dashSpeed + ". A cloud that inherited the dash " +
    "would be a gas projectile, which is a different move. One frame of its " +
    "own friction after the spawn it should read " + oneFrame.toFixed(3) +
    "; it read " + early.vx);
}

test("the cloud lands where he let go, at the fart's own speed", async () => {
  const run = await arena();
  checkLetGo(JSON.parse(run(LETGO(3))), JSON.parse(run(LETGO(9))));
});

test("negative control: a release that only ever fires at the end lands both in one place", async () => {
  const run = await arena(sabotage(
    "      const letGo = !!pad && !pad.holdDown;\n",
    "      const letGo = false;\n"));
  expectToFail(() => checkLetGo(JSON.parse(run(LETGO(3))), JSON.parse(run(LETGO(9)))),
    "with the let-go half removed both clouds must land at the end of the " +
    "dash and fail the placement test");
});

/* ===================================================================== */
/* 6. REFUSED, AND SAID SO                                               */
/* ===================================================================== */

const BROKE = `(function () {
  var f = chargeTo(20);
  f.mana = 5; f.manaDenied = 0;
  var ct0 = f.chargeTimer;
  tick(SPU | HOLD);
  var onRefusal = { slot: f.specialSlot, state: f.state, dashFart: f.dashFart,
                    denied: f.manaDenied, mana: +f.mana.toFixed(2), ct: f.chargeTimer };
  tick(HOLD); var a = f.chargeTimer;
  tick(HOLD); var b = f.chargeTimer;
  return JSON.stringify({ ct0: ct0, onRefusal: onRefusal, after: [a, b],
                          drain: DOWN.charge.drain, jittersMana: UP.mana });
})()`;

function checkBroke(r) {
  assert.equal(r.onRefusal.slot, "down",
    "a press he cannot afford must leave him in the fart he is holding, not " +
    "in a dash he did not pay for. He was in the " + r.onRefusal.slot + " slot");
  assert.equal(r.onRefusal.state, "special",
    "and still in the move; he was " + r.onRefusal.state);
  assert.equal(r.onRefusal.dashFart, -1,
    "carrying nothing; dashFart was " + r.onRefusal.dashFart);
  /* HE DID NOT BUY THE DASH, which is the assertion -- not that the frame
     froze. The refusal returns FALSE, so the rest of updateAttack still runs
     and the fart he is still holding still charges him its own 0.8 for the
     frame. Asserted as "he paid the charge and not the dash" rather than as
     a literal 5, because the literal was measuring a bug: the first draft
     returned true, and true means "I have taken this frame" to a caller that
     is one line at the top of updateAttack -- so it skipped the charge pin,
     the vent, the cap AND the move's own exit. A pad reporting spUp on
     consecutive frames locked him in CROP DUST for as long as it was held,
     attackFrame past three thousand with mana stuck at 5.0 and neither
     draining nor refilling. Nothing the engine itself builds can press spUp
     twice running -- readPad, the gamepad path and bitsToPad all make it an
     edge -- so it was never reachable in a real game. It was still the wrong
     word, and "refused" has to mean the frame carries on. */
  assert.ok(Math.abs(r.onRefusal.mana - (5 - r.drain)) < 1e-9,
    "a refusal must not take JITTERS' " + r.jittersMana + ". He should have " +
    "paid only the fart's own " + r.drain + " for the frame he spent holding " +
    "it, leaving " + (5 - r.drain) + "; he had " + r.onRefusal.mana);
  assert.equal(r.onRefusal.denied, 18,
    "but it has to SAY so, with the same manaDenied tell an out-of-mana cast " +
    "gets in updateFree -- the whole complaint this feature answers is a " +
    "button that went nowhere with no evidence the game had noticed. It was " +
    r.onRefusal.denied);
  assert.ok(r.after[0] > r.onRefusal.ct && r.after[1] > r.after[0],
    "and the charge is left RUNNING, so he can keep holding it and ask " +
    "again: the press was a request to leave, not a request to stop. It " +
    "read " + r.onRefusal.ct + " then " + r.after.join(",") + " while he held on");
}

test("out of mana the carry is refused, says so, and leaves the charge running", async () => {
  const run = await arena();
  checkBroke(JSON.parse(run(BROKE)));
});

test("negative control: a carry with no price check takes a dash he cannot pay for", async () => {
  const run = await arena(sabotage(
    "    if (this.mana < to.mana) { this.manaDenied = 18; return false; }\n",
    ""));
  expectToFail(() => checkBroke(JSON.parse(run(BROKE))),
    "with the price check gone an empty bar must still buy a dash and fail " +
    "the refusal test");
});

/* ===================================================================== */
/* 7. IT SURVIVES A REWIND                                               */
/* ===================================================================== */

const ROLLBACK = `(function () {
  /* THE DECLARATION, asked of a fighter who has never done anything. This is
     the half a rollback probe cannot see on its own: startAttack writes
     dashFart for every move, so by the time anybody has cast a fart the key
     exists whether or not the constructor put it there, and a snapshot taken
     after that carries it either way. The failure it protects against is a
     rewind reaching back PAST his first move of the match, and the cheapest
     way to ask about that is to rebuild the fighters and look. */
  startBattle();
  var fresh = Object.prototype.hasOwnProperty.call(fighters[0], 'dashFart');
  var freshValue = fighters[0].dashFart;
  var freshSnap = Object.prototype.hasOwnProperty.call(saveSim().fighters[0], 'dashFart');

  var f = chargeTo(30);
  var snap = saveSim();
  var inSnap = Object.prototype.hasOwnProperty.call(snap.fighters[0], 'dashFart');
  var pads = [SPU | HOLD, HOLD, HOLD, HOLD, HOLD, HOLD, HOLD, HOLD,
              0, 0, 0, 0, 0, 0];
  function play() { for (var i = 0; i < pads.length; i++) tick(pads[i]); return stateHash(); }
  var h1 = play(), end1 = f.dashFart, c1 = clouds().length;
  restoreSim(snap);
  var hasAfterRestore = Object.prototype.hasOwnProperty.call(f, 'dashFart');
  var restored = f.dashFart;
  var h2 = play(), end2 = f.dashFart, c2 = clouds().length;
  return JSON.stringify({ fresh: fresh, freshValue: freshValue, freshSnap: freshSnap,
    inSnap: inSnap, hasAfterRestore: hasAfterRestore,
    restored: restored, h1: h1, h2: h2, end1: end1, end2: end2,
    clouds1: c1, clouds2: c2 });
})()`;

function checkRollback(r) {
  assert.equal(r.fresh, true,
    "`dashFart` has to be declared in the Fighter CONSTRUCTOR, so a fighter " +
    "who has not yet thrown a punch already has it: restoreSim deletes any " +
    "key a snapshot does not carry, and a field first written by startAttack " +
    "works perfectly offline and vanishes on the first online rewind that " +
    "reaches back past his first move of the match");
  assert.equal(r.freshValue, -1,
    "and it starts at -1, which is the value that leaves the mid-dash vent " +
    "open; it started at " + r.freshValue);
  assert.equal(r.freshSnap, true,
    "and a snapshot taken before he has acted has to carry it too");
  assert.equal(r.inSnap, true,
    "as does one taken in the middle of a charge");
  assert.equal(r.hasAfterRestore, true,
    "and it has to still be there after a restore; it was deleted");
  assert.equal(r.end1, -2,
    "precondition: the replay should carry a fart and let it go; it ended " + r.end1);
  assert.equal(r.clouds1, 1, "precondition: and lay exactly one cloud");
  assert.equal(r.h2, r.h1,
    "and a rewind across the carry frame has to replay bit-identically. " +
    "State hash " + r.h1 + " first time, " + r.h2 + " after the restore");
  assert.equal(r.end2, r.end1, "with the same carry state at the end");
  assert.equal(r.clouds2, r.clouds1, "and the same one cloud");
}

test("the carry survives a rollback across the frame it happens on", async () => {
  const run = await arena();
  checkRollback(JSON.parse(run(ROLLBACK)));
});

test("negative control: a field assigned outside the constructor vanishes on a rewind", async () => {
  const run = await arena(sabotage(
    "    this.dashFart = -1;\n    this.walkAnim = 0;\n",
    "    this.walkAnim = 0;\n"));
  expectToFail(() => checkRollback(JSON.parse(run(ROLLBACK))),
    "a dashFart that is not a constructor field must fail the snapshot test");
});

/* ===================================================================== */
/* 8. A BIRD IS NOT CARRYING ANYTHING                                    */
/* ===================================================================== */

const CHICKEN = `(function () {
  var f = chargeTo(40);
  tick(SPU | HOLD);
  var carried = f.dashFart;
  f.becomeChicken();
  var right = clouds().length;
  for (var i = 0; i < 40; i++) tick(HOLD);
  return JSON.stringify({ carried: carried, dashFart: f.dashFart,
    chicken: f.chicken, right: right, later: clouds().length });
})()`;

function checkChicken(r) {
  assert.ok(r.carried >= 0, "precondition: he should have been carrying one");
  assert.equal(r.chicken, true, "precondition: and should now be a bird");
  assert.equal(r.dashFart, -1,
    "a carried fart is a thing he is CARRYING rather than a thing he has put " +
    "into the world, so it goes with the sword and the buff and the charge -- " +
    "dashFart was " + r.dashFart);
  assert.equal(r.right, 0, "and nothing comes out on the way; " + r.right + " clouds");
  assert.equal(r.later, 0,
    "and nothing comes out later either; " + r.later + " clouds forty frames on");
}

test("a man turned into a chicken mid-carry is not holding a fart", async () => {
  const run = await arena();
  checkChicken(JSON.parse(run(CHICKEN)));
});

test("negative control: a transformation that forgets it leaves a fart on a bird", async () => {
  /* Just the carry line out of becomeChicken. It used to sit directly above
     the releaseGrab call; 2.81 put Cobeus' bed reset between the two, so
     the needle is the line plus the start of the comment that now follows
     it, and the replacement leaves that comment alone. */
  const run = await arena(sabotage(
    "    this.dashFart = -1;\n    /* AND THE BED IS OVER",
    "    /* AND THE BED IS OVER"));
  expectToFail(() => checkChicken(JSON.parse(run(CHICKEN))),
    "a becomeChicken that does not clear the carry must fail the bird test");
});

/* ===================================================================== */
/* 9. AND IT WORKS IN THE AIR                                            */
/* ===================================================================== */

const AIR = `(function () {
  seat();
  var f = fighters[0];
  f.grounded = false; f.y = MAIN.y - 70; f.vy = 0;
  tick(SPD);
  var g = 0;
  while (f.chargeTimer < 6 && g++ < 40) { f.grounded = false; tick(HOLD); }
  var ct = f.chargeTimer;
  f.grounded = false;
  tick(SPU | HOLD);
  return JSON.stringify({ ct: ct, slot: f.specialSlot, dashFart: f.dashFart,
                          grounded: f.grounded });
})()`;

function checkAir(r) {
  assert.ok(r.ct > 0, "precondition: the charge should have run in the air; it read " + r.ct);
  assert.equal(r.grounded, false, "precondition: and he should still be off the floor");
  assert.equal(r.slot, "up",
    "THE AIR CARRY IS LEGAL, and there is no grounded check anywhere in it. " +
    "He can already do this in two presses -- cast, land, cast -- so all the " +
    "carry saves him is twenty-two frames, and a rule the player cannot see " +
    "refusing a press the player can see is the exact failure the bakery's " +
    "wake flag is written up for. He ended in the " + r.slot + " slot");
  assert.ok(r.dashFart >= 0, "carrying the charge with him; it read " + r.dashFart);
}

test("the carry works in the air, because nothing looks at the floor", async () => {
  const run = await arena();
  checkAir(JSON.parse(run(AIR)));
});

test("negative control: a grounded check the player cannot see refuses it", async () => {
  const run = await arena(sabotage(
    "    if (this.state !== 'special') return false;\n",
    "    if (this.state !== 'special' || !this.grounded) return false;\n"));
  expectToFail(() => checkAir(JSON.parse(run(AIR))),
    "a carry gated on the ground must fail the air test");
});
