/* FDR'S NEW DEAL -- Houston's ult, as 2.75 added it.
 *
 * He breaks ground and a stretch of highway paves itself in where he is
 * standing, wide at his feet and narrowing away to a vanishing point. Then it
 * opens to traffic: three cars come down it out of the distance, each a few
 * pixels tall when it appears and bigger than he is when it arrives. He is
 * free again long before any of that happens.
 *
 * WHY IT NEEDS ITS OWN FILE. Nothing else in this game is drawn in
 * perspective, and every rule the move has is a consequence of that one fact
 * rather than a number somebody typed:
 *
 *   A car's SIZE, the road ROW its wheels are on, and how far it sits off the
 *   white line are all one number read three ways. Any edit that breaks that
 *   still draws a car, still moves it down the screen, and still hits people
 *   -- it just hits them somewhere other than where it is painted, which is
 *   the one bug in a fighting game that nobody can diagnose from playing it.
 *
 *   The road's perspective is MEASURED by build.py off Kel's drawing and
 *   shipped as three numbers. If the engine ever grows its own copy of them,
 *   or reads them off a half-decoded Image, the two disagree by a pixel at a
 *   time and the cars drift out of their lanes over a release nobody
 *   attributes to the build.
 *
 *   The stripe down the middle of the road is the whole counterplay, and it
 *   is PAINT: Kel drew a dashed white line, and standing on it is the answer.
 *   A retune that widens the car or moves the lanes takes that answer away
 *   silently -- the move looks identical and simply stops being dodgeable.
 *
 *   And the launch is sideways, away from the car, which is the difference
 *   between "three seconds of floor nobody can use" and a stage-edge kill.
 *   Flip its sign and every car herds people back toward the middle, which
 *   plays as the move being mysteriously weak.
 *
 * Everything below drives the move through the real input path -- a pad bit,
 * step(), and then reading what actually happened -- and every test has a
 * NEGATIVE CONTROL beside it: the same checker run against a copy of the
 * engine with ONE line changed in memory, asserting that the check then
 * fails. The mutated copies live in a string and a fresh vm and are never
 * written anywhere.
 *
 * The engine source is loaded directly, the way nerdwars-squalls.test.js
 * does, because none of this is reachable through NerdWars.fighters: ROSTER,
 * `projectiles` and the Roadway's own clock are all internals.
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
   interleaving different on every run. */
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

/* A context that REMEMBERS its draw calls, drawImage included.

   The usual stub in this suite throws every call away, which is fine for a
   test that only wants the engine not to crash. Two tests here are about what
   is painted and in what order -- the road growing, and a far car going down
   before the stage -- so this one keeps them. */
function recordingContext(log) {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "drawImage") {
        return (...a) => {
          const o = { img: a[0] };
          if (a.length === 9) {
            o.sy = a[2]; o.sh = a[4]; o.dy = a[6]; o.dw = a[7]; o.dh = a[8]; o.dx = a[5];
          } else {
            o.sy = 0; o.sh = -1; o.dx = a[1]; o.dy = a[2];
            o.dw = a.length === 5 ? a[3] : -1; o.dh = a.length === 5 ? a[4] : -1;
          }
          log.push(o);
        };
      }
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return () => ({ addColorStop() {} });
      }
      if (key === "measureText") return () => ({ width: 0 });
      if (key === "canvas") return { width: 320, height: 180 };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {},
    getContext: () => recordingContext([]),
    __on: {},
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

/* Takes the engine SOURCE rather than always reading it off disk, so a
   negative control can boot a mutated copy in a fresh vm. */
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
  return { run: (src) => vm.runInContext(src, sandbox), sandbox };
}

/* One line of the engine, changed in memory. Both halves are asserted: a
   needle that is missing, or is there twice, makes a control that silently
   mutates nothing or mutates the wrong thing, which is exactly the failure a
   negative control exists to rule out. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* The other half of a negative control: the SAME checker, and it has to
   throw an assertion. Anything else is a broken checker rather than a failed
   test, and is let through so it shows up as itself. */
function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

const ULT = 256;

/* Houston in seat 0 on the BEACH, which is the stage with no platform over
   the middle of it -- so a road built at centre stage is the whole road and
   nothing here is accidentally measuring an occlusion. */
