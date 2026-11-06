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
// shipState() says where the ship is: either on the circle, or on a
// smooth departure onto the straight line it was flying when "Engage" was
// pressed.

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

// Level 0: planetary system at the origin; t is seconds since the page loaded.
// `ship` is this frame's shipState(): the camera needs it before anything is
// drawn, so main.js advances the flight path and passes the result down.
function drawSystem(parent, t, ship) {
  // The sky drifts with the ship at warp (see ENGAGE.skyFollow). The
  // drift is in the orbital plane, so it is applied inside that tilt and the
  // tilt undone again, leaving the stars' own directions as they were.
  const tilt = rotateX(ORBIT.tilt);
  const plane = multiply(parent, tilt);
  // The stars streak by the ship's warp speed through them, turned into eye
  // space; they move past the eye the opposite way to the ship. The streaks
  // draw out with the lens as it opens (camera.js).
  const o = transformPoint(plane, [0, 0, 0]);
  const streak = vmul(sub(o, transformPoint(plane, ship.streak)), lensFisheye);
  drawStarfield(multiply(multiply(plane, translate(...ship.sky)), rotateX(-ORBIT.tilt)), t, streak);
  drawPlanet(parent, t);
  drawOrbit(plane, ship);
}

// Sky: the point sprites from stars.js, one draw call. Depth writes are off, so
// the stars never occlude anything -- everything else simply paints over them.
function drawStarfield(parent, t, streak) {
  gl.depthMask(false);
  starPoints.draw(projection, parent, t, streak);
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
// "Engage" peels it off onto the straight line it was flying at that instant:
//
//   breaking   blend the circle into the tangent line  (2.5 s)
//   free       the straight line, until the scene resets
//
// The blend interpolates between the two paths that meet at the press:
//
//   p(tau) = circle + w(u) * (line - circle),   u = tau / duration
//
// w is the quintic smootherstep, whose first and second derivatives both vanish
// at u = 0 and u = 1. So p matches the circle's position, velocity AND
// acceleration where it leaves, and the line's where it arrives: no kink and no
// jolt at either end. Measured over the whole departure the ship's speed stays
// within 1%-3% of its orbital speed, and it ends on exactly the tangent the
// press defined -- not a spiral that would keep turning past the heading the
// ship had when the button went down.
//
// ENGAGE.warpAt seconds after the press -- just after the departure blend
// lands on the line -- the ship jumps straight from orbital speed to
// ENGAGE.warp times it, with no ramp. The camera's dolly zoom into the
// fisheye, the star streaks and the warp flash (camera.js, stars.js, main.js)
// all start at that instant, keyed off `warpTau`, the time since the jump.
//
// At warp the ship would leave the star sphere long before the reset, so the
// sky drifts along with it by ENGAGE.skyFollow of warp's extra distance: the
// stars still stream past, the ship reaches the edge of them just as the
// scene resets, and the planet falls away at the ship's true speed.
//
// ENGAGE.reset seconds after the press, main.js puts the whole scene back the
// way it loaded (resetFlight below, resetCamera in camera.js).
// ---------------------------------------------------------------------------

const ENGAGE = {
  blend: 2.5,       // s, length of the departure blend
  warpAt: 2.65,     // s after the press that the ship jumps to warp
  warp: 10,         // warp speed, in multiples of orbital speed
  skyFollow: 0.56,  // share of warp's extra distance the sky drifts along:
                    //   enough that the reset catches the ship 43 units out,
                    //   just short of the star sphere's 45
  reset: 10         // s from the press until the scene resets
};
const ORBIT_SPEED = ORBIT.radius * ORBIT.speed;   // units/s along the circle

const orbitAngle = t => -ORBIT.speed * t;
const orbitPoint = a => [ORBIT.radius * Math.cos(a), 0, -ORBIT.radius * Math.sin(a)];
const orbitForward = a => [Math.sin(a), 0, Math.cos(a)];

const vadd = (a, b) => a.map((v, i) => v + b[i]);
const vmul = (a, k) => a.map(v => v * k);

// Quintic smootherstep and its slope: w(0)=0, w(1)=1, w'=w''=0 at both ends
const smootherstep = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (6 * u - 15) + 10);
const smootherslope = u => u <= 0 || u >= 1 ? 0 : 30 * u * u * (u - 1) * (u - 1);

// The heading that points the nose along v, since rotateY(a) sends +z to
// (sin a, 0, cos a). Falls back when v is too short to give a direction.
const headingOf = ([vx, , vz], fallback) =>
  Math.hypot(vx, vz) < 1e-6 ? fallback : Math.atan2(vx, vz);

