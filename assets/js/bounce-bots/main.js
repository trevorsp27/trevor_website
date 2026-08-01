// Page wiring: lobby setup, host/client roles, input, and rendering.
//
// The one idea that keeps this manageable: every player action goes through
// `send()`. On the host that calls the game directly; on a client it posts to
// the host. Nothing else in the UI needs to know which role it is running.

import { generateBoard, makeLobbyCode } from "./board.js";
import { applyMove } from "./rules.js";
import { HostGame, PHASES, DEFAULT_SETTINGS, HEARTBEAT_MS } from "./game.js";
import { createHost, createClient } from "./net.js";
import { BoardView, ROBOT_COLORS, colorFor } from "./ui.js";
import { COLORS, ROBOT_COUNT } from "./constants.js";

const $ = (id) => document.getElementById(id);

const HOST_ID = "host";

const state = {
  role: null, // "host" | "client"
  me: null,
  name: "",
  net: null,
  game: null, // host only
  snapshot: null,
  board: null,
  boardKey: "",
  view: null,
  selected: 0,
  // Local sandbox used while thinking and bidding, so players can count a
  // solution without anyone else seeing it.
  scratch: null,
  scratchMoves: 0,
  scratchRound: -1,
  heartbeat: null
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  state.view = new BoardView($("bb-canvas"), { onRobotPick: selectRobot });
  window.addEventListener("resize", () => state.view.resize());

  const savedName = localStorage.getItem("bb-name") || "";
  $("bb-name").value = savedName;

  const params = new URLSearchParams(window.location.search);
  const invited = params.get("lobby");
  if (invited) {
    $("bb-join-code").value = invited.toUpperCase();
    $("bb-mode-join").checked = true;
    syncModePanels();
  }

  $("bb-mode-host").addEventListener("change", syncModePanels);
  $("bb-mode-join").addEventListener("change", syncModePanels);
  $("bb-create").addEventListener("click", startHosting);
  $("bb-join").addEventListener("click", startJoining);

  $("bb-bid-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitBid();
  });

  $("bb-reset").addEventListener("click", resetBoardForMe);
  $("bb-pass").addEventListener("click", () => send({ type: "demo-pass" }));
  $("bb-start").addEventListener("click", () => send({ type: "start" }));
  $("bb-lock").addEventListener("click", () => send({ type: "lock" }));
  $("bb-skip").addEventListener("click", () => send({ type: "skip" }));
  $("bb-copy").addEventListener("click", copyInvite);

  buildRobotButtons();
  document.addEventListener("keydown", handleKey);
  setInterval(renderClock, 250);

  syncModePanels();
}

function syncModePanels() {
  const hosting = $("bb-mode-host").checked;
  $("bb-host-fields").hidden = !hosting;
  $("bb-join-fields").hidden = hosting;
}

