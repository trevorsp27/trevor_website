/* NerdWars audio.
 *
 * The engine must boot and play a whole match on a machine with no Web Audio
 * at all -- that is what the node:vm sandbox is, and it is also a real
 * browser with audio blocked. So the first thing these tests assert is
 * silence-without-crashing, and only then that sound happens when it can.
 *
 * The AudioContext here is a recording fake: every node it hands out logs the
 * calls made against it, so a test can assert on the shape of the graph a
 * recipe built without needing to hear anything.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

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

/** An AudioContext that records instead of making noise. */
function recordingAudioContext() {
  const log = [];
  const param = (node, name) => ({
    value: 0,
    setValueAtTime(v, t) {
      log.push({ node, param: name, op: "set", value: v, time: t });
      return this;
    },
    linearRampToValueAtTime(v, t) {
      log.push({ node, param: name, op: "lin", value: v, time: t });
      return this;
    },
    exponentialRampToValueAtTime(v, t) {
      log.push({ node, param: name, op: "exp", value: v, time: t });
      return this;
    },
    cancelScheduledValues() {
      return this;
    },
  });
  const make = (kind) => {
    const n = { kind };
    n.connect = (dest) => {
      log.push({ node: kind, op: "connect", to: dest && dest.kind });
      return dest;
    };
    n.disconnect = () => {};
    n.start = (t) => log.push({ node: kind, op: "start", time: t });
    n.stop = (t) => log.push({ node: kind, op: "stop", time: t });
    n.gain = param(kind, "gain");
    n.frequency = param(kind, "frequency");
    n.detune = param(kind, "detune");
    n.pan = param(kind, "pan");
    n.Q = param(kind, "Q");
    n.type = "";
    n.buffer = null;
    return n;
  };
  return {
    log,
    currentTime: 0,
    state: "running",
    sampleRate: 48000,
    destination: { kind: "destination" },
    resume() {
      this.state = "running";
      return Promise.resolve();
    },
    createGain: () => make("gain"),
    createOscillator: () => make("osc"),
    createBiquadFilter: () => make("filter"),
    createStereoPanner: () => make("panner"),
    createBufferSource: () => make("bufsrc"),
    createBuffer: (channels, length, sampleRate) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
  };
}

/**
 * Like recordingAudioContext, but createOscillator throws exactly once: on
 * the next call after `ctx.arm()` is invoked, not simply "the Nth call ever
 * made". Counting calls from context creation would silently retarget the
 * throw at whatever oscillator API happens to run first -- a future
 * startup chime, say -- leaving the test passing while it exercises
 * something other than what it claims to. Arming immediately before the
 * call under test pins the throw to that call and nothing else. The
 * recording fake above accepts any recipe without complaint, so this is
 * how a test gets something for audioFlush's inner per-item try/catch to
 * actually catch -- standing in for a malformed recipe hitting a real Web
 * Audio API (an invalid oscillator type, a non-finite frequency, and so
 * on).
 */
function throwingAudioContext() {
  const ctx = recordingAudioContext();
  const realCreateOscillator = ctx.createOscillator;
  let armed = false;
  ctx.arm = () => {
    armed = true;
  };
  ctx.createOscillator = () => {
    if (armed) {
      armed = false;
      throw new Error("simulated malformed recipe");
    }
    return realCreateOscillator();
  };
  return ctx;
}

/**
 * Boot one engine.
 * @param {object} [opts]
 * @param {boolean} [opts.audio] install a recording AudioContext (default off,
 *   which is the important case: the engine must survive without one)
 * @param {function} [opts.makeAudioContext] factory for the fake AudioContext
 *   to install when opts.audio is set (default recordingAudioContext) --
 *   how a test swaps in throwingAudioContext instead
 */
