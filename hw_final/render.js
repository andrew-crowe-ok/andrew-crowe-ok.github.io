// Placeholder renderer: flat-colored 2D triangles, top-down. It only reads
// `table` and `game` from physics.js and is meant to be replaced.

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
in vec3 aColor;
uniform vec2 uScale;     // table units -> clip space
uniform vec2 uOffset;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPosition * uScale + uOffset, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 fragColor;
void main() { fragColor = vec4(vColor, 1.0); }`;

const COLORS = {
  background: [0.05, 0.05, 0.08],
  playfield: [0.08, 0.22, 0.20],
  wall: [0.75, 0.75, 0.80],
  bumper: [0.85, 0.35, 0.20],
  bumperLit: [1.0, 0.9, 0.4],
  flipper: [0.95, 0.90, 0.80],
  ball: [0.85, 0.85, 0.90],
  plunger: [0.6, 0.4, 0.2],
};

const canvas = document.getElementById("glcanvas");
const gl = canvas.getContext("webgl2");

function compile(type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
gl.bindAttribLocation(program, 0, "aPosition");
gl.bindAttribLocation(program, 1, "aColor");
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
gl.useProgram(program);

const uScale = gl.getUniformLocation(program, "uScale");
const uOffset = gl.getUniformLocation(program, "uOffset");

const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.enableVertexAttribArray(0);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);

// The whole scene is rebuilt as a triangle list every frame; it's tiny.
let verts = [];
function tri(a, b, c, col) {
  for (const p of [a, b, c]) verts.push(p[0], p[1], col[0], col[1], col[2]);
}
function quad(a, b, c, d, col) { tri(a, b, c, col); tri(a, c, d, col); }
function circle(c, r, col, n = 24) {
  for (let i = 0; i < n; i++) {
    const a0 = 2 * Math.PI * i / n, a1 = 2 * Math.PI * (i + 1) / n;
    tri(c, [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)],
           [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)], col);
  }
}
function capsule(a, b, r, col) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nx = -(b[1] - a[1]) / len * r, ny = (b[0] - a[0]) / len * r;
  quad([a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny],
       [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny], col);
  circle(a, r, col, 12);
  circle(b, r, col, 12);
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  gl.viewport(0, 0, w, h);
}

function render() {
  resize();

  // Fit the table (plus a margin) into the canvas, preserving aspect
  const margin = 1;
  const w = table.width + 2 * margin, h = table.height + 2 * margin;
  const fit = Math.min(canvas.width / w, canvas.height / h);
  const sx = 2 * fit / canvas.width, sy = 2 * fit / canvas.height;
  gl.uniform2f(uScale, sx, sy);
  gl.uniform2f(uOffset, -table.width / 2 * sx, -table.height / 2 * sy);

  verts = [];
  quad([0, 0], [table.width, 0], [table.width, table.height], [0, table.height], COLORS.playfield);
  for (const w of table.walls) capsule(w.a, w.b, 0.12, COLORS.wall);
  for (const bp of table.bumpers) circle(bp.c, bp.r, bp.lit > 0 ? COLORS.bumperLit : COLORS.bumper);
  for (const f of table.flippers) capsule(f.pivot, flipperTip(f), f.radius, COLORS.flipper);

  // Plunger drawn pulled down by the current charge
  const px = (LANE_X + table.width) / 2;
  capsule([px, -0.2 - game.charge * 1.5], [px, 0.3 - game.charge * 1.5], 0.3, COLORS.plunger);

  circle(game.ball.p, BALL_RADIUS, COLORS.ball);

  gl.clearColor(...COLORS.background, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.TRIANGLES, 0, verts.length / 5);
}