async function arena(foe, stage) {
  const booted = await bootEngine(arena.engine);
  arena.engine = undefined;
  const { run } = booted;
  const O = JSON.parse(run("JSON.stringify(ORDER)"));
  const H = O.indexOf("houston");
  assert.ok(H >= 0, "precondition: houston should be in ORDER");
  run(`select.cursor=[${H}, ${O.indexOf(foe)}]; twoPlayer=true; playerCount=2;` +
      ` humanCount=0; stagePick=${stage === undefined ? 3 : stage}; startBattle();`);
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].key"), "houston",
    "precondition: houston should be in seat 0");
  return booted;
}
const withEngine = (src) => { arena.engine = src; };

/* WHERE A LANE ACTUALLY IS, in stage pixels. The roster keeps `laneX` in the
   DRAWING's units -- 28 is half of Kel's 56-pixel lane -- and `spread` is
   what carries it onto the stage along with the road's width and the cars.
   Every test below that parks somebody in a lane, or asserts which lane a car
   took, wants the product; asking for `laneX` alone measured the road Kel
   drew rather than the one the game builds. */
const laneOf = (run) => Number(run("ROSTER.houston.ult.laneX")) *
                        Number(run("ROSTER.houston.ult.spread || 1"));

/* Both fighters put somewhere known. `freezeFrames` is cleared deliberately:
   several moves set it, nothing else clears it, and a measurement that begins
   inside somebody else's freeze spends its one press on a frame where nothing
   is listening. */
const SETUP = `
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  var u = ROSTER.houston.ult;
  projectiles.length = 0; effects.length = 0;
  freezeFrames = 0;
  netplay.active = true;
  [me, foe].forEach(function (f) {
    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;
    f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;
    f.grabbing = -1; f.grabbedBy = -1; f.grounded = true; f.specialSpawned = false;
    f.stocks = 9; f.eliminated = false; f.health = 100; f.hasHit = true;
    f.y = main.y; f.attackFrame = 0;
    f.burn = 0; f.poison = 0; f.confused = 0; f.drowsy = 0;
  });
  me.ultMeter = COMBAT.ultMax; me.x = 160; me.facing = 1;
  foe.x = 260; foe.facing = -1;`;

/* Fire the ult and run the whole public work out, reporting what the road and
   its traffic did. `pin` parks the target at a fixed offset from the white
   line each frame, so a sweep measures the HITBOX rather than a fight. */
const RUN_ULT = (opts) => `(function () {
  ${SETUP}
  var o = ${JSON.stringify(opts || {})};
  if (o.facing) me.facing = o.facing;
  var r = { cars: [], roadAt: null, roadGone: -1, freeAt: -1, meter0: me.ultMeter,
            meterAfter: -1, took: 0, hits: [], sizes: [], lanes: [], built: [],
            seen: {}, topHit: 0 };
  var born = {};
  for (var f = 0; f < 400; f++) {
    me.hitstop = 0; foe.hitstop = 0;
    if (o.pin !== undefined) {
      foe.setState('idle'); foe.hitstun = 0; foe.invuln = 0;
      foe.x = 160 + o.pin; foe.vx = 0; foe.vy = 0;
      foe.y = main.y - (o.air || 0); foe.grounded = !o.air;
    }
    if (o.walkAfter && f === o.walkAfter) me.x = 160 + o.walkTo;
    var hp0 = foe.health;
    netplay.framePads = [bitsToPad(f === 0 ? ${ULT} : 0), bitsToPad(0)];
    step();
    if (r.freeAt < 0 && f > 0 && me.state !== 'ult') r.freeAt = f;
    if (foe.health < hp0) {
      r.took += hp0 - foe.health;
      r.hits.push({ f: f, vx: +foe.vx.toFixed(2), at: +foe.x.toFixed(1) });
      if (o.pin !== undefined) foe.health = 100;
    }
    var road = null, live = 0;
    for (var i = 0; i < projectiles.length; i++) {
      var p = projectiles[i];
      if (p.constructor.name === 'Roadway') road = p;
      if (p.constructor.name !== 'Oncoming') continue;
      /* Keyed on index, which is WHICH CAR, and not on tint, which is which
         of the three paints it wears. Those were the same number while the
         road sent three cars. It sends six, so tint wraps -- cars 0 and 3 are
         the same color -- and a trace keyed on it saw three cars, called
         that the whole queue, and asserted happily about half a move.

         No backticks anywhere in here: this whole probe is a template
         literal, so one inside a comment ends the string. */
      if (!born[p.index]) {
        born[p.index] = 1;
        r.cars.push({ index: p.index, tint: p.tint, lane: p.lane, bornAt: f });
      }
      if (p.index === 0) {
        r.sizes.push(+p.s.toFixed(4));
        /* The RATIO is computed in here at full precision rather than
           divided out afterwards: the two numbers it is made of are rounded
           for the trip through JSON, and at a size of 0.3 that rounding is
           worth more than the property being asserted. */
        r.lanes.push(+(Math.abs(p.x - 160) / p.s).toFixed(6));
        r.seen[p.live() ? 'live' : 'scenery'] = 1;
        r.seen[p.behind ? 'behind' : 'front'] = 1;
      }
    }
    if (road && !r.roadAt) r.roadAt = { x: road.x, y: road.y, life: road.life() };
    if (road) r.built.push(+road.built().toFixed(3));
    if (!road && r.roadAt && r.roadGone < 0) r.roadGone = f;
    if (f === 0) r.meterAfter = me.ultMeter;
  }
  return JSON.stringify(r);
})()`;

