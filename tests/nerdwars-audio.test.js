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
