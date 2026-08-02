// Canvas renderer for the board.
//
// Canvas rather than DOM because walls live on cell *edges*, not cells. Drawing
// 400-odd edge segments as elements would mean a wrapper per cell and a lot of
// fighting with border collapse; here it is a handful of stroked lines.

import { SIZE, DIRS, N, E, S, W, COLORS, CELEBRATE_MS, xOf, yOf } from "./constants.js?v=20260802d";
import { slide } from "./rules.js?v=20260802d";

export const ROBOT_COLORS = {
  red: "#e5484d",
  blue: "#4a8cf7",
  green: "#46b17b",
  yellow: "#e8c33c",
  silver: "#c3c7d1"
};

const WILD_COLOR = "#c77dff";
const MOVE_MS = 140;

export function colorFor(name) {
  return name === "wild" ? WILD_COLOR : ROBOT_COLORS[name] || "#ffffff";
}

export class BoardView {
  constructor(canvas, { onRobotPick } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onRobotPick = onRobotPick || (() => {});

    this.board = null;
    this.positions = null;
    this.prevPositions = null;
    this.target = null;
    this.selected = 0;
    this.dim = false;
    this.celebrateUntil = 0;
    this.celebrating = false;

    // Animation state: which robot is sliding, along what path, since when.
    this.anim = null;

    this.cell = 0;
    this.pad = 0;

    canvas.addEventListener("click", (event) => this.handleClick(event));
    this.resize();
  }

  setBoard(board) {
    this.board = board;
    this.prevPositions = null;
    this.anim = null;
    this.draw();
  }

  setSelected(index) {
    this.selected = index;
    this.draw();
  }

  // `dim` greys the board out when the viewer is watching rather than playing.
  setState({ positions, target, dim = false, celebrateUntil = 0 }) {
    if (positions && this.positions && this.board) {
      this.startAnimation(this.positions, positions);
    }
    this.positions = positions ? positions.slice() : null;
    this.target = target;
    this.dim = dim;

    if (celebrateUntil !== this.celebrateUntil) {
      this.celebrateUntil = celebrateUntil;
      if (celebrateUntil > Date.now()) this.runCelebration();
    }
    this.draw();
  }

  // Rings expanding out of the solved square. Drives its own frame loop rather
  // than piggy-backing on the move animation, since the two can overlap: the
  // winning robot is still sliding into place when the celebration starts.
  runCelebration() {
    if (this.celebrating) return;
    this.celebrating = true;

    const step = () => {
      if (Date.now() >= this.celebrateUntil) {
        this.celebrating = false;
        this.draw();
        return;
      }
      this.draw();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Recover the slide path so the animation bends correctly around diagonals.
  // Exactly one robot moves per step, so trying its four directions from the
  // previous arrangement identifies the move that produced the new one.
  startAnimation(from, to) {
    let moved = -1;
    for (let i = 0; i < to.length; i += 1) {
      if (from[i] !== to[i]) {
        if (moved >= 0) return; // more than one change: a reset, not a move
        moved = i;
      }
    }
    if (moved < 0) return;

    for (let dir = 0; dir < 4; dir += 1) {
      const { to: dest, path } = slide(this.board, from, moved, dir);
      if (dest === to[moved]) {
        this.anim = { robot: moved, path, start: performance.now() };
        this.tick();
        return;
      }
    }
  }

  tick() {
    if (!this.anim) return;
    this.draw();
    if (this.anim) requestAnimationFrame(() => this.tick());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.max(240, Math.min(rect.width, rect.height || rect.width));
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.pad = Math.round(size * 0.02);
    this.cell = (size - this.pad * 2) / SIZE;
    this.draw();
  }

  handleClick(event) {
    if (!this.positions) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left - this.pad) / this.cell);
    const y = Math.floor((event.clientY - rect.top - this.pad) / this.cell);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;

    const cell = y * SIZE + x;
    const robot = this.positions.indexOf(cell);
    if (robot >= 0) this.onRobotPick(robot);
  }