const fire = (run, opts) => JSON.parse(run(RUN_ULT(opts)));

/* =====================================================================
   1. THE ROAD IS A PLACE, and he walks away from it
   ===================================================================== */

/* He breaks ground where he is standing, the road is centred THERE, and it
   outlives his recovery by seconds. That last part is what separates this
   from Cobeus's car -- his ult ends when his animation does. */
function checkRoad(r) {
  assert.ok(r.roadAt, "pressing the ult should put a road down");
  assert.equal(r.roadAt.x, 160, "the road should be centred where he broke ground");
  assert.ok(r.freeAt > 0 && r.freeAt < 60,
    "he should be out of the move inside a second; he left it at frame " + r.freeAt);
  assert.ok(r.roadGone > r.freeAt + 120,
    "the road should outlive his recovery by seconds -- he was free at frame " +
    r.freeAt + " and it lifted at " + r.roadGone);
  // And it did not follow him: he was teleported 60px away mid-ult.
  assert.equal(r.roadAt.x, 160, "the road must not follow him");
}

test("the road is laid where he broke ground and outlives the move", async () => {
  const { run } = await arena("kel");
  checkRoad(fire(run, { walkAfter: 70, walkTo: 60 }));
});

test("control: a road that dies with the move fails the outlives-him test", async () => {
  withEngine(sabotage(
    "    return s.pave + (s.lanes.length - 1) * s.gap + s.travel + s.past + s.fade;\n",
    "    return s.pave;\n"));
  const { run } = await arena("kel");
  const r = fire(run, { walkAfter: 70, walkTo: 60 });
  expectToFail(() => checkRoad(r),
    "a road that lifts at the end of the paving should fail checkRoad");
});

/* =====================================================================
   2. IT PAVES ITSELF IN
   ===================================================================== */

/* A construction project you watch get built, from his feet AWAY. Two things
   have to be true at once and only one of them is obvious: the drawn road
   grows, and its NEAR EDGE never moves -- it is pinned to the floor he broke
   ground on while the far end runs off toward the vanishing point. A road
   that grew from the middle outward, or downward from the sky, would pass a
   test that only looked at how many rows were drawn. */
function checkPaving(r, frames) {
  assert.ok(r.built.length > 30, "the road should be around long enough to watch");
  assert.ok(r.built[0] < 0.2, "it should start as almost nothing, not a whole road");
  assert.equal(Math.max.apply(null, r.built), 1, "it should finish paved");
  for (let i = 1; i < r.built.length; i++) {
    assert.ok(r.built[i] >= r.built[i - 1],
      "the paving must never go backwards (frame " + i + ")");
  }
  const rows = frames.map((f) => f.dh);
  assert.ok(rows[rows.length - 1] > rows[0] * 3,
    "the drawn road should be far taller when finished than when started: " +
    rows[0] + " -> " + rows[rows.length - 1]);
  const bottoms = frames.map((f) => f.dy + f.dh);
  assert.equal(new Set(bottoms).size, 1,
    "the near edge must stay pinned to the floor; it was at " +
    [...new Set(bottoms)].join(", "));
}