async function bootGame(opts) {
  const withAudio = !!(opts && opts.audio);
  const makeAudioContext = (opts && opts.makeAudioContext) || recordingAudioContext;
  const view = stubCanvas(960, 540);
  const winListeners = new Map();
  const docListeners = new Map();
  const viewListeners = new Map();
  const rafQueue = [];
  let clock = 0;

  const on = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  view.addEventListener = on(viewListeners);

  let recorder = null;

  const sandbox = {
    console,
    Math,
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
    Float32Array,
    Float64Array,
    isNaN,
    parseInt,
    parseFloat,
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
      getElementById: (id) =>
        id === "nw-canvas" || id === "game" ? view : null,
      querySelector: () => null,
      createElement: () => stubCanvas(320, 180),
      addEventListener: on(docListeners),
      documentElement: {},
      fullscreenElement: null,
    },
  };

  if (withAudio) {
    sandbox.AudioContext = function () {
      recorder = makeAudioContext();
      return recorder;
    };
  }

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SPRITES, sandbox, { filename: "sprites.js" });
  vm.runInContext(GAME, sandbox, { filename: "game.js" });

  for (let i = 0; i < 5; i++) await Promise.resolve();

  const fire = (map, type, ev) => {
    for (const fn of map.get(type) || []) fn(ev);
  };

  return {
    nw: sandbox.window.NerdWars,
    get audioLog() {
      return recorder ? recorder.log : [];
    },
    get recorder() {
      return recorder;
    },
    pump(n = 1) {
      for (let i = 0; i < n; i++) {
        const due = rafQueue.splice(0, rafQueue.length);
        clock += 1000 / 60;
        for (const cb of due) cb(clock);
      }
    },
    press: (code) =>
      fire(winListeners, "keydown", { code, preventDefault() {} }),
    release: (code) => fire(winListeners, "keyup", { code }),
    click: () =>
      fire(viewListeners, "mousedown", { clientX: 10, clientY: 10 }),
  };
}

export { bootGame, recordingAudioContext };

test("the engine boots and runs with no Web Audio at all", async () => {
  const g = await bootGame();
  assert.equal(g.nw.ready, true, "assets should have loaded");
  assert.equal(g.nw.scene, "title");
  g.pump(120);
  assert.ok(g.nw.frames > 100, "the loop should keep running without audio");
});

test("audio reports itself unavailable before any gesture", async () => {
  const g = await bootGame({ audio: true });
  assert.equal(g.nw.audio.ready, false, "no context until a gesture");
});

test("a keypress unlocks audio", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  assert.equal(g.nw.audio.ready, true, "keydown should unlock");
});

test("a canvas click unlocks audio", async () => {
  const g = await bootGame({ audio: true });
  g.click();
  assert.equal(g.nw.audio.ready, true, "mousedown should unlock");
});

test("unlocking twice does not build a second context", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  const first = g.recorder;
  g.press("KeyX");
  assert.equal(g.recorder, first, "the context should be created once");
});

test("a recipe with a pitch sweep builds an oscillator that ramps", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.test({ osc: "sine", f0: 180, f1: 34, dur: 0.4, curve: "exp", gain: 0.9 });

  const log = g.audioLog;
  const osc = log.filter((e) => e.node === "osc");
  assert.ok(osc.some((e) => e.op === "start"), "the oscillator should start");
  assert.ok(osc.some((e) => e.op === "stop"), "and be stopped, not left running");

  const freq = log.filter((e) => e.node === "osc" && e.param === "frequency");
  assert.equal(freq[0].value, 180, "should start at f0");
  assert.equal(freq[freq.length - 1].value, 34, "and end at f1");
});

test("a recipe with no f1 holds a steady pitch", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.test({ osc: "square", f0: 440, dur: 0.1, gain: 0.5 });

  const freq = g.audioLog.filter((e) => e.node === "osc" && e.param === "frequency");
  assert.equal(freq.length, 1, "one set, no ramp");
  assert.equal(freq[0].value, 440);
});