let flight = { mode: "orbit" };
let engagePending = false;

function requestEngage() { engagePending = true; }   // the button
// Anything but riding the circle -- what the chase camera follows (camera.js)
// and what holds the Engage button down
function offOrbit() { return flight.mode !== "orbit"; }
// Due for a reset: ENGAGE.reset seconds have passed since the press
function engageExpired(t) { return offOrbit() && t - flight.t0 >= ENGAGE.reset; }
// Seconds since the press, or null in orbit
function engageElapsed(t) { return offOrbit() ? t - flight.t0 : null; }
function resetFlight() { flight = { mode: "orbit" }; engagePending = false; }

// Where a straight leg has reached, and how fast, tau seconds after the press:
// orbital speed, then warp speed from ENGAGE.warpAt on. `warpTau` is the time
// since that jump (null before it), `sky` how far the
// star sphere has drifted along with it, and `streak` the velocity the stars
// are drawn stretched by: the ship's speed through the drifting sky, at warp
// only.
const NO_DRIFT = [0, 0, 0];
function straightLeg(f, tau) {
  const warp = tau >= ENGAGE.warpAt;
  const warpTau = warp ? tau - ENGAGE.warpAt : null;
  const extraSpeed = warp ? ORBIT_SPEED * (ENGAGE.warp - 1) : 0;
  const extraDist = warp ? extraSpeed * (tau - ENGAGE.warpAt) : 0;   // beyond orbital speed
  const speed = ORBIT_SPEED + extraSpeed;
  return {
    warpTau,
    pos: vadd(f.p0, vmul(f.f0, ORBIT_SPEED * tau + extraDist)),
    vel: vmul(f.f0, speed),
    sky: vmul(f.f0, ENGAGE.skyFollow * extraDist),
    streak: warp ? vmul(f.f0, speed - ENGAGE.skyFollow * extraSpeed) : NO_DRIFT
  };
}

// Where the ship is and which way it points, in the orbital-plane frame.
// t is the scene clock: seconds since the scene last (re)started.
function shipState(t) {
  // A press is consumed on the next frame, when the clock is known
  if (engagePending) {
    engagePending = false;
    if (flight.mode === "orbit") {
      const a0 = orbitAngle(t);
      flight = { mode: "breaking", t0: t, a0, p0: orbitPoint(a0), f0: orbitForward(a0) };
    }
  }

  if (flight.mode === "orbit") {
    const a = orbitAngle(t);
    return { pos: orbitPoint(a), heading: a, warpTau: null, sky: NO_DRIFT, streak: NO_DRIFT };
  }

  const tau = t - flight.t0;
  const line = straightLeg(flight, tau);
  if (flight.mode === "free")
    return { pos: line.pos, heading: flight.a0, warpTau: line.warpTau, sky: line.sky, streak: line.streak };

  // The circle being left, its phase frozen at the press and carried on from
  // there, so the two paths coincide where the blend starts
  const a = flight.a0 - ORBIT.speed * tau;
  const orb = { pos: orbitPoint(a), vel: vmul(orbitForward(a), ORBIT_SPEED) };

  const u = tau / ENGAGE.blend;
  const w = smootherstep(u), dw = smootherslope(u) / ENGAGE.blend;
  const gap = sub(line.pos, orb.pos);

  const pos = vadd(orb.pos, vmul(gap, w));
  // d/dt of the blend: the two paths' own velocities, plus the weight's drift.
  // Both extra terms die at u = 1, which is what makes the arrival smooth.
  const vel = vadd(vadd(orb.vel, vmul(sub(line.vel, orb.vel), w)), vmul(gap, dw));

  // At u = 1 the blend already equals the line exactly, so the handover is a no-op
  if (u >= 1) flight = { ...flight, mode: "free" };

  return { pos, heading: headingOf(vel, a), warpTau: line.warpTau, sky: line.sky, streak: line.streak };
}

// Level 1: place the ship on the path shipState() worked out.
// translate(p) * rotateY(a) is the same frame as the old
// rotateY(a) * translate(R, 0, 0) when p is a point on the circle, and it
// keeps working for a ship that has left it.
function drawOrbit(parent, { pos, heading }) {
  const frame = multiply(parent, multiply(translate(...pos), rotateY(heading)));
  const s = ORBIT.shipScale;  // uniform, so the ship's normals stay correct
  drawShip(multiply(frame, scale(s, s, s)));
}