async function pavingFrames(run) {
  const log = JSON.parse(run(`(function () {
    ${SETUP}
    var out = [];
    for (var f = 0; f < 60; f++) {
      me.hitstop = 0;
      netplay.framePads = [bitsToPad(f === 0 ? ${ULT} : 0), bitsToPad(0)];
      step();
      for (var i = 0; i < projectiles.length; i++) {
        var p = projectiles[i];
        if (p.constructor.name !== 'Roadway') continue;
        window.__log.length = 0;
        p.draw(window.__ctx);
        var d = window.__log[0];
        if (d) out.push({ dy: d.dy, dh: d.dh, sy: d.sy, sh: d.sh, t: p.t });
      }
    }
    return JSON.stringify(out);
  })()`));
  return log;
}

test("the road paves in from his feet away, near edge pinned to the floor", async () => {
  const { run, sandbox } = await arena("kel");
  sandbox.__log = [];
  sandbox.__ctx = recordingContext(sandbox.__log);
  const frames = await pavingFrames(run);
  checkPaving(fire(run), frames);
});

test("control: a road that is whole on the first frame fails the paving test", async () => {
  withEngine(sabotage(
    "    return this.t >= s.pave ? 1 : this.t / s.pave;\n",
    "    return 1;\n"));
  const { run, sandbox } = await arena("kel");
  sandbox.__log = [];
  sandbox.__ctx = recordingContext(sandbox.__log);
  const frames = await pavingFrames(run);
  const r = fire(run);
  expectToFail(() => checkPaving(r, frames),
    "a road that is fully built on frame one should fail checkPaving");
});

/* =====================================================================
   3. SIX CARS, AND THE LANE HE IS FACING GETS FOUR OF THEM
   ===================================================================== */

/* The road is centred on him and he is usually looking at the other fighter,
   so which way he faces is the one aiming decision in the move. `lanes` is
   multiplied by his facing at the moment he broke ground, and this is the
   assertion that it is actually multiplied rather than merely written down. */
function checkLanes(right, left, laneX) {
  /* `laneX` here is the lane offset ON THE STAGE -- the roster's number times
     `spread` -- because that is what the engine puts on the car and what a
     player has to walk. Rounded to four places on both sides: the engine
     multiplies three floats in one order and this test in another, and the
     property under test is where the cars are, not which way the last bit
     rounded. */
  const lanes = (r) => r.cars.map((c) => +c.lane.toFixed(4));
  const X = +laneX.toFixed(4);
  assert.equal(right.cars.length, 6, "six cars should come down the road");
  assert.deepEqual(lanes(right), [X, -X, X, -X, X, X],
    "facing right, four of the six should take the right-hand lane");
  assert.deepEqual(lanes(left), [-X, X, -X, X, -X, -X],
    "facing left, the mirror of that");
  const gaps = right.cars.slice(1).map((c, i) => c.bornAt - right.cars[i].bornAt);
  assert.deepEqual(new Set(gaps).size, 1,
    "the cars should be let on at an even spacing; gaps were " + gaps.join(", "));
}

test("six cars, and the lane he faces gets four of them", async () => {
  const { run } = await arena("kel");
  checkLanes(fire(run, { facing: 1 }), fire(run, { facing: -1 }), laneOf(run));
});

test("control: lanes that ignore his facing fail the aiming test", async () => {
  withEngine(sabotage(
    "    this.lane = road.spec.lanes[index] * road.spec.laneX *\n" +
    "                (road.spec.spread || 1) * road.dir;\n",
    "    this.lane = road.spec.lanes[index] * road.spec.laneX *\n" +
    "                (road.spec.spread || 1);\n"));
  const { run } = await arena("kel");
  expectToFail(
    () => checkLanes(fire(run, { facing: 1 }), fire(run, { facing: -1 }), laneOf(run)),
    "lanes that do not read his facing should fail checkLanes");
});

/* =====================================================================
   4. THE PERSPECTIVE IS ONE NUMBER READ THREE WAYS
   ===================================================================== */

