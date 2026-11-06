// Scene above the ship, in the same functional style as ship.js:
//
//   drawSystem
//   ├── drawStarfield     (point-sprite stars all around)
//   ├── drawPlanet        (spins on its own axis)
//   └── drawOrbit         (tilted orbital plane, carries the ship around)
//       └── drawShip      (ship.js)
//
// The planet and the orbit are siblings, so the planet's spin never reaches the ship.
//
// drawOrbit asks shipState() where the ship is: either on the circle, or on a
// smooth departure onto the straight line it was flying when "Break Orbit" was
// pressed (and, on a second press, a smooth return to the circle).

// The stars sit on this sphere: outside the orbit, well inside the far plane
const SKY_RADIUS = 45;

const PLANET = { radius: 2.4, spin: 0.08 };                     // spin in rad/s

// Matte rock: almost no ambient (dark night side, sharp terminator), full
// diffuse, a faint broad specular, gentler bumps than the ship, and a blue
// atmosphere glow on the sunlit limb
const PLANET_MATERIAL = {
  ka: 0.03, kd: 1.0, ks: 0.05, shininess: 8, bumpScale: 1.2, atmosphere: [0.35, 0.6, 1.0]
};
const ORBIT = { radius: 4.4, speed: 0.25, tilt: 0.25, shipScale: 0.32 };

// Level 0: planetary system at the origin; t is seconds since the page loaded
function drawSystem(parent, t) {
  drawStarfield(parent, t);
  drawPlanet(parent, t);
  drawOrbit(multiply(parent, rotateX(ORBIT.tilt)), t);
}

// Sky: the point sprites from stars.js, one draw call. Depth writes are off, so
// the stars never occlude anything -- everything else simply paints over them.
function drawStarfield(parent, t) {
  gl.depthMask(false);
  starPoints.draw(multiply(projection, parent), t);
  gl.depthMask(true);
}

// Planet: a fine sphere wearing the antelope photo, bump-mapped from its luminance
function drawPlanet(parent, t) {
  const r = PLANET.radius;
  drawPrimitive(planetMesh, getTexture("textures/antelope.jpg"), BUMP_MAPPING,
    multiply(parent, multiply(rotateY(PLANET.spin * t), scale(r, r, r))), PLANET_MATERIAL);
}

// ---------------------------------------------------------------------------
// Flight path
//
// The ship rides a circle of radius R in this frame. rotateY(a) carries the
// point (R, 0, 0) around the y axis, and at angle a the direction of travel is
// (sin a, 0, cos a) -- which is also what rotateY(a) does to the ship's own +z,
// so a doubles as the ship's heading and the ship always flies nose-first.
//
// "Break Orbit" peels it off onto the straight line it was flying at that
// instant, and a second press flies it home. Four legs:
//
//   breaking   blend the circle into the tangent line  (2.5 s)
//   free       the straight line, forever
//   returning  a constant-speed banked turn back toward the circle
//   merging    blend that line into the circle again   (2.5 s)
//
// The two blends interpolate between the two paths that meet at the press:
//
//   p(tau) = from + w(u) * (to - from),   u = tau / duration
//
// w is the quintic smootherstep, whose first and second derivatives both vanish
// at u = 0 and u = 1. So p matches the circle's position, velocity AND
// acceleration where it leaves, and the line's where it arrives: no kink and no
// jolt at either end. Measured over the whole departure the ship's speed stays
// within 1%-3% of its orbital speed, and it ends on exactly the tangent the
// press defined -- not a spiral that would keep turning past the heading the
// ship had when the button went down.
//
// Coming home can't be another blend of two paths: the ship is flying away, so
// any return has to turn around, and interpolating two diverging paths turns
// around by stalling -- the ship's speed collapses and its heading snaps.
// "returning" instead steers like an aircraft: speed is held exactly constant
// and only the heading is integrated, under a guidance law that aims along the
// circle's tangent and bends toward it in proportion to the radial error. That
// is a real banked turn; it converges from any distance, never crosses the
// planet, and once the ship is close and pointing the right way it hands over
// to the same smootherstep blend, run the other way, for an exact merge.
// ---------------------------------------------------------------------------

