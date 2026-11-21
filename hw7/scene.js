// Scene above the ship, in the same functional style as ship.js:
//
//   drawSystem
//   ├── setSky            (the sky's frame; the shader draws the stars)
//   ├── drawPlanet        (spins on its own axis)
//   ├── drawMoon          (a glass moon on its own tilted orbit)
//   └── drawOrbit         (tilted orbital plane, carries the ship around)
//       └── drawShip      (ship.js)
//
// The planet, the moon and the orbit are siblings, so the planet's spin never
// reaches the ship.
//
// shipState() says where the ship is: either on the circle, or on a
// smooth departure onto the straight line it was flying when "Engage" was
// pressed.

const PLANET = { radius: 6.24, spin: 0.08 };                     // spin in rad/s

// Mirror sphere wearing Mars: half the light is mirrored, half lights the dune
// texture beneath (shadeLocal's body = 1 - kr), so the reflectivity slider
// fades from bare Mars at 0% to this half-silvered planet at 100%
const PLANET_MATERIAL = {
  ka: 0.3, kd: 1.0, ks: 0, shininess: 64, bumpScale: 0, atmosphere: [0, 0, 0], kr: 0.5
};
const ORBIT = { radius: 11.6, speed: 0.25, tilt: 0.25, shipScale: 0.24 };

// The glass hex prism: a curved section of a hexagonal torus spanning one third
// of the orbit (major radius ORBIT.radius, cross-section apothem 1.04), drifting
// gently along the ship's own orbit in the opposite direction while spinning
// about the orbital centerline so the ship meets and flies straight through it.
// `phase` places its leading end just ahead of the ship in front of the planet's
// limb on load.
const MOON = { apothem: 1.04, halfAngle: Math.PI / 3, speed: 0.05, phase: -1.30, spin: 0.6 };
// Crystal-clear refractive glass with a subtle blue absorption and Fresnel edge
// gleam so the ship remains clearly visible as it flies through
const MOON_MATERIAL = {
  ka: 0.02, kd: 0.05, ks: 0.95, shininess: 220, bumpScale: 0, atmosphere: [0.18, 0.42, 0.90],
  kt: 0.94, absorb: [0.045, 0.015, 0.005]
};

// Fresh random galactic orientation on every run
const SKY_ROT = multiply(rotateY(Math.random() * 2 * Math.PI),
  multiply(rotateZ((Math.random() - 0.5) * 0.9), rotateX((Math.random() - 0.5) * 0.6)));

// Level 0: planetary system at the origin; t is the scene clock (main.js).
// `ship` is this frame's shipState(): the camera needs it before anything is
// drawn, so main.js advances the flight path and passes the result down.
function drawSystem(parent, t, ship) {
  // The stars are fixed in space around the system (raytrace.js), so the
  // sky's frame is the system's own. They streak by the ship's warp speed
  // through them, turned into eye space; they move past the eye the opposite
  // way to the ship. The streaks draw out with the lens as it opens (camera.js).
  const plane = multiply(parent, rotateX(ORBIT.tilt));
  const o = transformPoint(plane, [0, 0, 0]);
  const streak = vmul(vsub(o, transformPoint(plane, ship.streak)), lensFisheye);
  setSky(multiply(parent, SKY_ROT), streak);
  drawPlanet(parent, t);
  drawMoon(parent, t);
  drawOrbit(plane, ship);
}

// Planet: a Mars-textured mirror sphere reflecting the ship, glass tube and
// sky. NORMAL_MAPPING with no normal map is plain color mapping.
function drawPlanet(parent, t) {
  const r = PLANET.radius;
  drawPrimitive(planetMesh, planetTexture, NORMAL_MAPPING,
    multiply(parent, multiply(rotateY(PLANET.spin * t), scale(r, r, r))), PLANET_MATERIAL);
}

// The curved glass hex prism's frame at scene time t: centered on the orbit in
// the ship's orbital plane, with the arc symmetric about +x at radius ORBIT.radius.
// Poloidal spin and torus dimensions go to the shader in uHexTorus (main.js).
const moonAngle = t => MOON.phase + MOON.speed * t;
const moonSpin = t => MOON.spin * t;
const moonFrame = t => multiply(rotateX(ORBIT.tilt), rotateY(moonAngle(t)));
const inverseMoonFrame = t => multiply(rotateY(-moonAngle(t)), rotateX(-ORBIT.tilt));
const moonCenter = t => transformPoint(moonFrame(t), [ORBIT.radius, 0, 0]);