/* A car's size, its row on the road and its distance off the white line are
   all derived from one value, and this is the test that they cannot come
   apart. Two properties, and both matter:
 *
 *   ITS LANE SCALES WITH IT. offset / size is the lane's width at the NEAR
 *   edge and is the same number at every distance. A car that slid down a
 *   fixed screen column would still look like a car and would still be in the
 *   wrong place for most of the road.
 *
 *   IT ACCELERATES. Size is one over the distance, so a car closing at a
 *   constant rate creeps at the top of the road and rushes at the bottom.
 *   That curve IS the telegraph, and a linear ramp -- which is what anybody
 *   would write first -- looks like a sprite being enlarged. */
function checkPerspective(r, laneX) {
  assert.ok(r.sizes.length > 60, "the first car should be tracked for its whole run");
  for (let i = 1; i < r.sizes.length; i++) {
    assert.ok(r.sizes[i] > r.sizes[i - 1],
      "a car must only ever get bigger (sample " + i + ")");
  }
  for (let i = 0; i < r.lanes.length; i++) {
    assert.ok(Math.abs(r.lanes[i] - laneX) < 0.0001,
      "its offset off the white line should be its lane scaled by its size -- " +
      "offset over size should be " + laneX + " at every distance; at size " +
      r.sizes[i] + " it was " + r.lanes[i]);
  }
  const first = r.sizes[0];
  const last = r.sizes[r.sizes.length - 1];
  const half = r.sizes[Math.floor(r.sizes.length / 2)];
  const gone = (half - first) / (last - first);
  assert.ok(gone < 0.35,
    "halfway through its run it should still be far away -- it had covered " +
    (gone * 100).toFixed(0) + "% of its growth, which is a ramp, not perspective");
}

test("a car's size, its lane and its row are one number read three ways", async () => {
  const { run } = await arena("kel");
  checkPerspective(fire(run), laneOf(run));
});

test("control: a car that grows linearly fails the perspective test", async () => {
  withEngine(sabotage(
    "    return 1 / Math.max(1 / this.ult.maxSize, d0 + (1 - d0) * u);\n",
    "    return (1 / d0) + (1 - 1 / d0) * u;\n"));
  const { run } = await arena("kel");
  expectToFail(() => checkPerspective(fire(run), laneOf(run)),
    "a linear ramp should fail checkPerspective");
});

/* =====================================================================
   5. THE STRIPE DOWN THE MIDDLE IS THE ANSWER
   ===================================================================== */

/* Kel painted a dashed white line between the two lanes, and standing on it
   is how you survive the move. That is the entire counterplay and it is the
   thing a retune takes away without changing anything you can see, so it is
   pinned from both sides: the line is safe, the lanes are not, and the safe
   window is narrow enough to be a decision and wide enough to be possible.
   A fighter is nine pixels across. */
function checkStripe(sweep, laneX) {
  assert.equal(sweep[0].took, 0,
    "a man standing on the white line should not be touched");
  const inLane = sweep.find((s) => s.at === laneX);
  assert.ok(inLane.took > 0,
    "a man standing in a lane should be run over");
  const safe = sweep.filter((s) => s.took === 0).map((s) => s.at);
  const widest = Math.max.apply(null, safe.filter((a) => Math.abs(a) < laneX));
  /* 12 to 20, and the window moved because the road did. MEASURED with the
     same sweep at every pixel out to 110: the three-car road was untouched
     from -8 to +8 and this one is untouched from -15 to +15, because every
     term in that gap -- the lane offset, the car's width, the road it is
     painted on -- is multiplied by the same `spread`. Widening the road
     widens the answer to it, which is the property this range is pinning:
     a retune that made the road bigger WITHOUT the stripe following would
     land under 12 and fail here. */
  assert.ok(widest >= 12 && widest <= 20,
    "the safe stripe should be wide enough to stand on and narrow enough to " +
    "be a decision; it reaches " + widest + " pixels off the line");
}

async function sweepStripe(run, offsets) {
  return offsets.map((at) => ({ at, took: fire(run, { pin: at }).took }));
}
const OFFSETS = [0, 2, 4, 6, 8, 10, 12, 14, 15, 16, 18, 20, 26];

test("the white line down the middle of the road is safe and the lanes are not", async () => {
  const { run } = await arena("kel");
  const laneX = laneOf(run);
  checkStripe(await sweepStripe(run, OFFSETS.concat([laneX])), laneX);
});

