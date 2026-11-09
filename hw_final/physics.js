// Pinball physics and game rules, with no rendering. The renderer only reads
// `table` and `game`, so it can be replaced without touching this file.
//
// Everything happens in 2D table space: x to the right, y up the table, origin
// at the bottom-left corner, 1 unit = the ball's diameter. Every collider is a
// circle or a line segment, so collisions are exact closest-point tests.

const BALL_RADIUS = 0.5;
const GRAVITY = 30;          // the part of gravity along the tilted table, units/s^2
const SUBSTEPS = 8;          // physics steps per frame, so a fast ball can't skip through a wall
const MAX_SPEED = 60;        // units/s; with SUBSTEPS this keeps each step's move under a ball radius
const LANE_X = 18.4;         // x of the wall between the playfield and the plunger lane

// ---------- table layout ----------

// Points along a circular arc from angle `from` to `to` (radians)
function arc(cx, cy, r, from, to, n = 10) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = from + (to - from) * i / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// Polyline -> wall segments, skipping zero-length joins where pieces meet
function chain(points) {
  const segs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) segs.push({ a, b });
  }
  return segs;
}

// side = +1 for the left flipper (extends to the right), -1 for the right one (mirrored)
function makeFlipper(pivot, side) {
  return {
    pivot, side,
    length: 3.2,
    radius: 0.3,           // half the flipper's thickness
    restAngle: -0.5,       // radians above horizontal (negative = below), mirrored for the right flipper
    upAngle: 0.45,
    speed: 18,             // radians/s while swinging
    angle: -0.5,
    omega: 0,              // angular velocity, counterclockwise-positive
    pressed: false,
  };
}

const table = {
  width: 20,
  height: 36,
  // Walls are segments { a, b }. `hidden` ones still collide but aren't drawn.
  walls: [
    // outer shell: left wall, rounded top corners, right wall down to the plunger
    ...chain([
      [0, 8], [0, 32],
      ...arc(4, 32, 4, Math.PI, Math.PI / 2),
      ...arc(16, 32, 4, Math.PI / 2, 0),
      [20, 0],
    ]),
    { a: [LANE_X, 0], b: [LANE_X, 28] },     // plunger lane divider
    { a: [LANE_X, 0.5], b: [20, 0.5] },      // plunger tip the ball rests on
    { a: [0, 8], b: [5.4, 4.6] },            // left guide down to the flipper
    { a: [LANE_X, 8], b: [13.0, 4.6] },      // right guide down to the flipper
    // keep a draining ball in the center channel; the renderer's apron covers them
    { a: [5.4, 4.6], b: [5.4, -1], hidden: true },
    { a: [13.0, 4.6], b: [13.0, -1], hidden: true },
  ],
  // `kick` is the minimum speed a bumper sends the ball away at; `lit` counts
  // down after a hit so the renderer can flash it
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

function flipperTip(f) {
  return [f.pivot[0] + f.side * f.length * Math.cos(f.angle),
          f.pivot[1] + f.length * Math.sin(f.angle)];
}

// ---------- game state ----------

const game = {
  ball: { p: [0, 0], v: [0, 0] },   // position and velocity; placed by newGame()
  score: 0,
  balls: 3,                // balls left, including the one in play
  state: "ready",          // "ready" (ball on the plunger) | "play" | "over"
  charge: 0,               // how far the plunger is pulled back, 0..1
  charging: false,
};

const ballOnPlunger = () => game.ball.p[0] > LANE_X && game.ball.p[1] < 2;

function resetBall() {
  game.ball.p = [(LANE_X + table.width) / 2, 0.5 + BALL_RADIUS];
  game.ball.v = [0, 0];
  game.state = "ready";
}

function newGame() {
  game.score = 0;
  game.balls = 3;
  resetBall();
}

// Input: hold to pull the plunger back, release to fire. After game over,
// pressing it starts a new game.
function setPlunger(down) {
  if (game.state === "over") { if (down) newGame(); return; }
  if (down) { game.charging = true; return; }
  if (game.charging && ballOnPlunger()) {
    game.ball.v = [0, 36 + 20 * game.charge];   // about half a charge clears the top arc
    game.state = "play";
  }
  game.charging = false;
  game.charge = 0;
}

// Input: flipper 0 is left, 1 is right
function setFlipper(i, down) { table.flippers[i].pressed = down; }

// ---------- collision ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

function closestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab)));
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

// If the ball is within `reach` of point q on a shape, push it back out and
// bounce it. The bounce is relative to the surface's own velocity `vs`, which
// is how a moving flipper adds speed. Returns true on contact.
function resolve(ball, q, reach, restitution, vs = [0, 0]) {
  const d = sub(ball.p, q);
  const dist = Math.hypot(d[0], d[1]);
  if (dist >= reach || dist === 0) return false;
  const n = [d[0] / dist, d[1] / dist];          // contact normal, pointing at the ball
  ball.p[0] += n[0] * (reach - dist);
  ball.p[1] += n[1] * (reach - dist);
  const vn = dot(sub(ball.v, vs), n);            // approach speed along the normal
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
    // Bumpers fire the ball away: raise its outward speed to at least `kick`
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
    // Velocity of the flipper's surface at q: omega x r, for r from the pivot
    const r = sub(q, f.pivot);
    const vs = [-f.omega * r[1], f.omega * r[0]];
    resolve(ball, q, BALL_RADIUS + f.radius, 0.3, vs);
  }
}

// ---------- simulation step ----------

function moveFlippers(dt) {
  for (const f of table.flippers) {
    const target = f.pressed ? f.upAngle : f.restAngle;
    const prev = f.angle;
    const step = f.speed * dt;
    f.angle = Math.abs(target - f.angle) <= step ? target : f.angle + Math.sign(target - f.angle) * step;
    // `angle` is mirrored for the right flipper, so its world rotation is reversed
    f.omega = f.side * (f.angle - prev) / dt;
  }
}

// Advance the whole game by dt seconds
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

  // A weak launch falls back onto the plunger and can be fired again
  if (game.state === "play" && ballOnPlunger()) game.state = "ready";

  // Drain: the ball fell out the bottom
  if (ball.p[1] < -BALL_RADIUS * 2) {
    game.balls--;
    if (game.balls > 0) resetBall();
    else game.state = "over";
  }
}