test("a noise burst builds a buffer source through a lowpass", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.test({ noise: { dur: 0.09, lp: 900 }, dur: 0.09, gain: 0.8 });

  const log = g.audioLog;
  assert.ok(log.some((e) => e.node === "bufsrc" && e.op === "start"), "noise source");
  const cutoff = log.filter((e) => e.node === "filter" && e.param === "frequency");
  assert.equal(cutoff[0].value, 900, "lowpass at the recipe's cutoff");
});

test("gain is never scheduled as zero, which would throw on an exponential ramp", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.test({ osc: "sine", f0: 200, dur: 0.2, gain: 0 });

  const gains = g.audioLog.filter((e) => e.param === "gain" && e.op === "exp");
  for (const e of gains) {
    assert.ok(e.value > 0, "exponentialRamp to " + e.value + " would throw");
  }
});

test("playing a recipe with audio locked does nothing and does not throw", async () => {
  const g = await bootGame({ audio: true });
  g.nw.audio.test({ osc: "sine", f0: 200, dur: 0.2, gain: 0.5 });
  assert.equal(g.audioLog.length, 0, "no context, no nodes");
});

/** Count how many voices reached the graph. */
function voiceCount(log) {
  return log.filter((e) => e.op === "start").length;
}

test("the same cue on the same frame for the same slot plays once", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 1, "three emissions, one voice");
});

test("the same cue for different slots plays once each", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-a", { slot: 1, frame: 100 });
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 2, "two fighters, two sounds");
});

test("the same cue on a later frame plays again", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.flush();
  g.nw.audio.emit("test-a", { slot: 0, frame: 101 });
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 2, "a repeated jab is two jabs");
});

/* The whole reason the bus does not copy addEffect's guard. A hit that only
   the corrected timeline contains is emitted only during the replay; if
   replays were suppressed it would be silent forever. */
test("a cue that appears only during resimulation still plays", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.__test.setResimulating(true);
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.__test.setResimulating(false);
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 1, "the corrected timeline must be audible");
});

/* Despite the name of its setup, this does not drive a real rollback --
   cue() never reads netplay.resimulating, so the two setResimulating calls
   below are inert. What it actually verifies is that a key stays remembered
   across a flush boundary, which is what a real rollback also depends on:
   the second emission has to find the first one's key still in audioPlayed
   after audioBatch has already been cleared out from under it. */
test("dedupe survives a flush boundary", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.flush();
  g.nw.__test.setResimulating(true);
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.__test.setResimulating(false);
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 1, "one hit, one sound, however many flushes");
});

test("an unknown cue name is ignored rather than throwing", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("no-such-cue", { slot: 0, frame: 1 });
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 0);
});

test("cues emitted with audio locked are dropped, not queued up", async () => {
  const g = await bootGame({ audio: true });
  g.nw.audio.emit("test-a", { slot: 0, frame: 1 });
  g.nw.audio.flush();
  g.press("KeyZ");
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 0, "no burst of backlog on unlock");
});

/* Every test above passes an explicit frame, so audioNow() -- the code path
   a real cue actually takes -- never ran. That gap is how the mismatch
   between audioNow()'s and frame()'s idea of which clock is live got past
   review the first time. g.pump() drives the real animation-frame loop, so
   the offline step counter advances for real between the two emissions.

   It does not advance by exactly one tick per pump(), though: frame()'s
   accumulator is timed off floating-point deltas, so a given pump() can
   land zero or two ticks as well as one (confirmed by instrumenting the
   loop directly). So this polls for the next tick rather than assuming a
   fixed pump count -- a bounded number of tries, not a sleep, over a
   deterministic clock. */
test("a cue emitted with no explicit frame is keyed by the simulated tick", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0 });
  g.nw.audio.flush();
  const before = voiceCount(g.audioLog);
  let after = before;
  for (let i = 0; i < 20 && after === before; i++) {
    g.pump(1);
    g.nw.audio.emit("test-a", { slot: 0 });
    g.nw.audio.flush();
    after = voiceCount(g.audioLog);
  }
  assert.equal(after, before + 1, "a later simulated tick is a new voice");
});