test("control: lanes collapsed onto the centre line leave nowhere safe", async () => {
  withEngine(sabotage("    laneX: 28, lanes: [1, -1, 1, -1, 1, 1],\n",
                      "    laneX: 4, lanes: [1, -1, 1, -1, 1, 1],\n"));
  const { run } = await arena("kel");
  const laneX = laneOf(run);
  // The sweep is finished BEFORE expectToFail is called: its argument is an
  // arrow, and an await inside one that is not itself async is a syntax error.
  const sweep = await sweepStripe(run, OFFSETS.concat([laneX]));
  expectToFail(() => checkStripe(sweep, laneX),
    "traffic driving down the white line should fail checkStripe");
});

/* =====================================================================
   6. A CAR THROWS YOU AWAY FROM ITSELF
   ===================================================================== */

/* applyHit takes its direction from which side of the victim the source is,
   and the source a car hands it is the CAR. So the middle of the road throws
   you at a shoulder and a shoulder throws you off the stage, which is the
   whole of how this move takes a stock. Both signs are asserted: a launch
   that is always outward from Houston looks identical on one side. */
function checkLaunch(rightSide, leftSide) {
  assert.ok(rightSide.hits.length > 0 && leftSide.hits.length > 0,
    "both targets should have been run over");
  assert.ok(rightSide.hits[0].vx > 1,
    "a man to the RIGHT of the lane should be thrown right; vx was " +
    rightSide.hits[0].vx);
  assert.ok(leftSide.hits[0].vx < -1,
    "a man to the LEFT of the lane should be thrown left; vx was " +
    leftSide.hits[0].vx);
}

test("a car throws whoever it hits away from itself, either way", async () => {
  const { run } = await arena("kel");
  const laneX = laneOf(run);
  checkLaunch(fire(run, { pin: laneX + 12 }), fire(run, { pin: laneX - 12 }));
});

test("control: a launch with no sideways component fails the throw test", async () => {
  withEngine(sabotage("      damage: 11, base: 3.4, scale: 7.0, angle: 34,\n",
                      "      damage: 11, base: 3.4, scale: 7.0, angle: 90,\n"));
  const { run } = await arena("kel");
  const laneX = laneOf(run);
  // 90 degrees is straight up, so kx below is deliberately left alone: the
  // control is the LAUNCH VECTOR, and kx is the half of it that does the work.
  run("ROSTER.houston.ult.traffic.kx = 0; ROSTER.houston.ult.traffic.ky = 1;");
  expectToFail(() => checkLaunch(fire(run, { pin: laneX + 12 }), fire(run, { pin: laneX - 12 })),
    "a purely vertical launch should fail checkLaunch");
});

/* =====================================================================
   7. SCENERY UNTIL IT IS CLOSE
   ===================================================================== */

/* A car in the distance is small, it is sixty pixels above the floor it is
   heading for, and it is painted BEHIND the stage. It must not be a hitbox
   there -- a six-pixel car taking thirteen off somebody on a platform is the
   kind of thing that reads as the game being broken rather than as a move.
   The same car later must be all three of the opposite things, or `bite` has
   been set somewhere it never trips. */
function checkScenery(r) {
  assert.ok(r.seen.scenery, "a car should spend part of its run as scenery");
  assert.ok(r.seen.live, "and the rest of it as a real hitbox");
  assert.ok(r.seen.behind, "a far car should be drawn behind the stage");
  assert.ok(r.seen.front, "and a near one in front of it");
  assert.equal(r.topHit, 0, "nothing should be hit by a car that is still scenery");
}

test("a distant car is scenery: no hitbox, and painted behind the stage", async () => {
  const { run } = await arena("kel");
  const r = fire(run);
  // What a car did on every frame it was far away, asked of the engine.
  r.topHit = Number(run(`(function () {
    ${SETUP}
    var bad = 0;
    for (var f = 0; f < 200; f++) {
      me.hitstop = 0;
      netplay.framePads = [bitsToPad(f === 0 ? ${ULT} : 0), bitsToPad(0)];
      step();
      for (var i = 0; i < projectiles.length; i++) {
        var p = projectiles[i];
        if (p.constructor.name !== 'Oncoming') continue;
        // Scenery and dangerous, or close and hidden behind the stage: either
        // is the pair coming apart, and either is a bug you cannot see.
        if (p.live() !== !p.behind) bad++;
      }
    }
    return bad;
  })()`));
  checkScenery(r);
});