const BREAK = {
  blend: 2.5,                    // s, length of the departure and arrival blends
  turnRate: 2.4 * ORBIT.speed,   // rad/s ceiling on the return's bank
  turnEase: 0.8,                 // s to ease the bank in (and out, if cancelled)
  band: 1.0,                     // radial error that commands a full 90 deg of bend
  gain: 3.0,                     // heading gain
  tolRadius: 0.35,               // close enough, and pointed well enough,
  tolHeading: 0.22               //   to hand over to the merging blend
};
const ORBIT_SPEED = ORBIT.radius * ORBIT.speed;   // units/s along the circle

// Nothing in the scene depends on where the ship is in its orbit, so the
// circle's phase is ours to choose: the merge re-epochs it to meet the ship
// rather than making the ship chase a phase it would have to sprint to reach.
let orbitEpoch = 0;
const orbitAngle = t => -ORBIT.speed * (t - orbitEpoch);
const orbitPoint = a => [ORBIT.radius * Math.cos(a), 0, -ORBIT.radius * Math.sin(a)];
const orbitForward = a => [Math.sin(a), 0, Math.cos(a)];

const vadd = (a, b) => a.map((v, i) => v + b[i]);
const vmul = (a, k) => a.map(v => v * k);

// Quintic smootherstep and its slope: w(0)=0, w(1)=1, w'=w''=0 at both ends
const smootherstep = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (6 * u - 15) + 10);
const smootherslope = u => u <= 0 || u >= 1 ? 0 : 30 * u * u * (u - 1) * (u - 1);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapPi = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// The heading that points the nose along v, since rotateY(a) sends +z to
// (sin a, 0, cos a). Falls back when v is too short to give a direction.
const headingOf = ([vx, , vz], fallback) =>
  Math.hypot(vx, vz) < 1e-6 ? fallback : Math.atan2(vx, vz);

// The ship's phase on the circle: the angle whose orbitPoint lies along p
const phaseOf = ([x, , z]) => Math.atan2(-z, x);

let flight = { mode: "orbit" };
let togglePending = false;
let lastT = null;

function requestOrbitToggle() { togglePending = true; }   // the button
// What the next press would do: bring the ship home, or send it out again.
// During the return a press cancels it, so the button reads "Break Orbit" again.
function orbitBroken() { return flight.mode === "breaking" || flight.mode === "free"; }
// The two blends are short and must not be restarted from a point that lies on
// neither path, so the button is held during them; the long return is cancellable.
function orbitInTransition() { return flight.mode === "breaking" || flight.mode === "merging"; }

// Where a straight leg has reached, and how fast
const straightLeg = (f, tau) => ({
  pos: vadd(f.p0, vmul(f.f0, ORBIT_SPEED * tau)),
  vel: vmul(f.f0, ORBIT_SPEED)
});

// A press is consumed on the next frame, when the clock is known
function startTransition(t) {
  if (flight.mode === "orbit") {
    const a0 = orbitAngle(t);
    flight = { mode: "breaking", t0: t, a0, p0: orbitPoint(a0), f0: orbitForward(a0) };
  } else if (flight.mode === "free") {
    const { pos } = straightLeg(flight, t - flight.t0);
    flight = { mode: "returning", pos, heading: flight.a0, tau: 0, cancel: null };
  } else if (flight.mode === "returning" && flight.cancel === null) {
    flight.cancel = flight.tau;   // ease the bank out, then fly straight again
  }
}