function buildRobotButtons() {
  const wrap = $("bb-robots");
  wrap.innerHTML = "";
  COLORS.forEach((color, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bb-robot-btn";
    button.dataset.robot = String(index);
    button.style.setProperty("--bb-robot", ROBOT_COLORS[color]);
    button.innerHTML = `<span class="bb-dot"></span>${index + 1}`;
    button.title = `Select the ${color} robot (press ${index + 1})`;
    button.addEventListener("click", () => selectRobot(index));
    wrap.appendChild(button);
  });
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

function readName() {
  const name = ($("bb-name").value || "").trim().slice(0, 18) || "Player";
  localStorage.setItem("bb-name", name);
  return name;
}

function startHosting() {
  state.name = readName();
  state.role = "host";
  state.me = HOST_ID;

  const settings = {
    ...DEFAULT_SETTINGS,
    difficulty: $("bb-difficulty").value,
    useDiagonals: $("bb-diagonals").checked,
    rounds: Number($("bb-rounds").value),
    bidSeconds: Number($("bb-bid-seconds").value)
  };

  openLobby(makeLobbyCode(), settings);
}

function openLobby(code, settings) {
  setStatus(`Opening lobby ${code}…`);

  state.game = new HostGame({
    code,
    hostId: HOST_ID,
    hostName: state.name,
    settings,
    onChange: (snapshot) => {
      state.net?.broadcast({ type: "state", snapshot });
      applySnapshot(snapshot);
    }
  });

  state.net = createHost(code, {
    onReady: () => {
      showGame();
      setStatus(`Lobby ${code} is open. Share the link and press Start.`);
      applySnapshot(state.game.snapshot());
    },
    // Another lobby already owns this code, so quietly take a different one.
    onCodeTaken: () => {
      state.net?.destroy();
      openLobby(makeLobbyCode(), settings);
    },
    onJoin: (peerId, conn) => {
      conn.send({ type: "state", snapshot: state.game.snapshot() });
    },
    onLeave: (peerId) => state.game.removePlayer(peerId),
    onMessage: handleHostMessage,
    onError: (err) => setStatus(`Connection error: ${err?.message || err}`)
  });

  setInterval(() => state.game?.tick(), 250);
}

function startJoining() {
  state.name = readName();
  state.role = "client";

  const code = ($("bb-join-code").value || "").trim().toUpperCase();
  if (code.length < 4) {
    setStatus("Enter the four-character lobby code.");
    return;
  }

  setStatus(`Connecting to ${code}…`);
  state.net = createClient(code, {
    onOpen: () => {
      state.net.send({ type: "join", name: state.name });
      showGame();
      setStatus(`Connected to ${code}. Waiting for the leader to start.`);

      // Report in regularly so the host can tell a closed tab from a quiet one.
      clearInterval(state.heartbeat);
      state.heartbeat = setInterval(() => state.net?.send({ type: "ping" }), HEARTBEAT_MS);
    },
    onMessage: (message) => {
      if (message?.type === "state") {
        state.me = message.snapshot.youAre || state.me;
        applySnapshot(message.snapshot);
      }
    },
    onNoSuchLobby: () => setStatus(`No lobby named ${code} is open right now.`),
    onClose: () => setStatus("Lost connection to the lobby leader."),
    onError: (err) => setStatus(`Connection error: ${err?.message || err}`)
  });
}

// The host receives every client action here and applies it under its own
// authority. A client can only ever speak for itself: `peerId` comes from the
// connection, never from the message body.
function handleHostMessage(peerId, message) {
  const game = state.game;
  if (!game || !message) return;

  switch (message.type) {
    case "ping":
      game.heartbeat(peerId);
      break;
    case "join":
      game.addPlayer(peerId, String(message.name || "Player").slice(0, 18));
      // Tell the newcomer which player they are.
      state.net.sendTo(peerId, {
        type: "state",
        snapshot: { ...game.snapshot(), youAre: peerId }
      });
      break;
    case "bid":
      game.bid(peerId, message.moves);
      break;
    case "demo-move":
      game.demoMove(peerId, message.robot, message.dir);
      break;
    case "demo-reset":
      game.resetDemo(peerId);
      break;
    case "demo-pass":
      game.passDemo(peerId);
      break;
    default:
      break;
  }
}

// One entry point for every action, whichever role we are.
function send(action) {
  if (state.role === "host") {
    const game = state.game;
    if (!game) return;
    switch (action.type) {
      case "start":
        game.start(HOST_ID);
        break;
      case "lock":
        game.lockBids(HOST_ID);
        break;
      case "skip":
        game.skipRound(HOST_ID);
        break;
      case "bid":
        game.bid(HOST_ID, action.moves);
        break;
      case "demo-move":
        game.demoMove(HOST_ID, action.robot, action.dir);
        break;
      case "demo-reset":
        game.resetDemo(HOST_ID);
        break;
      case "demo-pass":
        game.passDemo(HOST_ID);
        break;
      default:
        break;
    }
    return;
  }
  state.net?.send(action);
}

// ---------------------------------------------------------------------------
// Snapshot handling
// ---------------------------------------------------------------------------

function applySnapshot(snapshot) {
  state.snapshot = snapshot;

  // Rebuild the board only when the seed or generation settings actually
  // change -- generation is deterministic, so this is safe to skip otherwise.
  const key = `${snapshot.code}|${snapshot.settings.difficulty}|${snapshot.settings.useDiagonals}`;
  if (key !== state.boardKey) {
    state.boardKey = key;
    state.board = generateBoard({
      code: snapshot.code,
      difficulty: snapshot.settings.difficulty,
      useDiagonals: snapshot.settings.useDiagonals
    });
    state.view.setBoard(state.board);
  }

  // A new round resets the private sandbox.
  if (snapshot.round !== state.scratchRound) {
    state.scratchRound = snapshot.round;
    state.scratch = snapshot.startPositions ? snapshot.startPositions.slice() : null;
    state.scratchMoves = 0;
    $("bb-bid-input").value = "";
  }

  render();
}

function isScratchPhase() {
  const phase = state.snapshot?.phase;
  return phase === PHASES.THINKING || phase === PHASES.BIDDING;
}

function amDemonstrating() {
  return state.snapshot?.phase === PHASES.DEMO && state.snapshot.currentDemo === state.me;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function selectRobot(index) {
  if (index < 0 || index >= ROBOT_COUNT) return;
  state.selected = index;
  state.view.setSelected(index);
  render();
}

const KEY_DIRS = {
  ArrowUp: 0,
  ArrowRight: 1,
  ArrowDown: 2,
  ArrowLeft: 3,
  w: 0,
  d: 1,
  s: 2,
  a: 3
};

function handleKey(event) {
  // Never hijack keys while someone is typing a bid or a name.
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (!state.snapshot) return;

  if (event.key >= "1" && event.key <= String(ROBOT_COUNT)) {
    selectRobot(Number(event.key) - 1);
    event.preventDefault();
    return;
  }

  const dir = KEY_DIRS[event.key];
  if (dir === undefined) return;
  event.preventDefault();
  moveSelected(dir);
}

function moveSelected(dir) {
  if (amDemonstrating()) {
    // Authoritative: the host validates and echoes the result back.
    send({ type: "demo-move", robot: state.selected, dir });
    return;
  }

  if (!isScratchPhase() || !state.scratch || !state.board) return;

  const next = applyMove(state.board, state.scratch, state.selected, dir);
  if (!next) return;
  state.scratch = next;
  state.scratchMoves += 1;
  render();
}

function resetBoardForMe() {
  if (amDemonstrating()) {
    send({ type: "demo-reset" });
    return;
  }
  if (!state.snapshot?.startPositions) return;
  state.scratch = state.snapshot.startPositions.slice();
  state.scratchMoves = 0;
  render();
}

function submitBid() {
  const raw = Number($("bb-bid-input").value);
  if (!Number.isFinite(raw) || raw < 1) {
    setStatus("Enter how many moves your solution takes.");
    return;
  }
  send({ type: "bid", moves: Math.round(raw) });
}

function copyInvite() {
  const code = state.snapshot?.code;
  if (!code) return;
  const url = `${window.location.origin}${window.location.pathname}?lobby=${code}`;
  navigator.clipboard?.writeText(url).then(
    () => setStatus("Invite link copied."),
    () => setStatus(`Invite link: ${url}`)
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function showGame() {
  $("bb-setup").hidden = true;
  $("bb-game").hidden = false;
  state.view.resize();
}

function setStatus(text) {
  $("bb-status").textContent = text;
}

function render() {
  const snap = state.snapshot;
  if (!snap) return;

  const showScratch = isScratchPhase();
  const positions = showScratch ? state.scratch : snap.positions;

  state.view.setState({
    positions,
    target: snap.target,
    // Grey the board while someone else demonstrates: you are watching, not playing.
    dim: snap.phase === PHASES.DEMO && !amDemonstrating()
  });

  $("bb-code").textContent = snap.code;
  $("bb-round").textContent = snap.round ? `Round ${snap.round} / ${snap.totalRounds}` : "Lobby";
  $("bb-phase").textContent = phaseLabel(snap);

  renderTarget(snap);
  renderPlayers(snap);
  renderControls(snap, showScratch);
  renderClock();

  document.querySelectorAll(".bb-robot-btn").forEach((btn) => {
    btn.classList.toggle("is-active", Number(btn.dataset.robot) === state.selected);
  });
}

function phaseLabel(snap) {
  switch (snap.phase) {
    case PHASES.LOBBY:
      return "Waiting in the lobby";
    case PHASES.THINKING:
      return "Find a solution — the first bid starts the clock";
    case PHASES.BIDDING:
      return "Bidding open";
    case PHASES.DEMO: {
      const who = snap.players.find((p) => p.id === snap.currentDemo);
      return amDemonstrating()
        ? `Your turn — solve it in ${snap.currentBid}`
        : `${who?.name || "Someone"} is demonstrating (${snap.currentBid})`;
    }
    case PHASES.REVEAL:
      return snap.lastRound?.winnerId
        ? `${snap.lastRound.winnerName} solved it in ${snap.lastRound.used}`
        : "Nobody solved it";
    case PHASES.OVER:
      return "Game over";
    default:
      return "";
  }
}

function renderTarget(snap) {
  const box = $("bb-target");
  if (!snap.target) {
    box.textContent = "—";
    box.style.color = "";
    return;
  }
  const label = snap.target.color === "wild" ? "Any robot" : `${snap.target.color} robot`;
  box.textContent = `${label} → ${snap.target.shape}`;
  box.style.color = colorFor(snap.target.color);
}

function renderPlayers(snap) {
  const bids = new Map(snap.bids.map((b) => [b.id, b.moves]));
  const rows = [...snap.players]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((player) => {
      const marks = [];
      if (player.id === snap.hostId) marks.push("leader");
      if (!player.connected) marks.push("offline");
      if (player.id === snap.currentDemo) marks.push("demonstrating");

      const bid = bids.get(player.id);
      // Bids are public: underbidding is the whole game.
      const bidText = bid ? `<span class="bb-bid-chip">${bid}</span>` : "";
      const you = player.id === state.me ? " is-you" : "";

      return `<li class="bb-player${you}${player.connected ? "" : " is-offline"}">
        <span class="bb-player-name">${escapeHtml(player.name)}</span>
        ${bidText}
        <span class="bb-score">${player.score}</span>
        ${marks.length ? `<span class="bb-tags">${marks.join(" · ")}</span>` : ""}
      </li>`;
    })
    .join("");

  $("bb-players").innerHTML = rows;
}

function renderControls(snap, showScratch) {
  const isHost = state.me === snap.hostId;
  const inPlay = snap.phase !== PHASES.LOBBY && snap.phase !== PHASES.OVER;

  $("bb-host-controls").hidden = !isHost;
  $("bb-start").hidden = inPlay;
  $("bb-start").textContent = snap.phase === PHASES.OVER ? "Play again" : "Start game";
  $("bb-lock").hidden = snap.phase !== PHASES.BIDDING;
  $("bb-skip").hidden = !inPlay;

  const canBid = snap.phase === PHASES.THINKING || snap.phase === PHASES.BIDDING;
  $("bb-bid-form").hidden = !canBid;
  $("bb-pass").hidden = !amDemonstrating();
  $("bb-reset").hidden = !(showScratch || amDemonstrating());

  // The move counter means different things in each phase, so label it.
  const counter = $("bb-moves");
  if (amDemonstrating()) {
    counter.textContent = `${snap.demoMoveCount} / ${snap.currentBid} moves used`;
  } else if (showScratch) {
    counter.textContent = `${state.scratchMoves} moves tried (private)`;
  } else {
    counter.textContent = "";
  }

  const note = $("bb-note");
  if (snap.phase === PHASES.REVEAL && snap.lastRound) {
    const optimal = snap.lastRound.optimal;
    note.textContent = snap.lastRound.winnerId
      ? `Best possible was ${optimal ?? "?"} moves.`
      : `The optimal solution was ${optimal ?? "?"} moves.`;
  } else if (snap.notice) {
    note.textContent = snap.notice;
  } else {
    note.textContent = "";
  }
}

function renderClock() {
  const snap = state.snapshot;
  const el = $("bb-timer");
  if (!snap || !el) return;

  let deadline = 0;
  if (snap.phase === PHASES.BIDDING) deadline = snap.bidDeadline;
  else if (snap.phase === PHASES.DEMO) deadline = snap.demoDeadline;
  else if (snap.phase === PHASES.REVEAL) deadline = snap.revealDeadline;

  if (!deadline) {
    el.textContent = "";
    el.classList.remove("is-urgent");
    return;
  }

  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  el.textContent = `${left}s`;
  el.classList.toggle("is-urgent", left <= 10);
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

boot();