test("control: a car that is live from the vanishing point fails the scenery test", async () => {
  withEngine(sabotage("    bite: 0.5,\n", "    bite: 0,\n"));
  const { run } = await arena("kel");
  const r = fire(run);
  r.topHit = 0;
  expectToFail(() => checkScenery(r),
    "a car that is a hitbox at the vanishing point should fail checkScenery");
});

/* =====================================================================
   8. YOU CANNOT PAVE THE SKY
   ===================================================================== */

/* `groundOnly`, the flag Simon's slouch already uses. An airborne press is
   dropped rather than queued, and -- the half that is easy to lose -- it does
   not spend the meter. A refused press that still emptied the bar would be
   indistinguishable from the move simply not working. */
function checkGrounded(air, ground) {
  assert.equal(air.roadAt, null, "an airborne press must not lay a road");
  assert.equal(air.meterAfter, air.meter0,
    "a refused press must not spend the meter; it went " + air.meter0 +
    " -> " + air.meterAfter);
  assert.ok(ground.roadAt, "the same press on the floor should lay one");
}

const AIRBORNE = (opts) => `(function () {
  ${SETUP}
  me.grounded = false; me.y = main.y - 40;
  var r = { roadAt: null, meter0: me.ultMeter, meterAfter: -1 };
  for (var f = 0; f < 40; f++) {
    me.hitstop = 0;
    if (!${opts}) { me.grounded = false; me.y = main.y - 40; me.vy = 0; }
    netplay.framePads = [bitsToPad(f === 0 ? ${ULT} : 0), bitsToPad(0)];
    step();
    for (var i = 0; i < projectiles.length; i++) {
      if (projectiles[i].constructor.name === 'Roadway') r.roadAt = { x: projectiles[i].x };
    }
    if (f === 0) r.meterAfter = me.ultMeter;
  }
  return JSON.stringify(r);
})()`;

test("the ult is grounded-only: an airborne press is dropped and costs nothing", async () => {
  const { run } = await arena("kel");
  checkGrounded(JSON.parse(run(AIRBORNE("false"))), fire(run));
});

test("control: with groundOnly off, the airborne press casts", async () => {
  withEngine(sabotage(
    "    groundOnly: true,\n    /* Short, because the road outlives it",
    "    groundOnly: false,\n    /* Short, because the road outlives it"));
  const { run } = await arena("kel");
  expectToFail(() => checkGrounded(JSON.parse(run(AIRBORNE("false"))), fire(run)),
    "an ult that casts in the air should fail checkGrounded");
});

/* =====================================================================
   9. HE IS THE CONTRACTOR, NOT A PEDESTRIAN
   ===================================================================== */

/* He stands on the white line and he owns the road, so his own traffic goes
   through him. That is not politeness -- the whole shape of the move is that
   the safe stripe down the middle is exactly where he is, so the choice it
   puts to the other fighter is "leave, or come and stand next to him". A
   Houston who could be run over by his own ult has no such move. */
test("his own cars drive through him", async () => {
  const { run } = await arena("kel");
  const mine = Number(run(`(function () {
    ${SETUP}
    var took = 0;
    for (var f = 0; f < 260; f++) {
      me.hitstop = 0;
      // Parked in his own busiest lane, not on the line: the owner check is
      // what is being measured, not his standing position.
      me.x = 160 + u.laneX; me.vx = 0;
      var hp0 = me.health;
      netplay.framePads = [bitsToPad(f === 0 ? ${ULT} : 0), bitsToPad(0)];
      step();
      if (me.health < hp0) took += hp0 - me.health;
    }
    return took;
  })()`));
  assert.equal(mine, 0, "he should take nothing from his own road");
});

/* =====================================================================
   10. WHAT THE BUNDLE SHIPS
   ===================================================================== */

/* The perspective is measured by build.py off Kel's drawing and shipped as
   numbers, so the engine has no second copy of it to drift from the picture.
   These are the numbers; if they stop arriving, every hitbox in the move is
   built out of undefined and the cars end up somewhere quietly wrong. */