test("panning follows x: opposite edges of the stage pan opposite ways", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  // VW, the engine's stage width, is 320.
  g.nw.audio.emit("test-a", { slot: 0, frame: 300, x: 0 });
  g.nw.audio.emit("test-a", { slot: 1, frame: 300, x: 320 });
  g.nw.audio.flush();
  const pans = g.audioLog
    .filter((e) => e.node === "panner" && e.param === "pan" && e.op === "set")
    .map((e) => e.value);
  assert.equal(pans.length, 2, "both voices should be panned");
  assert.ok(pans[0] < 0, "the left edge should pan negative");
  assert.ok(pans[1] > 0, "the right edge should pan positive");
});

test("the played set does not grow without bound", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  for (let f = 0; f < 2000; f++) {
    g.nw.audio.emit("test-a", { slot: 0, frame: f });
    g.nw.audio.flush();
  }
  // NET_MAX_ROLLBACK is 36; the set holds a small multiple of that, not 2000.
  assert.ok(
    g.nw.audio.pending < 200,
    "played set held " + g.nw.audio.pending + " keys after 2000 frames"
  );
});

test("a cue older than the rollback window may play again", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 0 });
  g.nw.audio.flush();
  for (let f = 1; f < 400; f++) {
    g.nw.audio.emit("test-b", { slot: 0, frame: f });
    g.nw.audio.flush();
  }
  const before = g.audioLog.filter((e) => e.op === "start").length;
  // No rollback can reach frame 0 any more, so its key is gone and this is a
  // new sound rather than a suppressed duplicate.
  g.nw.audio.emit("test-a", { slot: 0, frame: 0 });
  g.nw.audio.flush();
  assert.equal(
    g.audioLog.filter((e) => e.op === "start").length,
    before + 1
  );
});

test("at most three voices of one recipe play in a single flush", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  for (let slot = 0; slot < 8; slot++) {
    g.nw.audio.emit("test-a", { slot, frame: 100 });
  }
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 3, "eight emissions, three voices");
});

test("different recipes in one flush are not capped against each other", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  for (let slot = 0; slot < 4; slot++) {
    g.nw.audio.emit("test-a", { slot, frame: 100 });
    g.nw.audio.emit("test-b", { slot, frame: 100 });
  }
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 6, "three of each");
});

test("stacked voices are attenuated and detuned", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  for (let slot = 0; slot < 3; slot++) {
    g.nw.audio.emit("test-a", { slot, frame: 100 });
  }
  g.nw.audio.flush();

  const peaks = g.audioLog
    .filter((e) => e.node === "gain" && e.param === "gain" && e.op === "exp")
    .map((e) => e.value)
    .filter((v) => v > 0.01);
  assert.ok(peaks[0] > peaks[1], "the second voice should be quieter");
  assert.ok(peaks[1] > peaks[2], "and the third quieter still");

  const detunes = g.audioLog.filter((e) => e.param === "detune");
  assert.ok(detunes.length >= 2, "duplicates should be detuned apart");
});

test("cues from different frames in one flush keep their spacing", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-b", { slot: 0, frame: 104 });
  g.nw.audio.flush();

  const starts = g.audioLog.filter((e) => e.op === "start").map((e) => e.time);
  assert.equal(starts.length, 2);
  const gap = Math.abs(starts[1] - starts[0]);
  const expected = 4 * (1000 / 60) / 1000;   // four frames, in seconds
  assert.ok(
    Math.abs(gap - expected) < 0.002,
    "expected ~" + expected.toFixed(4) + "s apart, got " + gap.toFixed(4)
  );
});

test("cues on the same frame are simultaneous", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-b", { slot: 1, frame: 100 });
  g.nw.audio.flush();

  const starts = g.audioLog.filter((e) => e.op === "start").map((e) => e.time);
  assert.equal(starts[0], starts[1], "one frame, one instant");
});

