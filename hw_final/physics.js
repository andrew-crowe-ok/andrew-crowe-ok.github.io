// Pinball physics and game rules. No rendering here: the renderer only reads
// `table` and `game`, so it can be swapped (3D, ray traced, warped) freely.
//
// Table space: x right, y up the table, origin at the bottom-left corner.
// Everything that collides is an analytic shape (circle or capsule), which
// keeps collision exact and maps 1:1 onto ray-traceable primitives later.

const BALL_RADIUS = 0.5;
const GRAVITY = 30;          // table-plane component of gravity, units/s^2
const SUBSTEPS = 8;          // per frame, so a fast ball can't tunnel a wall
const MAX_SPEED = 60;
const LANE_X = 18.4;         // inner wall of the plunger lane

// ---------- table layout ----------

function arc(cx, cy, r, from, to, n = 10) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = from + (to - from) * i / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// Polyline -> wall segments (skips zero-length joins where pieces meet)
function chain(points) {
  const segs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) segs.push({ a, b });
  }
  return segs;
}

const table = {
  width: 20,
  height: 36,
  walls: [
    // outer shell: left wall, rounded top, right wall down to the plunger
    ...chain([
      [0, 8], [0, 32],
      ...arc(4, 32, 4, Math.PI, Math.PI / 2),
      ...arc(16, 32, 4, Math.PI / 2, 0),
      [20, 0],
    ]),
    { a: [LANE_X, 0], b: [LANE_X, 28] },     // plunger lane divider
    { a: [LANE_X, 0.5], b: [20, 0.5] },      // plunger rest
    { a: [0, 8], b: [5.4, 4.6] },            // left inlane guide
    { a: [LANE_X, 8], b: [13.0, 4.6] },      // right inlane guide
    // apron: keeps a draining ball in the center channel under the flippers
    { a: [5.4, 4.6], b: [5.4, -1] },
    { a: [13.0, 4.6], b: [13.0, -1] },
  ],
  bumpers: [
    { c: [6, 24], r: 1.2, kick: 18, points: 100, lit: 0 },
    { c: [12.4, 24], r: 1.2, kick: 18, points: 100, lit: 0 },
    { c: [9.2, 19], r: 1.2, kick: 18, points: 100, lit: 0 },
  ],
  flippers: [
    makeFlipper([5.4, 4.6], +1),
    makeFlipper([13.0, 4.6], -1),
  ],
};

// side = +1 for the left flipper (points right), -1 for the right (mirrored)
function makeFlipper(pivot, side) {
  return {
    pivot, side,
    length: 3.2,
    radius: 0.3,
    restAngle: -0.5,       // rad, below horizontal
    upAngle: 0.45,
    speed: 18,             // rad/s while swinging
    angle: -0.5,
    omega: 0,              // signed angular velocity in world terms
    pressed: false,
  };
}

function flipperTip(f) {
  return [f.pivot[0] + f.side * f.length * Math.cos(f.angle),
          f.pivot[1] + f.length * Math.sin(f.angle)];
}

// ---------- game state ----------

const game = {
  ball: { p: [19.2, 1], v: [0, 0] },
  score: 0,
  balls: 3,
  state: "ready",          // ready (in plunger lane) | play | over
  charge: 0,               // plunger pull, 0..1
  charging: false,
};

function resetBall() {
  game.ball.p = [(LANE_X + 20) / 2, 0.5 + BALL_RADIUS];
  game.ball.v = [0, 0];
  game.state = "ready";
}

function newGame() {
  game.score = 0;
  game.balls = 3;
  resetBall();
}

// Plunger: hold to charge, release to fire if the ball is resting on it
function setPlunger(down) {
  if (game.state === "over") { if (down) newGame(); return; }
  if (down) { game.charging = true; return; }
  const b = game.ball;
  if (game.charging && b.p[0] > LANE_X && b.p[1] < 2) {
    b.v = [0, 36 + 20 * game.charge];   // ~half charge clears the top arc
    game.state = "play";
  }
  game.charging = false;
  game.charge = 0;
}

