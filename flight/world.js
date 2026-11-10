// The world: everything that moves under its own rules, stepped at a fixed
// rate and handed to the scene to draw.
//
//   world.entities   every ship. Each is either on a RAIL -- rail(t) gives its
//                    pose outright, as the orbit does -- or FLOWN: a
//                    controller reads the world and returns an intent, and
//                    the flight model turns that into motion.
//   world.player     the entity the camera rides and the helm steers
//
// An intent is all a pilot can ask of a ship, human or not:
//
//   { pitch, yaw, roll }   -1 .. 1 each: nose up, nose right, roll right
//   throttle               0 .. 1, the share of full impulse to hold
//   toggleWarp             true on the step the warp lever is thrown
//
// playerController() fills one in from the helm (main.js keeps `helm` up to
// date from the keys and the touch controls). Anything else that returns the
// same shape can fly a ship: that is the whole interface an AI needs.
//
// Positions are in the system's frame, the planet at the origin; a ship
// flies up its own +z with +y overhead, which puts +x to port.

const FLIGHT = {
  step: 1 / 120,          // s, the simulation's fixed step
  impulse: 3.0,           // units/s at full throttle
  warp: 10 * ORBIT.radius * ORBIT.speed,   // units/s at warp: ten times orbital speed
  rates: { pitch: 0.9, yaw: 0.6, roll: 1.5 },   // rad/s at full deflection
  warpTurn: 0.3,          // share of those rates left at warp
  turnEase: 0.3,          // s, how long the ship takes to answer the stick
  speedEase: 0.9,         // s, to answer the throttle,
  warpEase: 0.12,         //   to jump to warp speed: all but at once,
  dropEase: 0.2,          //   and to fall back out of it
  grip: 0.35,             // s, for the velocity to swing round to the nose,
  warpGrip: 0.1,          //   so a hard turn slides a little; less at warp
  warpCharge: 1.2,        // s the coils charge between the lever and the jump
  warpIn: 0.55,           // s, the lens's dolly zoom into warp,
  warpOut: 0.9,           //   and back out of it
  leverRate: 0.45,        // throttle per second while its key is held
  radius: 0.7             // the ship's size, for running into things
};
const ORBIT_SPEED = ORBIT.radius * ORBIT.speed;   // units/s along the circle

// Quintic smootherstep: w(0)=0, w(1)=1, w'=w''=0 at both ends
const smootherstep = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (6 * u - 15) + 10);
const clamp01 = v => Math.min(1, Math.max(0, v));
// What a first-order lag covers in dt: 1 - e^(-dt/tau), frame-rate independent
const easeShare = (dt, tau) => 1 - Math.exp(-dt / tau);

// ---------------------------------------------------------------------------
// The orbit, as a rail. rotateY(a) carries the point (R, 0, 0) around the y
// axis and turns the ship's +z to the direction of travel there, so one angle
// gives position, attitude and velocity; rotateX(tilt) tips the whole plane.
// ---------------------------------------------------------------------------
const ORBIT_TILT_MAT = rotateX(ORBIT.tilt);

function orbitPose(t) {
  const a = -ORBIT.speed * t;
  return {
    pos: transformPoint(ORBIT_TILT_MAT, [ORBIT.radius * Math.cos(a), 0, -ORBIT.radius * Math.sin(a)]),
    quat: quatFromMatrix(multiply(ORBIT_TILT_MAT, rotateY(a))),
    vel: transformVector(ORBIT_TILT_MAT, [ORBIT_SPEED * Math.sin(a), 0, ORBIT_SPEED * Math.cos(a)])
  };
}