test("the bundle ships the road, three cars, and the measured perspective", async () => {
  const { run } = await arena("kel");
  const nd = JSON.parse(run("JSON.stringify({" +
    "near: SPRITES.newdeal.near, far: SPRITES.newdeal.far, rows: SPRITES.newdeal.rows," +
    "cw: SPRITES.newdeal.cw, ch: SPRITES.newdeal.ch," +
    "cars: SPRITES.newdeal.cars.length, road: !!SPRITES.newdeal.road })"));
  assert.equal(nd.cars, 3, "three cars should ship");
  assert.ok(nd.road, "and the road");
  for (const k of ["near", "far", "rows", "cw", "ch"]) {
    assert.ok(Number.isFinite(nd[k]) && nd[k] > 0,
      k + " should be a measured pixel count, not " + nd[k]);
  }
  assert.ok(nd.far < nd.near,
    "the road should be narrower at the far end than the near one: " +
    nd.far + " vs " + nd.near);
  // And every one of them reached IMG, or the draw path silently paints
  // nothing and the whole ult is invisible.
  assert.equal(run("!!IMG['newdeal.road']"), true, "the road should be loaded");
  for (let i = 0; i < 3; i++) {
    assert.equal(run("!!IMG['newdeal.car." + i + "']"), true,
      "car " + i + " should be loaded");
  }
});

/* The ROSTER's own numbers, which are the ones a tuning pass touches. Pinned
   loosely -- these are ranges, not values, because the point is to catch a
   decimal point rather than to forbid a retune. */
test("the ult's shape is a road, six cars and a few seconds", async () => {
  const { run } = await arena("kel");
  const u = JSON.parse(run("JSON.stringify(ROSTER.houston.ult)"));
  assert.equal(u.kind, "newdeal");
  assert.equal(u.label, "FDR'S NEW DEAL");
  assert.equal(u.groundOnly, true);
  assert.equal(u.lanes.length, 6, "six cars");
  /* The one number that makes the road bigger, and the only one: `spread`
     multiplies the drawn width, the lane offsets and the cars together, so
     nothing in the perspective can be enlarged on its own. Bounded rather
     than pinned -- a retune may widen the road, and 2.5 of a 123-pixel road
     is wider than the stage. */
  assert.ok(u.spread >= 1 && u.spread <= 2,
    "the road should be scaled by a spread between 1 and 2; it was " + u.spread);
  assert.ok(u.travel >= 60 && u.travel <= 140,
    "a car should take a second or two to arrive, not a blink: " + u.travel);
  assert.ok(u.pave > 0, "the road should take time to build");
  assert.ok(u.bite > 0 && u.bite < 1, "there should be a distance at which it is scenery");
  /* The ceiling that can actually be STOOD in, which is the busiest lane
     rather than the whole queue. `lanes` is which side of the white line
     each car takes, and a man parked in one of them is run over by the cars
     in that lane only: being hit by both needs a car to throw you across the
     stripe, which is what the sideways launch is for and is not something
     anybody can multiply out.

     MEASURED against this, by parking a target at every pixel and running
     the whole ult: the worst any offset takes is 32, which is exactly
     `damage` times `busiest`. So this bound is the real one. */
  const busiest = Math.max(u.lanes.filter((l) => l > 0).length,
                           u.lanes.filter((l) => l < 0).length);
  assert.ok(u.traffic.damage * busiest <= 45,
    "the traffic in one lane should not out-damage the car ult that already " +
    "exists; it is " + busiest + " cars at " + u.traffic.damage);
  /* And one car is one hit per person, which is what `hitEvery` has always
     claimed. It has to be longer than a car's whole life from the frame it
     stops being scenery, or a tall car starts hitting twice -- which it
     silently did at `spread` 1.6 until this was raised from 40. */
  assert.ok(u.traffic.hitEvery >= u.travel + u.past - 40,
    "hitEvery (" + u.traffic.hitEvery + ") has to outlast a car's approach, " +
    "or a car hits the same person twice");
  const total = u.startup + u.active + u.recovery;
  assert.ok(total < u.pave + u.travel,
    "he should be free again well before the first car arrives; he is locked " +
    "for " + total + " frames and the first car lands at " + (u.pave + u.travel));
});