test("scheduling never lands in the past", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 200 });
  g.nw.audio.emit("test-b", { slot: 0, frame: 100 });   // out of order
  g.nw.audio.flush();

  const now = g.recorder.currentTime;
  for (const e of g.audioLog.filter((x) => x.op === "start")) {
    assert.ok(e.time >= now, "scheduled at " + e.time + " but now is " + now);
  }
});

/**
 * Navigate from the title screen into a real two-human battle.
 *
 * The task brief that first specified these tests reached this point with
 * two Enter taps, on the assumption that the default title selection puts
 * an engine straight into a fight. It does not: MODES[0], the default, is
 * "1 PLAYER (vs CPU)" and needs four confirms -- title, lock seat 0, lock
 * seat 1, stage -- to reach `battle` at all. With only two, an engine
 * silently sits on the character-select screen for the rest of the test,
 * `fighters` stays `[]` the whole time, and a determinism assertion after it
 * compares two empty arrays -- passing without ever exercising a fight.
 * Confirmed by instrumenting the two given tests directly: with the
 * brief's original two-tap script, nw.scene was still "select" and
 * nw.fighters.length was 0 after all 400 scripted frames.
 *
 * Simply pressing through to a CPU match does not fix that either. The CPU
 * brain (aiThink, around line 4132 of src/nerdwars.js) calls Math.random()
 * directly with no seed shared between processes, so two independently
 * booted engines with a CPU-controlled fighter diverge from each other on
 * their own -- confirmed by fighting two silent, audio-free engines against
 * this same script and watching the CPU seat's position and state disagree
 * between them. That divergence is real, but it has nothing to do with
 * audio, and folding a CPU seat into this test would make it fail (or pass)
 * for reasons unrelated to what it exists to prove.
 *
 * So this selects MODES[1], "2 PLAYERS (local)": both seats are driven by
 * the scripted keys the tests already send, nothing in the fight is left to
 * chance, and a mismatch between two engines fed the same script can only
 * mean one of them wrote something the other didn't. The KeyS/Enter/KeyG/
 * Comma/Enter sequence below matches startMatch()'s mode-1 branch in
 * nerdwars-fourplayer.test.js, an independent confirmation that this is
 * really how the suite already reaches a two-human local match.
 */
function enterTwoPlayerBattle(g) {
  g.pump(2);
  g.press("KeyS"); // move the title cursor onto "2 PLAYERS (local)"
  g.pump(2);
  g.release("KeyS");
  g.pump(2);
  g.press("Enter"); // confirm at title -> enterSelect()
  g.pump(2);
  g.release("Enter");
  g.pump(2);
  g.press("KeyG"); // seat 0's attack key locks seat 0's pick
  g.pump(2);
  g.release("KeyG");
  g.pump(2);
  g.press("Comma"); // seat 1's attack key locks seat 1's pick -> scene = 'stage'
  g.pump(2);
  g.release("Comma");
  g.pump(2);
  g.press("Enter"); // confirm at stage select -> startBattle()
  g.pump(2);
  g.release("Enter");
  g.pump(4);
}

/**
 * Walk both seats toward each other -- seat 0 with KeyD, seat 1 with
 * ArrowLeft, their spawns face each other across the middle of the stage --
 * for 29 frames, then let go. Run identically across every engine in
 * `engines`.
 */
function bringIntoContact(engines) {
  for (const g of engines) {
    g.press("KeyD");
    g.press("ArrowLeft");
  }
  for (const g of engines) g.pump(29);
  for (const g of engines) {
    g.release("KeyD");
    g.release("ArrowLeft");
  }
}

/**
 * Trade jabs for `rounds` rounds, identically across every engine in
 * `engines`: both seats' attack key held for 2 frames then released, then 6
 * frames to let the swing (and, when it connects, hitstun) play out before
 * the next one. A plain walk-and-swing script mostly whiffs a jab's few-
 * frame-active hitbox as the fighters keep walking past each other; closing
 * the distance once with bringIntoContact() and then holding position while
 * trading blows here is what actually connects. Verified empirically: with
 * this stage's spawn points, one seat's jab starts landing (health 100 ->
 * 90) within the first ~15 rounds and the fight is deterministic -- 3
 * consecutive runs of this exact script produced byte-identical fighter
 * state and stateHash every time. Always leaves both attack keys released,
 * whatever `rounds` is, so a caller can chain more rounds or a plain
 * `pump()` afterward without an attack key stuck down.
 *
 * `onRound`, if given, runs once per round with the round index -- the hook
 * the audio tests use to emit cues without duplicating this script.
 */