function companionOrbitPose(offsetAngle = -Math.PI / 4) {
  return function(t) {
    const a = -ORBIT.speed * t + offsetAngle;
    return {
      pos: transformPoint(ORBIT_TILT_MAT, [ORBIT.radius * Math.cos(a), 0, -ORBIT.radius * Math.sin(a)]),
      quat: quatFromMatrix(multiply(ORBIT_TILT_MAT, rotateY(a))),
      vel: transformVector(ORBIT_TILT_MAT, [ORBIT_SPEED * Math.sin(a), 0, ORBIT_SPEED * Math.cos(a)])
    };
  };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
// warp.state: "off", "charge" (lever thrown, coils charging) or "on";
// warp.tau: seconds in that state. warpRamp is the lens's progress, 0 .. 1.
function makeEntity({ model, rail = null, controller = null }) {
  return { model, rail, controller, pos: [0, 0, 0], quat: [0, 0, 0, 1], vel: [0, 0, 0],
    angVel: [0, 0, 0], speed: 0, throttle: 0, warp: { state: "off", tau: 0 }, warpRamp: 0,
    radius: FLIGHT.radius, prev: null };
}

function addEntity({ model = "galaxy", rail = null, controller = null, pos = [0, 0, 0], quat = [0, 0, 0, 1], vel = [0, 0, 0], speed = 0, throttle = 0, engines = null } = {}) {
  const e = makeEntity({ model, rail, controller });
  e.pos = pos.slice();
  e.quat = quat.slice();
  e.vel = vel.slice();
  e.speed = speed;
  e.throttle = throttle;
  e.engines = engines ? { ...engines } : { impulse: 0.8, coils: 0.6, bussard: 0.8, scroll: 0 };
  world.entities.push(e);
  return e;
}

// The lens weight for a ramp: out fast and settling on the way in, and the
// mirror of that on the way out. setWarp() re-seats the ramp when the state
// flips mid-way, so the weight itself never jumps.
const easeOutCubic = u => u <= 0 ? 0 : u >= 1 ? 1 : 1 - (1 - u) ** 3;
const warpLevelOf = e => e.warp.state === "on" ? easeOutCubic(e.warpRamp) : clamp01(e.warpRamp) ** 3;
function setWarp(e, state) {
  const level = warpLevelOf(e);
  e.warp = { state, tau: 0 };
  if (state !== "charge") e.warpRamp = state === "on" ? 1 - Math.cbrt(1 - level) : Math.cbrt(level);
}

// One fixed step of a flown ship.
function fly(e, intent, dt, bodies) {
  // Warp: lever -> charge -> jump; the lever again drops back out
  if (intent.toggleWarp) setWarp(e, e.warp.state === "off" ? "charge" : "off");
  e.warp.tau += dt;
  if (e.warp.state === "charge" && e.warp.tau >= FLIGHT.warpCharge) setWarp(e, "on");
  const atWarp = e.warp.state === "on";
  e.warpRamp = clamp01(e.warpRamp + (atWarp ? dt / FLIGHT.warpIn : -dt / FLIGHT.warpOut));
  const level = warpLevelOf(e);

  // Attitude. The stick asks for turn rates about the ship's own axes; the
  // rates ease toward what is asked, and the attitude turns by them. Nose up
  // is a negative turn about +x (port), nose right a negative one about +y,
  // roll right a positive one about +z. Multiplying on the right is what
  // keeps those the SHIP's axes however it is already turned.
  const turn = 1 + (FLIGHT.warpTurn - 1) * level;
  const want = [-intent.pitch * FLIGHT.rates.pitch * turn, -intent.yaw * FLIGHT.rates.yaw * turn,
    intent.roll * FLIGHT.rates.roll * turn];
  const k = easeShare(dt, FLIGHT.turnEase);
  e.angVel = e.angVel.map((w, i) => w + (want[i] - w) * k);
  e.quat = quatNormalize(quatMul(e.quat, quatFromRotVec(vmul(e.angVel, dt))));

  // Speed answers the throttle; velocity swings round to the nose
  e.throttle = clamp01(intent.throttle);
  const target = atWarp ? FLIGHT.warp : e.throttle * FLIGHT.impulse;
  // (dropping out of warp sheds the speed quickly, while the lens closes)
  const ease = atWarp ? FLIGHT.warpEase : FLIGHT.speedEase + (FLIGHT.dropEase - FLIGHT.speedEase) * e.warpRamp;
  e.speed += (target - e.speed) * easeShare(dt, ease);
  const nose = quatRotate(e.quat, [0, 0, 1]);
  const grip = easeShare(dt, FLIGHT.grip + (FLIGHT.warpGrip - FLIGHT.grip) * level);
  e.vel = e.vel.map((v, i) => v + (nose[i] * e.speed - v) * grip);
  e.pos = vadd(e.pos, vmul(e.vel, dt));

  // Running into a planet or a moon: back out to the surface and keep only
  // the motion along it, so the ship slides round. It also ends a warp.
  for (const body of bodies) {
    const d = vsub(e.pos, body.center), dist = Math.hypot(...d), reach = body.radius + e.radius;
    if (dist >= reach) continue;
    const out = dist > 1e-6 ? vmul(d, 1 / dist) : nose.map(v => -v);
    e.pos = vadd(body.center, vmul(out, reach));
    const inward = vdot(e.vel, out);
    if (inward < 0) e.vel = vsub(e.vel, vmul(out, inward));
    if (e.warp.state !== "off") setWarp(e, "off");
    e.speed = Math.min(e.speed, FLIGHT.impulse);
  }
}

// ---------------------------------------------------------------------------
// The helm: what the player is asking for right now (main.js writes it)
// ---------------------------------------------------------------------------
const helm = { pitch: 0, yaw: 0, roll: 0, lever: 0, leverRate: 0, toggleWarp: false };
function playerController(e, dt) {
  helm.lever = clamp01(helm.lever + helm.leverRate * FLIGHT.leverRate * dt);
  const toggleWarp = helm.toggleWarp;
  helm.toggleWarp = false;          // a lever throw lasts one step
  return { pitch: helm.pitch, yaw: helm.yaw, roll: helm.roll, throttle: helm.lever, toggleWarp };
}

// ---------------------------------------------------------------------------
// The world and its clock
// ---------------------------------------------------------------------------
const world = { entities: [], player: null, helmT0: null, resetAt: null, pending: 0, engage: false };

// Back to how the page loads: one ship, riding the orbit
function resetWorld() {
  const player = makeEntity({ model: "galaxy", rail: orbitPose });
  Object.assign(world, { entities: [player], player, helmT0: null, resetAt: null, pending: 0, engage: false });
  Object.assign(helm, { pitch: 0, yaw: 0, roll: 0, leverRate: 0, toggleWarp: false,
    lever: ORBIT_SPEED / FLIGHT.impulse });
}

function requestEngage() { world.engage = true; }   // the button
// The player has the helm -- what the chase camera follows (camera.js)
function offOrbit() { return world.helmT0 !== null; }
// Seconds since the helm was taken, or null in orbit
function engageElapsed(t) { return offOrbit() ? t - world.helmT0 : null; }
// Going back to orbit: the scene fades out over `lead` seconds, then resets
function requestReset(t, lead) { if (offOrbit()) world.resetAt ??= t + lead; }
function resetDue(t) { return world.resetAt !== null && t >= world.resetAt; }

function stepWorld(t, dt) {
  const bodies = [{ center: [0, 0, 0], radius: PLANET.radius }, { center: moonCenter(t), radius: MOON.radius }];
  for (const e of world.entities) {
    e.prev = { pos: e.pos, quat: e.quat };
    if (e.rail) Object.assign(e, e.rail(t));
    else {
      const intent = e.controller ? e.controller(e, dt, world) : { pitch: 0, yaw: 0, roll: 0, throttle: e.throttle, toggleWarp: false };
      fly(e, intent, dt, bodies);
    }
  }
}

// Once a frame: advance the world to scene time t (dt since the last frame)
// and return the player's ship as the scene should draw it.
//
// The world moves in whole FLIGHT.step steps whatever the frame rate, so
// flight feels the same at 30 fps as at 144 and a slow frame can't tunnel a
// ship through the moon. What is left over of the frame is kept for the next
// one, and the pose drawn is blended between the last two steps by that
// remainder, so motion stays smooth when frames and steps don't line up.
function advanceWorld(t, dt) {
  const player = world.player;
  if (world.engage) {
    world.engage = false;
    if (player.rail) {
      // Take the helm: the ship leaves the rail exactly as the rail had it,
      // with the throttle set to the speed it was already making
      Object.assign(player, player.rail(t), { rail: null, controller: playerController, speed: ORBIT_SPEED });
      world.helmT0 = t;
      world.pending = 0;
    }
  }

  let pose;
  if (player.rail) {
    // Rails are exact at any t: nothing to step or blend
    for (const e of world.entities) if (e.rail) Object.assign(e, e.rail(t));
    player.throttle = ORBIT_SPEED / FLIGHT.impulse;
    pose = { pos: player.pos, quat: player.quat };
  } else {
    world.pending += dt;
    while (world.pending >= FLIGHT.step) {
      world.pending -= FLIGHT.step;
      stepWorld(t - world.pending, FLIGHT.step);
    }
    const a = world.pending / FLIGHT.step, prev = player.prev ?? player;
    pose = { pos: prev.pos.map((v, i) => v + (player.pos[i] - v) * a), quat: slerp(prev.quat, player.quat, a) };
    for (const e of world.entities) {
      if (e === player) continue;
      if (e.rail) Object.assign(e, e.rail(t));
      else if (e.prev) {
        e.pose = {
          pos: e.prev.pos.map((v, i) => v + (e.pos[i] - v) * a),
          quat: slerp(e.prev.quat, e.quat, a)
        };
      } else {
        e.pose = { pos: e.pos.slice(), quat: e.quat.slice() };
      }
    }
  }

  return { ...pose, vel: player.vel, speed: Math.hypot(...player.vel), throttle: player.throttle,
    helm: !player.rail, warp: player.warp, warpLevel: warpLevelOf(player),
    // The stars streak by the ship's own velocity; the lens weight scales it
    streak: player.vel };
}