// "returning": hold the speed at exactly ORBIT_SPEED and steer only the heading.
// The commanded heading is the circle's tangent at the ship's own phase, bent up
// to 90 degrees inward or outward to drive the radial error to zero -- fly
// straight at the circle from far out, ease onto its tangent as you arrive.
function steerHome(t, dt) {
  const f = flight;
  const r = Math.hypot(f.pos[0], f.pos[2]);
  const phase = phaseOf(f.pos);
  const bend = -(Math.PI / 2) * clamp((r - ORBIT.radius) / BREAK.band, -1, 1);
  // Ease the bank in from zero so the curvature -- the ship's acceleration --
  // never steps, and ease it back out if the press was a cancel.
  const ramp = smootherstep(f.tau / BREAK.turnEase) *
    (f.cancel === null ? 1 : 1 - smootherstep((f.tau - f.cancel) / BREAK.turnEase));
  const turn = clamp(BREAK.gain * wrapPi(phase + bend - f.heading),
    -BREAK.turnRate, BREAK.turnRate) * ramp;

  f.heading += turn * dt;
  f.pos = vadd(f.pos, vmul(orbitForward(f.heading), ORBIT_SPEED * dt));
  f.tau += dt;

  const state = { pos: f.pos, heading: f.heading };
  if (f.cancel !== null && f.tau - f.cancel >= BREAK.turnEase) {
    // Bank is out: lay a fresh straight line along wherever the nose ended up
    flight = { mode: "free", t0: t, a0: f.heading, p0: f.pos, f0: orbitForward(f.heading) };
  } else if (f.cancel === null && f.tau > BREAK.turnEase &&
    Math.abs(r - ORBIT.radius) < BREAK.tolRadius &&
    Math.abs(wrapPi(f.heading - phase)) < BREAK.tolHeading) {
    // Close enough and pointed the right way: re-epoch the circle to meet the
    // ship here, so the merging blend only has a hair's gap to close
    orbitEpoch = t + phase / ORBIT.speed;
    flight = { mode: "merging", t0: t, a0: phase, p0: f.pos, f0: orbitForward(f.heading) };
  }
  return state;
}

// Where the ship is and which way it points, in the orbital-plane frame
function shipState(t) {
  const dt = lastT === null ? 0 : clamp(t - lastT, 0, 0.1);   // survives a hidden tab
  lastT = t;

  if (togglePending) {
    togglePending = false;
    startTransition(t);
  }

  if (flight.mode === "orbit") {
    const a = orbitAngle(t);
    return { pos: orbitPoint(a), heading: a };
  }
  if (flight.mode === "returning") return steerHome(t, dt);

  const tau = t - flight.t0;
  const line = straightLeg(flight, tau);
  if (flight.mode === "free") return { pos: line.pos, heading: flight.a0 };

  // The circle this blend is leaving -- its phase frozen at the press and
  // carried on from there -- or the one it is rejoining, now re-epoched to the
  // ship, so in both cases the two paths coincide at the end that matters.
  const a = flight.mode === "breaking" ? flight.a0 - ORBIT.speed * tau : orbitAngle(t);
  const orb = { pos: orbitPoint(a), vel: vmul(orbitForward(a), ORBIT_SPEED) };

  const [from, to] = flight.mode === "breaking" ? [orb, line] : [line, orb];
  const u = tau / BREAK.blend;
  const w = smootherstep(u), dw = smootherslope(u) / BREAK.blend;
  const gap = sub(to.pos, from.pos);

  const pos = vadd(from.pos, vmul(gap, w));
  // d/dt of the blend: the two paths' own velocities, plus the weight's drift.
  // Both extra terms die at u = 1, which is what makes the arrival smooth.
  const vel = vadd(vadd(from.vel, vmul(sub(to.vel, from.vel), w)), vmul(gap, dw));

  // At u = 1 the blend already equals `to` exactly, so the handover is a no-op
  if (u >= 1) flight = flight.mode === "breaking"
    ? { mode: "free", t0: flight.t0, a0: flight.a0, p0: flight.p0, f0: flight.f0 }
    : { mode: "orbit" };

  return { pos, heading: headingOf(vel, a) };
}

// Level 1: place the ship on its path. translate(p) * rotateY(a) is the same
// frame as the old rotateY(a) * translate(R, 0, 0) when p is a point on the
// circle, and it keeps working for a ship that has left it.
function drawOrbit(parent, t) {
  const { pos, heading } = shipState(t);
  const frame = multiply(parent, multiply(translate(...pos), rotateY(heading)));
  const s = ORBIT.shipScale;  // uniform, so the ship's normals stay correct
  drawShip(multiply(frame, scale(s, s, s)));
}