  cx(x) {
    return this.pad + x * this.cell;
  }

  cy(y) {
    return this.pad + y * this.cell;
  }

  draw() {
    const { ctx, board } = this;
    if (!ctx) return;

    const size = this.pad * 2 + this.cell * SIZE;
    ctx.clearRect(0, 0, size, size);

    ctx.fillStyle = "#0e0e0e";
    ctx.fillRect(0, 0, size, size);

    if (!board) return;
    ctx.save();
    if (this.dim) ctx.globalAlpha = 0.45;

    this.drawGrid();
    this.drawCenter();
    this.drawDiagonals();
    this.drawTarget();
    this.drawWalls();
    this.drawRobots();
    this.drawCelebration();

    ctx.restore();
  }

  drawCelebration() {
    const remaining = this.celebrateUntil - Date.now();
    if (!this.target || remaining <= 0) return;

    const { ctx } = this;
    const elapsed = CELEBRATE_MS - remaining;
    const cx = this.cx(xOf(this.target.cell)) + this.cell / 2;
    const cy = this.cy(yOf(this.target.cell)) + this.cell / 2;
    const color = colorFor(this.target.color);

    // Three rings staggered so they read as a pulse rather than one blob.
    const RING_MS = 1000;
    const STAGGER = 320;

    for (let i = 0; i < 3; i += 1) {
      const t = (elapsed - i * STAGGER) / RING_MS;
      if (t < 0 || t > 1) continue;

      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, this.cell * 0.12 * (1 - t));
      ctx.beginPath();
      ctx.arc(cx, cy, this.cell * (0.3 + t * 1.6), 0, Math.PI * 2);
      ctx.stroke();
    }

    // A brief bloom on the square itself, fading over the first half.
    const bloom = Math.max(0, 1 - elapsed / (CELEBRATE_MS * 0.5));
    if (bloom > 0) {
      ctx.globalAlpha = bloom * 0.4;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, this.cell * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  drawGrid() {
    const { ctx } = this;
    ctx.strokeStyle = "#232323";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= SIZE; i += 1) {
      const p = this.cx(i);
      ctx.moveTo(p, this.cy(0));
      ctx.lineTo(p, this.cy(SIZE));
      ctx.moveTo(this.cx(0), this.cy(i));
      ctx.lineTo(this.cx(SIZE), this.cy(i));
    }
    ctx.stroke();
  }

  drawCenter() {
    const { ctx, board } = this;
    ctx.fillStyle = "#191919";
    for (let cell = 0; cell < board.blocked.length; cell += 1) {
      if (!board.blocked[cell]) continue;
      ctx.fillRect(this.cx(xOf(cell)), this.cy(yOf(cell)), this.cell, this.cell);
    }
  }

  drawDiagonals() {
    const { ctx, board } = this;
    ctx.lineWidth = Math.max(2, this.cell * 0.1);
    ctx.lineCap = "round";

    board.diagonals.forEach((diag, cell) => {
      if (!diag) return;
      const x = this.cx(xOf(cell));
      const y = this.cy(yOf(cell));
      const inset = this.cell * 0.16;

      ctx.strokeStyle = colorFor(diag.color);
      ctx.globalAlpha = this.dim ? 0.4 : 0.75;
      ctx.beginPath();
      if (diag.kind === "/") {
        ctx.moveTo(x + inset, y + this.cell - inset);
        ctx.lineTo(x + this.cell - inset, y + inset);
      } else {
        ctx.moveTo(x + inset, y + inset);
        ctx.lineTo(x + this.cell - inset, y + this.cell - inset);
      }
      ctx.stroke();
      ctx.globalAlpha = this.dim ? 0.45 : 1;
    });
  }

