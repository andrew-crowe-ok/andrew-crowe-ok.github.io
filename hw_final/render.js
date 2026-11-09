// Rasterized 3D view of the table, lit with Blinn-Phong from two point lights.
// Reads `table` and `game` from physics.js and draws them each frame.
//
// World space puts physics' 2D table space on the plane z = 0: x right, y up
// the table, z up out of the playfield. Everything is built from the unit
// cube, cylinder and sphere in models.js.

// ---------- shaders ----------

const VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uModelView;
uniform mat4 uProjection;
out vec3 vPosition;   // eye space
out vec3 vNormal;     // eye space
void main() {
  vec4 p = uModelView * vec4(aPosition, 1.0);
  vPosition = p.xyz;
  // Normals take the inverse transpose because parts are scaled non-uniformly
  vNormal = transpose(inverse(mat3(uModelView))) * aNormal;
  gl_Position = uProjection * p;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 vPosition;
in vec3 vNormal;
uniform vec3 uLightPos[2];      // eye space
uniform vec3 uLightColor[2];
uniform vec3 uColor;            // diffuse color; ambient is a fraction of it
uniform vec3 uEmissive;         // added on top, for glowing parts
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

// ---------- scene settings ----------

const LIGHTS = [
  { pos: [10, 10, 30], color: [1.0, 0.95, 0.85] },    // warm key light above mid-table
  { pos: [10, -12, 10], color: [0.25, 0.3, 0.4] },    // dim cool fill from the player's side
];

const MATERIALS = {
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

// Wooden cabinet around the playfield (world units)
const CABINET = {
  rim: 1.2,        // thickness of the side and head walls
  front: -2.5,     // y of the front edge, below the drain
  wallTop: 1.2,    // z of the top of the walls
  floor: -0.6,     // z of the underside of the playfield
  base: -1.4,      // z of the bottom of the cabinet
};
const WALL_HEIGHT = 0.9, WALL_THICK = 0.24;    // chrome rails along the walls in physics.js
const FLIPPER_HEIGHT = 0.6;

// Player's-eye view from below the table, looking up its length. Tall (phone
// portrait) screens blend toward the steeper, more overhead `tall` view so
// the long table fills the screen instead of shrinking to fit its width.
const CAMERA = {
  wide: { eye: [10, -19, 29], target: [10, 14, 0] },
  tall: { eye: [10, -6, 42], target: [10, 15.5, 0] },
};

// ---------- WebGL setup ----------

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

const cube = createMesh(createCube());
const cylinder = createMesh(createCylinder(32));
const sphere = createMesh(createSphere(24, 24));

gl.enable(gl.DEPTH_TEST);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// ---------- camera ----------

const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Corners of the cabinet's bounding box, which the projection keeps on screen
const FIT_CORNERS = [];
for (const x of [-CABINET.rim, table.width + CABINET.rim])
  for (const y of [CABINET.front, table.height + CABINET.rim])
    for (const z of [CABINET.base, CABINET.wallTop]) FIT_CORNERS.push([x, y, z]);

// Projection that shows the cabinet as large as possible, centered in the part
// of the screen (W x H CSS px) not covered by the HTML overlays in `insets`.
// It works in view-space slopes (x/-z, y/-z); with the near plane at 1 those
// are exactly the frustum edges.
function fitProjection(view, W, H, insets) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const c of FIT_CORNERS) {
    const [x, y, z] = transformPoint(view, c);
    xmin = Math.min(xmin, x / -z); xmax = Math.max(xmax, x / -z);
    ymin = Math.min(ymin, y / -z); ymax = Math.max(ymax, y / -z);
  }
  const margin = 1.04, usable = H - insets.top - insets.bottom;
  const s = Math.max((xmax - xmin) * margin / W, (ymax - ymin) * margin / usable);   // slope per px
  const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
  const bottom = cy - s * (insets.bottom + usable / 2);
  return frustum(cx - s * W / 2, cx + s * W / 2, bottom, bottom + s * H, 1, 200);
}

// ---------- drawing ----------

let view;   // this frame's view matrix

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

// Unit cube stretched to the box from (x0, y0, z0) to (x1, y1, z1)
const box = (x0, y0, z0, x1, y1, z1) =>
  compose(translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), scale((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2));

// Unit cylinder stood upright (axis y -> z) at (x, y): radius r, from z0 up by h
const upright = rotateX(Math.PI / 2);
const post = (x, y, r, z0, h) => compose(translate(x, y, z0 + h / 2), upright, scale(r, h / 2, r));

function drawCabinet() {
  const { width: w, height: h } = table;
  const { rim, front, wallTop, floor, base } = CABINET;
  draw(cube, box(0, front, floor, w, h, 0), MATERIALS.playfield);
  draw(cube, box(-rim, front, base, w + rim, h + rim, floor), MATERIALS.cabinet);        // bottom
  draw(cube, box(-rim, front, floor, 0, h + rim, wallTop), MATERIALS.cabinet);           // left side
  draw(cube, box(w, front, floor, w + rim, h + rim, wallTop), MATERIALS.cabinet);        // right side
  draw(cube, box(0, h, floor, w, h + rim, wallTop), MATERIALS.cabinet);                  // head
  draw(cube, box(0, front, 0, LANE_X, 1.8, 0.35), MATERIALS.apron);                      // covers the drain
}