function setFlipper(i, down) { table.flippers[i].pressed = down; }

// ---------- collision ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

function closestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab)));
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

// Push the ball out of a shape and bounce it relative to the shape's surface
// velocity `vs` (zero for static walls). Returns true on contact.
function resolve(ball, q, reach, restitution, vs = [0, 0]) {
  const d = sub(ball.p, q);
  const dist = Math.hypot(d[0], d[1]);
  if (dist >= reach || dist === 0) return false;
  const n = [d[0] / dist, d[1] / dist];
  ball.p[0] += n[0] * (reach - dist);
  ball.p[1] += n[1] * (reach - dist);
  const rel = sub(ball.v, vs);
  const vn = dot(rel, n);
  if (vn < 0) {
    ball.v[0] -= (1 + restitution) * vn * n[0];
    ball.v[1] -= (1 + restitution) * vn * n[1];
  }
  return true;
}

function collideWalls(ball) {
  for (const w of table.walls)
    resolve(ball, closestOnSegment(ball.p, w.a, w.b), BALL_RADIUS, 0.5);
}

function collideBumpers(ball) {
  for (const bp of table.bumpers) {
    if (!resolve(ball, bp.c, BALL_RADIUS + bp.r, 0.9)) continue;
    // Active bumper: guarantee a strong outward kick
    const n = sub(ball.p, bp.c);
    const len = Math.hypot(n[0], n[1]);
    const vn = dot(ball.v, n) / len;
    if (vn < bp.kick) {
      ball.v[0] += (bp.kick - vn) * n[0] / len;
      ball.v[1] += (bp.kick - vn) * n[1] / len;
    }
    game.score += bp.points;
    bp.lit = 0.15;
  }
}

function collideFlippers(ball) {
  for (const f of table.flippers) {
    const q = closestOnSegment(ball.p, f.pivot, flipperTip(f));
    // Surface velocity of a rotating body: omega x r
    const r = sub(q, f.pivot);
    const vs = [-f.omega * r[1], f.omega * r[0]];
    resolve(ball, q, BALL_RADIUS + f.radius, 0.3, vs);
  }
}

// ---------- step ----------

function moveFlippers(dt) {
  for (const f of table.flippers) {
    const target = f.pressed ? f.upAngle : f.restAngle;
    const prev = f.angle;
    const step = f.speed * dt;
    f.angle = Math.abs(target - f.angle) <= step ? target : f.angle + Math.sign(target - f.angle) * step;
    // Mirroring flips the rotation direction for the right flipper
    f.omega = f.side * (f.angle - prev) / dt;
  }
}

function stepPhysics(dt) {
  const h = dt / SUBSTEPS;
  const ball = game.ball;

  if (game.charging) game.charge = Math.min(1, game.charge + dt);
  for (const bp of table.bumpers) bp.lit = Math.max(0, bp.lit - dt);

  for (let i = 0; i < SUBSTEPS; i++) {
    moveFlippers(h);
    if (game.state === "over") continue;

    ball.v[1] -= GRAVITY * h;
    const speed = Math.hypot(ball.v[0], ball.v[1]);
    if (speed > MAX_SPEED) { ball.v[0] *= MAX_SPEED / speed; ball.v[1] *= MAX_SPEED / speed; }
    ball.p[0] += ball.v[0] * h;
    ball.p[1] += ball.v[1] * h;

    collideWalls(ball);
    collideBumpers(ball);
    collideFlippers(ball);
  }

  // A weak launch (or a ball that drops back into the lane) can be relaunched
  if (game.state === "play" && ball.p[0] > LANE_X && ball.p[1] < 2) game.state = "ready";

  // Drain
  if (ball.p[1] < -BALL_RADIUS * 2) {
    game.balls--;
    if (game.balls > 0) resetBall();
    else game.state = "over";
  }
}