  // Only the live target is drawn. Robots are solid filled discs, so the
  // target is deliberately the opposite: an open reticle with corner brackets
  // and a hollow centre. Different silhouette, different fill, no overlap in
  // how the two read at a glance.
  drawTarget() {
    const { ctx } = this;
    if (!this.target) return;

    const x = this.cx(xOf(this.target.cell));
    const y = this.cy(yOf(this.target.cell));
    const size = this.cell;
    const color = colorFor(this.target.color);
    const arm = size * 0.3;
    const inset = size * 0.1;
    const weight = Math.max(2, size * 0.09);

    // Faint wash so the destination square itself is obvious.
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.14;
    ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
    ctx.globalAlpha = this.dim ? 0.45 : 1;

    // Corner brackets.
    ctx.strokeStyle = color;
    ctx.lineWidth = weight;
    ctx.lineCap = "square";
    ctx.beginPath();

    const corners = [
      [x + inset, y + inset, 1, 1],
      [x + size - inset, y + inset, -1, 1],
      [x + inset, y + size - inset, 1, -1],
      [x + size - inset, y + size - inset, -1, -1]
    ];
    corners.forEach(([px, py, sx, sy]) => {
      ctx.moveTo(px + sx * arm, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + sy * arm);
    });
    ctx.stroke();

    // Hollow centre ring, so it never reads as a filled robot.
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size * 0.15, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, size * 0.06);
    ctx.stroke();
  }

  drawWalls() {
    const { ctx, board } = this;
    ctx.strokeStyle = "#f0f0f0";
    ctx.lineWidth = Math.max(3, this.cell * 0.14);
    ctx.lineCap = "square";
    ctx.beginPath();

    for (let cell = 0; cell < board.walls.length; cell += 1) {
      const mask = board.walls[cell];
      if (!mask) continue;
      const x = this.cx(xOf(cell));
      const y = this.cy(yOf(cell));

      if (mask & N) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + this.cell, y);
      }
      if (mask & S) {
        ctx.moveTo(x, y + this.cell);
        ctx.lineTo(x + this.cell, y + this.cell);
      }
      if (mask & W) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + this.cell);
      }
      if (mask & E) {
        ctx.moveTo(x + this.cell, y);
        ctx.lineTo(x + this.cell, y + this.cell);
      }
    }
    ctx.stroke();
  }

  drawRobots() {
    const { ctx } = this;
    if (!this.positions) return;

    // Resolve the animating robot's interpolated position, if any.
    let animCell = -1;
    let animPoint = null;
    if (this.anim) {
      const t = (performance.now() - this.anim.start) / MOVE_MS;
      if (t >= 1) {
        this.anim = null;
      } else {
        const path = this.anim.path;
        const at = t * (path.length - 1);
        const i = Math.floor(at);
        const frac = at - i;
        const a = path[i];
        const b = path[Math.min(i + 1, path.length - 1)];
        animCell = this.anim.robot;
        animPoint = {
          x: xOf(a) + (xOf(b) - xOf(a)) * frac,
          y: yOf(a) + (yOf(b) - yOf(a)) * frac
        };
      }
    }

    this.positions.forEach((cell, index) => {
      const gx = index === animCell ? animPoint.x : xOf(cell);
      const gy = index === animCell ? animPoint.y : yOf(cell);

      const cxp = this.cx(gx) + this.cell / 2;
      const cyp = this.cy(gy) + this.cell / 2;
      const r = this.cell * 0.34;
      const color = ROBOT_COLORS[COLORS[index]];

      ctx.beginPath();
      ctx.arc(cxp, cyp, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      if (index === this.selected) {
        ctx.beginPath();
        ctx.arc(cxp, cyp, r + Math.max(3, this.cell * 0.11), 0, Math.PI * 2);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      ctx.fillStyle = "#0b0b0b";
      ctx.font = `700 ${Math.round(this.cell * 0.42)}px "Space Grotesk", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(index + 1), cxp, cyp + 1);
    });
  }
}