function tradeBlows(engines, rounds, onRound) {
  for (let r = 0; r < rounds; r++) {
    for (const g of engines) {
      g.press("KeyG");
      g.press("Comma");
    }
    for (const g of engines) g.pump(2);
    for (const g of engines) {
      g.release("KeyG");
      g.release("Comma");
    }
    for (const g of engines) g.pump(6);
    if (onRound) onRound(r);
  }
}

/* The whole safety argument in one test: two engines fed identical inputs must
   reach identical state, whether or not either of them is making noise. If
   audio ever reads a value it then writes back, this is what catches it --
   `fighters` is a legible six-field readout for when this fails, but
   `stateHash` is the assertion with teeth: bit-exact floats across all
   eleven fighter fields stateHash covers, plus every projectile position,
   none of which `fighters` exposes.

   Measured, the same way as the test below: emitting throughout an
   unbroken 30 rounds of tradeBlows with no idle stretch catches `combo`
   for a sufficiently non-idempotent write (confirmed with combo forced to
   99; forcing it to 1 was not enough, since real combat already passes
   through 1 on its own early in the fight, making that particular write a
   no-op most of the time it lands). It shares the test below's blind spot
   for `ultMeter` and `volleyHits` regardless -- nothing in this script
   casts an ult, so neither is ever read, no matter how long the fight
   runs. */
test("an engine with audio and one without stay in identical states", async () => {
  const loud = await bootGame({ audio: true });
  const mute = await bootGame();
  // Unlocking directly, rather than loud.press("KeyZ"), means the two
  // engines are fed strictly identical input throughout the test: a
  // one-sided keypress is inert at the title screen today, but it is a
  // trap waiting for KeyZ to mean something there later, and unlock()
  // touches only AUDIO.ac/master, never `held`, so there is nothing for it
  // to feed unevenly in the first place.
  loud.nw.audio.unlock();

  for (const g of [loud, mute]) enterTwoPlayerBattle(g);
  for (const g of [loud, mute]) {
    assert.equal(
      g.nw.scene,
      "battle",
      "the script above should have started a real fight"
    );
  }

  bringIntoContact([loud, mute]);
  // Emit on the loud engine only, varying slot and x every round so cue(),
  // audioVoice(), the pan math and the voice limiter all genuinely execute
  // during the frames being compared -- not just audioFlush pruning an
  // empty batch.
  tradeBlows([loud, mute], 30, (r) => {
    loud.nw.audio.emit("test-a", { slot: r % 2, x: (r * 11) % 320 });
  });

  const fighters = loud.nw.fighters;
  assert.ok(
    fighters.some((f) => f.health < 100),
    "the script above should have landed a real hit, not just moved around"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(fighters)),
    JSON.parse(JSON.stringify(mute.nw.fighters)),
    "audio must be invisible to the simulation"
  );
  assert.equal(
    loud.nw.__test.stateHash(),
    mute.nw.__test.stateHash(),
    "audio must be invisible to the simulation, bit for bit"
  );
  assert.ok(
    voiceCount(loud.audioLog) > 0,
    "the loud engine really did make sound"
  );
});

