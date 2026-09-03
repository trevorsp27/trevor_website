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
 * Boot one engine.
 * @param {object} [opts]
 * @param {boolean} [opts.audio] install a recording AudioContext (default off,
 *   which is the important case: the engine must survive without one)
 */
async function bootGame(opts) {
  const withAudio = !!(opts && opts.audio);
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
      recorder = recordingAudioContext();
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