// A wall segment as a rail, with round posts at both ends to fill the joints
// between the short segments that make up a curve
function drawWall({ a, b, hidden }) {
  if (hidden) return;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  draw(cube, compose(translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, WALL_HEIGHT / 2),
    rotateZ(angle), scale(len / 2, WALL_THICK / 2, WALL_HEIGHT / 2)), MATERIALS.rail);
  draw(cylinder, post(a[0], a[1], WALL_THICK / 2, 0, WALL_HEIGHT), MATERIALS.rail);
  draw(cylinder, post(b[0], b[1], WALL_THICK / 2, 0, WALL_HEIGHT), MATERIALS.rail);
}

function drawBumper(bp) {
  const glow = bp.lit > 0 ? [0.9, 0.7, 0.2] : [0, 0, 0];
  const [x, y] = bp.c;
  draw(cylinder, post(x, y, bp.r * 0.85, 0, 0.9), MATERIALS.bumper, glow.map(g => g * 0.4));
  draw(cylinder, post(x, y, bp.r, 0.15, 0.25), MATERIALS.rubber);          // rubber ring
  draw(cylinder, post(x, y, bp.r * 0.6, 0.9, 0.12), MATERIALS.bumperCap, glow);
}

// Hierarchical model: the flipper's frame is its pivot then its rotation, and
// each part is placed in that frame along the flipper's local +x
function drawFlipper(f) {
  const worldAngle = f.side > 0 ? f.angle : Math.PI - f.angle;   // the right flipper is mirrored
  const frame = compose(translate(f.pivot[0], f.pivot[1], 0), rotateZ(worldAngle));
  const r = f.radius, L = f.length, h = FLIPPER_HEIGHT;
  draw(cube, compose(frame, translate(L / 2, 0, h / 2), scale(L / 2, r, h / 2)), MATERIALS.flipper);
  draw(cylinder, compose(frame, post(0, 0, r, 0, h)), MATERIALS.flipper);    // rounded base
  draw(cylinder, compose(frame, post(L, 0, r, 0, h)), MATERIALS.flipper);    // rounded tip
  draw(cylinder, compose(frame, post(0, 0, r * 0.4, h, 0.1)), MATERIALS.rail);   // pivot cap
}

// The plunger pulls back (down the table) with the charge. The unit cylinder's
// axis is already y, the plunger's direction, so it needs no rotation.
function drawPlunger() {
  const x = (LANE_X + table.width) / 2;
  const pull = game.charge * 1.2;
  draw(cylinder, compose(translate(x, -0.7 - pull, 0.5), scale(0.18, 0.9, 0.18)), MATERIALS.rail);
  draw(cylinder, compose(translate(x, 0.15 - pull, 0.5), scale(0.35, 0.12, 0.35)), MATERIALS.rubber);
}

// Dark disk where the line from the key light through the ball's center meets the table
function drawBallShadow(p) {
  const L = LIGHTS[0].pos, z = BALL_RADIUS;
  const k = z / (L[2] - z);
  const sx = p[0] + (p[0] - L[0]) * k, sy = p[1] + (p[1] - L[1]) * k;
  gl.enable(gl.BLEND);
  gl.depthMask(false);
  draw(cylinder, post(sx, sy, BALL_RADIUS * 0.9, 0.01, 0.01), MATERIALS.shadow);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

function drawBall(p) {
  drawBallShadow(p);
  draw(sphere, compose(translate(p[0], p[1], BALL_RADIUS), scale(BALL_RADIUS, BALL_RADIUS, BALL_RADIUS)), MATERIALS.ball);
}

// ---------- frame ----------

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);   // phones report 3+; not worth the fill cost
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  gl.viewport(0, 0, w, h);
}

// Draw one frame. `insets` = CSS px covered by overlays at the top and bottom.
function render(insets) {
  resize();
  const aspect = canvas.width / canvas.height;
  const tall = Math.min(1, Math.max(0, (1.1 - aspect) / 0.6));   // 0 at aspect >= 1.1, 1 at <= 0.5
  view = lookAt(lerp3(CAMERA.wide.eye, CAMERA.tall.eye, tall),
                lerp3(CAMERA.wide.target, CAMERA.tall.target, tall), [0, 0, 1]);
  gl.uniformMatrix4fv(U.uProjection, false,
    fitProjection(view, canvas.clientWidth, canvas.clientHeight, insets));
  gl.uniform3fv(U.uLightPos, LIGHTS.flatMap(l => transformPoint(view, l.pos)));
  gl.uniform3fv(U.uLightColor, LIGHTS.flatMap(l => l.color));

  gl.clearColor(0.04, 0.04, 0.07, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  drawCabinet();
  table.walls.forEach(drawWall);
  table.bumpers.forEach(drawBumper);
  table.flippers.forEach(drawFlipper);
  drawPlunger();
  drawBall(game.ball.p);
}