/* This is the only test that runs audioVoice against a live battle, so it is
   the one built to catch a write the moment it happens rather than after
   the frames being compared have already settled.

   An earlier version let ~60 idle frames pass after the flush before
   comparing (every key released). Measured with an actual write injected
   into audioVoice: an idle window erased a position/velocity-class write
   outright -- vx snaps to exactly 0 when grounded with no input held -- and
   never made a hitstop-class write observable at all, since nothing was
   happening for an extra frozen frame to shift the timing of. Fixed by
   checking stateHash immediately after the flush, before anything can
   settle a position/velocity write away, and by replacing the idle window
   with more rounds of tradeBlows(), so hitstop has real behavior to alter.

   Adding a shield hold to also catch `shield` turned out not to be a matter
   of just inserting it: placed before tradeBlows() (right after the flush,
   which is also the only place shield is still close to whatever the write
   left it at, since it regenerates every frame it is not held), it reliably
   erased the hitstop-class divergence before tradeBlows() ever got to
   develop it -- measured directly, and confirmed the trigger is timing, not
   the shield mechanic specifically: even a few idle frames inserted in that
   same spot, with no shield involved at all, erased hitstop just as
   completely. tradeBlows() has to run immediately after the flush with
   nothing between them for that check to mean anything. So the hold runs
   after tradeBlows() instead, checked separately -- costing nothing, since
   measurement showed seat 0's shield regenerates only to ~2.7 (of a max of
   100) over those 8 rounds, most of them spent attacking rather than idle.

   What is and is not caught, measured field by field against the fields
   this task's own rationale names, by injecting a write into audioVoice
   and running the real suite against it:
     - vx, x (position/velocity-class): caught, by the immediate hash check.
     - hitstop: caught, by the hash after the active window -- specifically
       the hash, not `fighters`, which still agreed at that point.
     - shield: caught, by the hold after that -- specifically by the
       `fighters` deepEqual, via `state` ("break" vs "shield"), which stays
       different even once stateHash's own numeric fields (y, vy, grounded)
       reconverge from the landing. This is the case the `fighters`
       comparison exists for: legible, and catching what the hash alone
       would have let through by then.
     - ultMeter, volleyHits: NOT caught. Nothing in this script casts an
       ult, so ultMeter is never read; volleyHits needs a multi-projectile
       move only an ult provides, so nothing ever produces a volley to
       register a hit against. A write into either ships undetected here.
     - combo: NOT caught here, but IS caught by the test above for a
       sufficiently non-idempotent write (measured with combo forced to 99;
       forcing it to 1 was not enough to diverge, since real combat already
       passes through 1 early on) -- see that test's own comment for why
       the two differ on this one field. */