// The prism's cross-section about its center line, at p in its own frame:
// (u, v) are p's offset from the line, turned with the spin, and the hexagon
// is max(|v|, HEX_S3 |u| + |v| / 2) <= apothem -- the "hex radius" of (u, v).
// Wavy, the glass's surface ripples in v over time, as in raytrace.js.
const hexRadius = (u, v) => Math.max(Math.abs(v), HEX_S3 * Math.abs(u) + 0.5 * Math.abs(v));
function moonSection(p, t, wavy = false) {
  const rho = Math.hypot(p[0], p[2]), dr = rho - ORBIT.radius;
  const spin = moonSpin(t), cs = Math.cos(spin), sn = Math.sin(spin);
  const u = cs * dr + sn * p[1];
  let v = -sn * dr + cs * p[1];
  if (wavy) {
    const theta = rho > 1e-6 ? Math.atan2(p[2], p[0]) : 0;
    v -= 0.12 * MOON.apothem * Math.sin(t * 3 + (u / MOON.apothem) * 2.5 + theta * 5);
  }
  return { rho, dr, u, v };
}
// Below 0 inside the glass, as raytrace.js's hexTorusSideEval behind its end caps
function moonEval(p, t, wavy) {
  const dCap = Math.cos(MOON.halfAngle) * Math.abs(p[2]) - Math.sin(MOON.halfAngle) * p[0];
  if (dCap >= 0 || p[0] * p[0] + p[2] * p[2] < 1e-6) return Math.max(dCap, 1);
  const { u, v } = moonSection(p, t, wavy);
  return hexRadius(u, v) - MOON.apothem;
}

// Glass hexagonal torus section: one refractive curved hex tube, no texture
function drawMoon(parent, t) {
  drawPrimitive(hexPrismMesh, null, BUMP_MAPPING, multiply(parent, moonFrame(t)), MOON_MATERIAL);
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
// within 3% of its orbital speed, and it ends on exactly the tangent the
// press defined -- not a spiral that would keep turning past the heading the
// ship had when the button went down.
//
// ENGAGE.warpAt seconds after the press -- a beat after the departure blend
// lands on the line -- the ship jumps straight from orbital speed to
// ENGAGE.warp times it, with no ramp. The camera's dolly zoom into the
// fisheye, the star streaks and the warp flash (camera.js, raytrace.js, main.js)
// all start at that instant, keyed off `warpTau`, the time since the jump.
//
// At warp the ship flies on into the near star field, which has no edge: the
// stars stream past at the ship's true speed while the planet falls away.
//
// ENGAGE.reset seconds after the press, main.js puts the whole scene back the
// way it loaded (resetScene, which calls resetFlight below).
// ---------------------------------------------------------------------------

const ENGAGE = {
  blend: 2.5,       // s, length of the departure blend
  warpAt: 3.2,      // s after the press that the ship jumps to warp
  warp: 30,         // warp speed, in multiples of orbital speed
  reset: 8          // s from the press until the scene resets
};
const ORBIT_SPEED = ORBIT.radius * ORBIT.speed;   // units/s along the circle

const orbitAngle = t => -ORBIT.speed * t;
const orbitPoint = a => [ORBIT.radius * Math.cos(a), 0, -ORBIT.radius * Math.sin(a)];
const orbitForward = a => [Math.sin(a), 0, Math.cos(a)];

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
// since that jump (null before it), and `streak` the velocity the stars are
// drawn stretched by: the ship's own, at warp only.
const NO_STREAK = [0, 0, 0];
function straightLeg(f, tau) {
  const warp = tau >= ENGAGE.warpAt;
  const warpTau = warp ? tau - ENGAGE.warpAt : null;
  const extraSpeed = warp ? ORBIT_SPEED * (ENGAGE.warp - 1) : 0;
  const extraDist = warp ? extraSpeed * warpTau : 0;   // beyond orbital speed
  const speed = ORBIT_SPEED + extraSpeed;
  return {
    warpTau,
    pos: vadd(f.p0, vmul(f.f0, ORBIT_SPEED * tau + extraDist)),
    vel: vmul(f.f0, speed),
    streak: warp ? vmul(f.f0, speed) : NO_STREAK
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
    return { pos: orbitPoint(a), heading: a, warpTau: null, streak: NO_STREAK };
  }

  const tau = t - flight.t0;
  const line = straightLeg(flight, tau);
  if (flight.mode === "free")
    return { pos: line.pos, heading: flight.a0, warpTau: line.warpTau, streak: line.streak };

  // The circle being left, its phase frozen at the press and carried on from
  // there, so the two paths coincide where the blend starts
  const a = flight.a0 - ORBIT.speed * tau;
  const orb = { pos: orbitPoint(a), vel: vmul(orbitForward(a), ORBIT_SPEED) };

  const u = tau / ENGAGE.blend;
  const w = smootherstep(u), dw = smootherslope(u) / ENGAGE.blend;
  const gap = vsub(line.pos, orb.pos);

  const pos = vadd(orb.pos, vmul(gap, w));
  // d/dt of the blend: the two paths' own velocities, plus the weight's drift.
  // Both extra terms die at u = 1, which is what makes the arrival smooth.
  const vel = vadd(vadd(orb.vel, vmul(vsub(line.vel, orb.vel), w)), vmul(gap, dw));

  // At u = 1 the blend already equals the line exactly, so the handover is a no-op
  if (u >= 1) flight = { ...flight, mode: "free" };

  return { pos, heading: headingOf(vel, a), warpTau: line.warpTau, streak: line.streak };
}

// Level 1: place the ship on the path shipState() worked out. On the circle,
// translate(p) * rotateY(a) equals rotateY(a) * translate(R, 0, 0), and unlike
// that form it still holds once the ship has left the circle. (The ship boxes
// its own parts into groups for the ray tracer, ship.js.)
function drawOrbit(parent, { pos, heading }) {
  const frame = multiply(parent, multiply(translate(...pos), rotateY(heading)));
  const s = ORBIT.shipScale;
  drawShip(multiply(frame, scale(s, s, s)));
}
