// Rasterized 3D view of the table: Blinn-Phong with two point lights.
// Reads `table` and `game` from physics.js; physics stays 2D in the table
// plane, which is world z = 0 here (x right, y up the table, z out of it).
// Uses transforms.js / models.js from HW7.

const VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uModelView;
uniform mat4 uProjection;
out vec3 vPosition;
out vec3 vNormal;
void main() {
  vec4 p = uModelView * vec4(aPosition, 1.0);
  vPosition = p.xyz;
  vNormal = transpose(inverse(mat3(uModelView))) * aNormal;   // parts are scaled non-uniformly
  gl_Position = uProjection * p;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 vPosition;
in vec3 vNormal;
uniform vec3 uLightPos[2];      // eye space
uniform vec3 uLightColor[2];
uniform vec3 uColor;
uniform vec3 uEmissive;
uniform float uKs, uShininess, uAlpha;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vPosition);
  vec3 c = 0.18 * uColor + uEmissive;
  for (int i = 0; i < 2; i++) {
    vec3 l = normalize(uLightPos[i] - vPosition);
    vec3 h = normalize(l + v);
    float diff = max(dot(n, l), 0.0);
    float spec = diff > 0.0 ? pow(max(dot(n, h), 0.0), uShininess) : 0.0;
    c += uLightColor[i] * (diff * uColor + uKs * spec);
  }
  fragColor = vec4(c, uAlpha);
}`;

const LIGHTS = [
  { pos: [10, 10, 30], color: [1.0, 0.95, 0.85] },    // key, above mid-table
  { pos: [10, -12, 10], color: [0.25, 0.3, 0.4] },    // cool fill from the player
];

const M = {   // materials
  playfield: { color: [0.08, 0.26, 0.24], ks: 0.15, shininess: 16 },
  cabinet: { color: [0.35, 0.18, 0.08], ks: 0.2, shininess: 12 },
  apron: { color: [0.42, 0.38, 0.32], ks: 0.3, shininess: 20 },
  rail: { color: [0.72, 0.74, 0.78], ks: 0.9, shininess: 60 },
  bumper: { color: [0.85, 0.28, 0.14], ks: 0.4, shininess: 30 },
  bumperCap: { color: [0.95, 0.9, 0.78], ks: 0.4, shininess: 30 },
  flipper: { color: [0.95, 0.92, 0.84], ks: 0.4, shininess: 24 },
  rubber: { color: [0.75, 0.12, 0.1], ks: 0.2, shininess: 12 },
  ball: { color: [0.75, 0.76, 0.8], ks: 1.2, shininess: 120 },
  shadow: { color: [0, 0, 0], ks: 0, shininess: 1, alpha: 0.45 },
};

const WALL_HEIGHT = 0.9, WALL_THICK = 0.24;
const FLIPPER_HEIGHT = 0.6;

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
gl.bindAttribLocation(program, 1, "aNormal");
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
gl.useProgram(program);

const U = Object.fromEntries(["uModelView", "uProjection", "uLightPos", "uLightColor",
  "uColor", "uEmissive", "uKs", "uShininess", "uAlpha"].map(n => [n, gl.getUniformLocation(program, n)]));

function createMesh({ positions, normals, indices }) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const [loc, data] of [[0, positions], [1, normals]]) {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(loc);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  return { vao, count: indices.length };
}

// HW7 primitives: cube spans [-1,1]^3, cylinder runs along y over [-1,1], sphere is unit
const cube = createMesh(createCube());
const cylinder = createMesh(createCylinder(32));
const sphere = createMesh(createSphere(24, 24));

// ---------- camera ----------

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };

function lookAt(eye, target, up) {
  const f = norm(sub3(target, eye)), s = norm(cross(f, up)), u = cross(s, f);
  const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0,
    -d(s, eye), -d(u, eye), d(f, eye), 1]);
}

// Player's-eye view from below the table, looking up its length
const CAMERA = { eye: [10, -19, 29], target: [10, 14, 0], fov: 45 * Math.PI / 180 };

// ---------- drawing ----------

let view;
function draw(mesh, model, mat, emissive = [0, 0, 0]) {
  gl.uniformMatrix4fv(U.uModelView, false, multiply(view, model));
  gl.uniform3fv(U.uColor, mat.color);
  gl.uniform3fv(U.uEmissive, emissive);
  gl.uniform1f(U.uKs, mat.ks);
  gl.uniform1f(U.uShininess, mat.shininess);
  gl.uniform1f(U.uAlpha, mat.alpha ?? 1);
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
}

const chainMul = (...ms) => ms.reduce(multiply);
const upright = rotateX(Math.PI / 2);      // cylinder axis y -> z

// Box from (x0,y0,z0) to (x1,y1,z1)
const box = (x0, y0, z0, x1, y1, z1) =>
  chainMul(translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), scale((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2));

// Vertical cylinder standing on z0
const post = (x, y, r, z0, h) => chainMul(translate(x, y, z0 + h / 2), upright, scale(r, h / 2, r));

function drawCabinet() {
  const { width: w, height: h } = table;
  draw(cube, box(0, -2.5, -0.6, w, h, 0), M.playfield);
  draw(cube, box(-1.2, -2.5, -1.4, w + 1.2, h + 1.2, -0.6), M.cabinet);
  draw(cube, box(-1.2, -2.5, -0.6, 0, h + 1.2, 1.2), M.cabinet);        // left side
  draw(cube, box(w, -2.5, -0.6, w + 1.2, h + 1.2, 1.2), M.cabinet);     // right side
  draw(cube, box(0, h, -0.6, w, h + 1.2, 1.2), M.cabinet);              // head
  draw(cube, box(0, -2.5, 0, LANE_X, 1.8, 0.35), M.apron);              // apron over the drain
}

function drawWall({ a, b, hidden }) {
  if (hidden) return;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  draw(cube, chainMul(translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, WALL_HEIGHT / 2),
    rotateZ(angle), scale(len / 2, WALL_THICK / 2, WALL_HEIGHT / 2)), M.rail);
  // round posts fill the joints between segments of a curve
  draw(cylinder, post(a[0], a[1], WALL_THICK / 2, 0, WALL_HEIGHT), M.rail);
  draw(cylinder, post(b[0], b[1], WALL_THICK / 2, 0, WALL_HEIGHT), M.rail);
}

function drawBumper(bp) {
  const glow = bp.lit > 0 ? [0.9, 0.7, 0.2] : [0, 0, 0];
  draw(cylinder, post(bp.c[0], bp.c[1], bp.r * 0.85, 0, 0.9), M.bumper, glow.map(x => x * 0.4));
  draw(cylinder, post(bp.c[0], bp.c[1], bp.r, 0.15, 0.25), M.rubber);       // kicker ring
  draw(cylinder, post(bp.c[0], bp.c[1], bp.r * 0.6, 0.9, 0.12), M.bumperCap, glow);
}

// Hierarchical: the flipper frame is pivot -> rotation; parts are placed in it
function drawFlipper(f) {
  const worldAngle = f.side > 0 ? f.angle : Math.PI - f.angle;   // right flipper is mirrored
  const frame = chainMul(translate(f.pivot[0], f.pivot[1], 0), rotateZ(worldAngle));
  const r = f.radius, L = f.length, h = FLIPPER_HEIGHT;
  draw(cube, chainMul(frame, translate(L / 2, 0, h / 2), scale(L / 2, r, h / 2)), M.flipper);
  draw(cylinder, multiply(frame, post(0, 0, r, 0, h)), M.flipper);
  draw(cylinder, multiply(frame, post(L, 0, r, 0, h)), M.flipper);
  draw(cylinder, multiply(frame, post(0, 0, r * 0.4, h, 0.1)), M.rail);     // pivot cap
}

function drawPlunger() {
  const x = (LANE_X + table.width) / 2;
  const pull = game.charge * 1.2;
  // cylinder already runs along y, which is the plunger's axis
  draw(cylinder, chainMul(translate(x, -0.7 - pull, 0.5), scale(0.18, 0.9, 0.18)), M.rail);
  draw(cylinder, chainMul(translate(x, 0.15 - pull, 0.5), scale(0.35, 0.12, 0.35)), M.rubber);
}

// Ball shadow projected from the key light onto the table plane
function drawBallShadow(p) {
  const L = LIGHTS[0].pos, z = BALL_RADIUS;
  const k = z / (L[2] - z);
  const sx = p[0] + (p[0] - L[0]) * k, sy = p[1] + (p[1] - L[1]) * k;
  gl.enable(gl.BLEND);
  gl.depthMask(false);
  draw(cylinder, post(sx, sy, BALL_RADIUS * 0.9, 0.01, 0.01), M.shadow);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  gl.viewport(0, 0, w, h);
}

gl.enable(gl.DEPTH_TEST);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

function render() {
  resize();
  const aspect = canvas.width / canvas.height;
  // Widen the view on narrow (portrait) screens so the table still fits
  const fov = aspect < 0.85 ? 2 * Math.atan(Math.tan(CAMERA.fov / 2) * 0.85 / aspect) : CAMERA.fov;
  gl.uniformMatrix4fv(U.uProjection, false, perspective(fov, aspect, 1, 200));
  view = lookAt(CAMERA.eye, CAMERA.target, [0, 0, 1]);
  gl.uniform3fv(U.uLightPos, LIGHTS.flatMap(l => transformPoint(view, l.pos)));
  gl.uniform3fv(U.uLightColor, LIGHTS.flatMap(l => l.color));

  gl.clearColor(0.04, 0.04, 0.07, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  drawCabinet();
  table.walls.forEach(drawWall);
  table.bumpers.forEach(drawBumper);
  table.flippers.forEach(drawFlipper);
  drawPlunger();

  const p = game.ball.p;
  drawBallShadow(p);
  draw(sphere, chainMul(translate(p[0], p[1], BALL_RADIUS), scale(BALL_RADIUS, BALL_RADIUS, BALL_RADIUS)), M.ball);
}