test("flushing a cue mid-match does not change the simulation", async () => {
  const wired = await bootGame({ audio: true });
  const mute = await bootGame();
  // See the comment in the test above: unlock directly so both engines get
  // strictly identical input.
  wired.nw.audio.unlock();

  for (const g of [wired, mute]) enterTwoPlayerBattle(g);
  for (const g of [wired, mute]) {
    assert.equal(
      g.nw.scene,
      "battle",
      "the script above should have started a real fight"
    );
  }

  bringIntoContact([wired, mute]);
  tradeBlows([wired, mute], 15); // real mid-match state: a hit has landed
  assert.ok(
    wired.nw.fighters.some((f) => f.health < 100),
    "expected a real hit to have landed before the flush under test"
  );

  wired.nw.audio.emit("test-a", { slot: 0, frame: 1 });
  wired.nw.audio.flush();
  assert.ok(
    voiceCount(wired.audioLog) > 0,
    "the cue under test should have actually produced a voice"
  );

  // Checked here, before anything else runs, because a position/velocity
  // class write is exactly the kind of thing ongoing physics settles away
  // (see the comment above) -- this is the one place it is still visible.
  assert.equal(
    wired.nw.__test.stateHash(),
    mute.nw.__test.stateHash(),
    "state must be identical immediately after the flush"
  );

  // Active propagation window: more rounds of tradeBlows, not an idle
  // pump(), so a field like hitstop has real behavior to alter rather than
  // two characters standing still with nothing happening for it to change.
  // This has to run right here, with nothing between it and the flush
  // above: measured that even a few idle frames inserted before it are
  // enough to let a hitstop-class divergence resolve itself before
  // tradeBlows ever presses a key, which is exactly the kind of thing this
  // window exists to prevent.
  tradeBlows([wired, mute], 8);

  // Checked again here, because this is the window a hitstop-class write
  // actually surfaces in: measured with hitstop injected, this checkpoint
  // catches it via stateHash while `fighters` below still agrees.
  assert.equal(
    wired.nw.__test.stateHash(),
    mute.nw.__test.stateHash(),
    "state must be identical after the active window"
  );

  // Hold seat 0's shield key so a write into `shield` is live: the drain
  // only reads it, and only trips the break branch, while the key is
  // actually held. This runs after tradeBlows(8) rather than before it, so
  // it cannot cost the hitstop check above -- and it still works from
  // here: measured that seat 0's shield regenerates only to ~2.7 (of a max
  // 100) over those 8 rounds, since most of them are spent attacking, not
  // idle, and the same measurement showed the first several held frames
  // are still spent finishing whatever attack was in progress -- shield is
  // only read once a fighter returns to its free state. 20 frames covers
  // that startup and still breaks seat 0 with room to spare, while the
  // other seat's untouched shield (100) is nowhere close to breaking. The
  // break shows up in the `fighters` comparison below via `state`
  // ("break" vs "shield") even after stateHash's own numeric fields (y,
  // vy, grounded) have reconverged from the landing -- exactly the
  // "legible readout catches what the hash alone would miss" case the
  // `fighters` comparison exists for.
  for (const g of [wired, mute]) g.press("ShiftLeft");
  for (const g of [wired, mute]) g.pump(20);
  for (const g of [wired, mute]) g.release("ShiftLeft");

  assert.deepEqual(
    JSON.parse(JSON.stringify(wired.nw.fighters)),
    JSON.parse(JSON.stringify(mute.nw.fighters))
  );
  assert.equal(wired.nw.__test.stateHash(), mute.nw.__test.stateHash());
});

/* The existing "no Web Audio at all" test above only pumps frames -- it never
   presses a key or clicks the canvas, so audioUnlock()'s actual behavior with
   no AudioContext in scope (the real case on a browser with audio blocked)
   never runs. Both keydown and mousedown call audioUnlock() unconditionally,
   before anything else, so this drives that exact path and checks it leaves
   the game exactly as untouched as inspection alone suggested. */
test("a key press and a canvas click do not throw with no Web Audio at all", async () => {
  const g = await bootGame();
  assert.doesNotThrow(() => {
    g.press("KeyZ");
    g.click();
  }, "audioUnlock must survive a missing AudioContext constructor");
  assert.equal(
    g.nw.audio.ready,
    false,
    "no AudioContext exists anywhere, so audio can never become ready"
  );
  g.pump(60);
  // >= 55, not merely > 0: a loop that ran once and then stalled would pass
  // a bare ">0" check. The file's first test holds itself to the same bar
  // (> 100 after pump(120)).
  assert.ok(
    g.nw.frames >= 55,
    "the loop should keep running after the gesture, not stall after one tick"
  );
});

/* audioFlush wraps each item's audioVoice call in its own try/catch for one
   reason: a single malformed recipe must not throw out of frame() and stop
   requestAnimationFrame from ever being called again. Nothing in the suite
   above ever drives a recipe through that catch, because the recording fake
   context accepts any input without complaint. throwingAudioContext exists
   to make one specific call fail -- the next oscillator built after the test
   arms it -- while a second cue in the same flush must still reach the
   graph. */
test("a cue that throws inside audioVoice does not stop the rest of the flush", async () => {
  const g = await bootGame({
    audio: true,
    makeAudioContext: throwingAudioContext,
  });
  g.press("KeyZ");
  g.recorder.arm(); // only the very next oscillator built will throw
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-a", { slot: 1, frame: 100 });
  assert.doesNotThrow(
    () => g.nw.audio.flush(),
    "one bad voice must not freeze the loop"
  );
  assert.equal(
    voiceCount(g.audioLog),
    1,
    "the second, valid cue should still have played"
  );
});
