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
function makeEntity({ model, rail = null, controller = null, role = null }) {
  return {
    model, rail, controller, role,
    pos: [0, 0, 0], quat: [0, 0, 0, 1], vel: [0, 0, 0],
    angVel: [0, 0, 0], speed: 0, throttle: 0,
    warp: { state: "off", tau: 0 }, warpRamp: 0,
    radius: FLIGHT.radius, prev: null, pose: null,
    engines: { impulse: 0.8, coils: 0.6, bussard: 0.8, scroll: 0 },
    intent: { pitch: 0, yaw: 0, roll: 0, throttle: 0, toggleWarp: false }
  };
}

function addEntity({ model = "galaxy", rail = null, controller = null, role = null, pos = [0, 0, 0], quat = [0, 0, 0, 1], vel = [0, 0, 0], speed = 0, throttle = 0, engines = null, warp = null, warpRamp = 0 } = {}) {
  const e = makeEntity({ model, rail, controller, role });
  e.pos = pos.slice();
  e.quat = quat.slice();
  e.vel = vel.slice();
  e.speed = speed;
  e.throttle = throttle;
  if (warp) {
    e.warp = { state: warp.state, tau: warp.tau ?? 0 };
    e.warpRamp = warpRamp;
  }
  if (engines) {
    e.engines.impulse = engines.impulse ?? 0.8;
    e.engines.coils = engines.coils ?? 0.6;
    e.engines.bussard = engines.bussard ?? 0.8;
    e.engines.scroll = engines.scroll ?? 0;
  }
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

// Static unit vectors to eliminate array literal allocations in physics & steering
const STATIC_FORWARD = [0, 0, 1];
const STATIC_UP = [0, 1, 0];

// Scratch structures to eliminate per-step heap allocations
const FLY_SCRATCH = {
  angStep: [0, 0, 0],
  qRot: [0, 0, 0, 1],
  qMul: [0, 0, 0, 1],
  nose: [0, 0, 0]
};

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
  const want0 = -intent.pitch * FLIGHT.rates.pitch * turn;
  const want1 = -intent.yaw * FLIGHT.rates.yaw * turn;
  const want2 = intent.roll * FLIGHT.rates.roll * turn;
  const k = easeShare(dt, FLIGHT.turnEase);
  e.angVel[0] += (want0 - e.angVel[0]) * k;
  e.angVel[1] += (want1 - e.angVel[1]) * k;
  e.angVel[2] += (want2 - e.angVel[2]) * k;

  FLY_SCRATCH.angStep[0] = e.angVel[0] * dt;
  FLY_SCRATCH.angStep[1] = e.angVel[1] * dt;
  FLY_SCRATCH.angStep[2] = e.angVel[2] * dt;
  quatFromRotVecInto(FLY_SCRATCH.angStep, FLY_SCRATCH.qRot);
  quatMulInto(e.quat, FLY_SCRATCH.qRot, FLY_SCRATCH.qMul);
  quatNormalizeInto(FLY_SCRATCH.qMul, e.quat);

  // Speed answers the throttle; velocity swings round to the nose
  e.throttle = clamp01(intent.throttle);
  const target = atWarp ? FLIGHT.warp : e.throttle * FLIGHT.impulse;
  // (dropping out of warp sheds the speed quickly, while the lens closes)
  const ease = atWarp ? FLIGHT.warpEase : FLIGHT.speedEase + (FLIGHT.dropEase - FLIGHT.speedEase) * e.warpRamp;
  e.speed += (target - e.speed) * easeShare(dt, ease);

  quatRotateInto(e.quat, STATIC_FORWARD, FLY_SCRATCH.nose);
  const grip = easeShare(dt, FLIGHT.grip + (FLIGHT.warpGrip - FLIGHT.grip) * level);
  e.vel[0] += (FLY_SCRATCH.nose[0] * e.speed - e.vel[0]) * grip;
  e.vel[1] += (FLY_SCRATCH.nose[1] * e.speed - e.vel[1]) * grip;
  e.vel[2] += (FLY_SCRATCH.nose[2] * e.speed - e.vel[2]) * grip;

  e.pos[0] += e.vel[0] * dt;
  e.pos[1] += e.vel[1] * dt;
  e.pos[2] += e.vel[2] * dt;

  // Running into a planet or a moon: back out to the surface and keep only
  // the motion along it, so the ship slides round. It also ends a warp.
  for (let b = 0; b < bodies.length; b++) {
    const body = bodies[b];
    const dx = e.pos[0] - body.center[0];
    const dy = e.pos[1] - body.center[1];
    const dz = e.pos[2] - body.center[2];
    const dist = Math.hypot(dx, dy, dz);
    const reach = body.radius + e.radius;
    if (dist >= reach) continue;
    const invDist = dist > 1e-6 ? 1 / dist : 0;
    const outX = dist > 1e-6 ? dx * invDist : -FLY_SCRATCH.nose[0];
    const outY = dist > 1e-6 ? dy * invDist : -FLY_SCRATCH.nose[1];
    const outZ = dist > 1e-6 ? dz * invDist : -FLY_SCRATCH.nose[2];
    e.pos[0] = body.center[0] + outX * reach;
    e.pos[1] = body.center[1] + outY * reach;
    e.pos[2] = body.center[2] + outZ * reach;
    const inward = e.vel[0] * outX + e.vel[1] * outY + e.vel[2] * outZ;
    if (inward < 0) {
      e.vel[0] -= outX * inward;
      e.vel[1] -= outY * inward;
      e.vel[2] -= outZ * inward;
    }
    if (e.warp.state !== "off") setWarp(e, "off");
    const vLen = Math.hypot(e.vel[0], e.vel[1], e.vel[2]);
    if (vLen > FLIGHT.impulse) {
      const s = FLIGHT.impulse / vLen;
      e.vel[0] *= s; e.vel[1] *= s; e.vel[2] *= s;
    }
    e.speed = Math.min(vLen, FLIGHT.impulse);
  }
}

// ---------------------------------------------------------------------------
// Entity-to-entity collisions
// ---------------------------------------------------------------------------
// Ships bounce/slide or deflect rather than passing through each other.
function resolveEntityCollisions(entities) {
  const count = entities.length;
  if (count < 2) return;
  const iterations = count > 2 ? 4 : 1;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < count - 1; i++) {
      const a = entities[i];
      const ra = a.radius || FLIGHT.radius;
      for (let j = i + 1; j < count; j++) {
        const b = entities[j];
        const rb = b.radius || FLIGHT.radius;
        const reach = ra + rb;
        const dx = a.pos[0] - b.pos[0];
        const dy = a.pos[1] - b.pos[1];
        const dz = a.pos[2] - b.pos[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq >= reach * reach) continue;

        const dist = Math.sqrt(distSq);
        const invDist = dist > 1e-6 ? 1 / dist : 0;
        const nx = dist > 1e-6 ? dx * invDist : 0;
        const ny = dist > 1e-6 ? dy * invDist : 1;
        const nz = dist > 1e-6 ? dz * invDist : 0;
        const overlap = reach - dist;

        const aRail = !!a.rail;
        const bRail = !!b.rail;

        if (aRail && bRail) {
          continue;
        } else if (aRail) {
          b.pos[0] -= nx * overlap;
          b.pos[1] -= ny * overlap;
          b.pos[2] -= nz * overlap;
        } else if (bRail) {
          a.pos[0] += nx * overlap;
          a.pos[1] += ny * overlap;
          a.pos[2] += nz * overlap;
        } else {
          const half = overlap * 0.5;
          a.pos[0] += nx * half;
          a.pos[1] += ny * half;
          a.pos[2] += nz * half;
          b.pos[0] -= nx * half;
          b.pos[1] -= ny * half;
          b.pos[2] -= nz * half;
        }

        // Interrupt warp and apply velocity reflection on first pass
        if (iter === 0) {
          if (!aRail && a.warp && a.warp.state !== "off") {
            setWarp(a, "off");
            const vLenA = Math.hypot(a.vel[0], a.vel[1], a.vel[2]);
            if (vLenA > FLIGHT.impulse) {
              const s = FLIGHT.impulse / vLenA;
              a.vel[0] *= s; a.vel[1] *= s; a.vel[2] *= s;
            }
            a.speed = Math.min(vLenA, FLIGHT.impulse);
          }
          if (!bRail && b.warp && b.warp.state !== "off") {
            setWarp(b, "off");
            const vLenB = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
            if (vLenB > FLIGHT.impulse) {
              const s = FLIGHT.impulse / vLenB;
              b.vel[0] *= s; b.vel[1] *= s; b.vel[2] *= s;
            }
            b.speed = Math.min(vLenB, FLIGHT.impulse);
          }

          // Relative velocity along collision normal
          const rvx = a.vel[0] - b.vel[0];
          const rvy = a.vel[1] - b.vel[1];
          const rvz = a.vel[2] - b.vel[2];
          const vn = rvx * nx + rvy * ny + rvz * nz;

          if (vn < 0) {
            const restitution = 0.5;
            const imp = -(1 + restitution) * vn;
            if (!aRail && !bRail) {
              const halfImp = imp * 0.5;
              a.vel[0] += nx * halfImp;
              a.vel[1] += ny * halfImp;
              a.vel[2] += nz * halfImp;
              b.vel[0] -= nx * halfImp;
              b.vel[1] -= ny * halfImp;
              b.vel[2] -= nz * halfImp;
            } else if (!aRail && bRail) {
              a.vel[0] += nx * imp;
              a.vel[1] += ny * imp;
              a.vel[2] += nz * imp;
            } else if (aRail && !bRail) {
              b.vel[0] -= nx * imp;
              b.vel[1] -= ny * imp;
              b.vel[2] -= nz * imp;
            }

            if (!aRail) {
              const vLenA = Math.hypot(a.vel[0], a.vel[1], a.vel[2]);
              if (vLenA > FLIGHT.impulse) {
                const s = FLIGHT.impulse / vLenA;
                a.vel[0] *= s; a.vel[1] *= s; a.vel[2] *= s;
              }
              a.speed = Math.min(vLenA, FLIGHT.impulse);
            }
            if (!bRail) {
              const vLenB = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
              if (vLenB > FLIGHT.impulse) {
                const s = FLIGHT.impulse / vLenB;
                b.vel[0] *= s; b.vel[1] *= s; b.vel[2] *= s;
              }
              b.speed = Math.min(vLenB, FLIGHT.impulse);
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Autonomous AI Flight Controllers & Steering
// ---------------------------------------------------------------------------
// AI controllers compute pilot intents { pitch, yaw, roll, throttle, toggleWarp }
// to fly ships autonomously towards target waypoints or in formation.

const AI_SCRATCH = {
  conj: [0, 0, 0, 1],
  wAim: [0, 0, 0],
  localAim: [0, 0, 0],
  worldUp: [0, 0, 0],
  localUp: [0, 0, 0],
  slotWorld: [0, 0, 0]
};

function computeSteeringIntent(e, targetPos, targetVel, targetQuat, dt, options = {}, outIntent = null) {
  const intent = outIntent || e.intent || { pitch: 0, yaw: 0, roll: 0, throttle: 0, toggleWarp: false };
  const dx = targetPos[0] - e.pos[0];
  const dy = targetPos[1] - e.pos[1];
  const dz = targetPos[2] - e.pos[2];
  const dist = Math.hypot(dx, dy, dz);

  // Velocity leading: predict target motion to intercept/arrive smoothly
  const targetSpeed = targetVel ? Math.hypot(targetVel[0], targetVel[1], targetVel[2]) : 0;
  const leadTime = Math.min(1.2, dist / Math.max(e.speed, FLIGHT.impulse * 0.5));
  let aimX = targetPos[0] + (targetVel ? targetVel[0] * leadTime * 0.4 : 0);
  let aimY = targetPos[1] + (targetVel ? targetVel[1] * leadTime * 0.4 : 0);
  let aimZ = targetPos[2] + (targetVel ? targetVel[2] * leadTime * 0.4 : 0);

  // Deflect aim away from nearby celestial bodies (planet, moon)
  if (typeof SYSTEM_BODIES !== "undefined") {
    for (let b = 0; b < SYSTEM_BODIES.length; b++) {
      const body = SYSTEM_BODIES[b];
      const bx = e.pos[0] - body.center[0];
      const by = e.pos[1] - body.center[1];
      const bz = e.pos[2] - body.center[2];
      const bDist = Math.hypot(bx, by, bz);
      const bSafe = body.radius + (e.radius || FLIGHT.radius) + 1.2;
      if (bDist < bSafe && bDist > 1e-4) {
        const push = ((bSafe - bDist) / bSafe) * 6.0;
        aimX += (bx / bDist) * push;
        aimY += (by / bDist) * push;
        aimZ += (bz / bDist) * push;
      }

      // Predictive trajectory deflection if line of aim penetrates celestial envelope
      const toAimX = aimX - e.pos[0];
      const toAimY = aimY - e.pos[1];
      const toAimZ = aimZ - e.pos[2];
      const toAimDist = Math.hypot(toAimX, toAimY, toAimZ);
      if (toAimDist > 1e-4) {
        const dirX = toAimX / toAimDist;
        const dirY = toAimY / toAimDist;
        const dirZ = toAimZ / toAimDist;
        const proj = -bx * dirX - by * dirY - bz * dirZ;
        if (proj > 0 && proj < toAimDist) {
          const closeX = e.pos[0] + dirX * proj - body.center[0];
          const closeY = e.pos[1] + dirY * proj - body.center[1];
          const closeZ = e.pos[2] + dirZ * proj - body.center[2];
          const closeDist = Math.hypot(closeX, closeY, closeZ);
          if (closeDist < bSafe) {
            const rayPush = ((bSafe - closeDist) / bSafe) * 5.0;
            const pushX = closeDist > 1e-4 ? closeX / closeDist : (Math.abs(dirY) < 0.9 ? 0 : 1);
            const pushY = closeDist > 1e-4 ? closeY / closeDist : (Math.abs(dirY) < 0.9 ? 1 : 0);
            const pushZ = closeDist > 1e-4 ? closeZ / closeDist : 0;
            aimX += pushX * rayPush;
            aimY += pushY * rayPush;
            aimZ += pushZ * rayPush;
          }
        }
      }
    }
  }

  const adx = aimX - e.pos[0];
  const ady = aimY - e.pos[1];
  const adz = aimZ - e.pos[2];
  const aimDist = Math.hypot(adx, ady, adz);
  const invAim = aimDist > 1e-5 ? 1 / aimDist : 1;
  AI_SCRATCH.wAim[0] = aimDist > 1e-5 ? adx * invAim : 0;
  AI_SCRATCH.wAim[1] = aimDist > 1e-5 ? ady * invAim : 0;
  AI_SCRATCH.wAim[2] = aimDist > 1e-5 ? adz * invAim : 1;

  // Transform world aim direction into ship's local coordinates
  AI_SCRATCH.conj[0] = -e.quat[0];
  AI_SCRATCH.conj[1] = -e.quat[1];
  AI_SCRATCH.conj[2] = -e.quat[2];
  AI_SCRATCH.conj[3] = e.quat[3];
  quatRotateInto(AI_SCRATCH.conj, AI_SCRATCH.wAim, AI_SCRATCH.localAim);
  const lax = AI_SCRATCH.localAim[0];
  const lay = AI_SCRATCH.localAim[1];
  const laz = AI_SCRATCH.localAim[2];

  // Pitch: positive lifts nose up (towards +y)
  const pitchAngle = Math.atan2(lay, laz);
  const pitch = Math.max(-1, Math.min(1, pitchAngle * 1.8));

  // Yaw: positive swings nose starboard (towards -x)
  const yawAngle = Math.atan2(-lax, laz);
  const yaw = Math.max(-1, Math.min(1, yawAngle * 1.8));

  // Roll: align ship's dorsal up with target's up or system up, banking into turns.
  // In the ship's local coordinate frame (+x port, +y dorsal up, +z nose), positive roll
  // about +z rotates +x towards +y (raising port, dropping starboard) and tilts dorsal +y
  // towards starboard (-x). Therefore an error where desired up is towards starboard (localUp.x < 0)
  // requires positive roll, which means rollAngle must be -atan2(localUp.x, localUp.y).
  if (targetQuat) {
    quatRotateInto(targetQuat, STATIC_UP, AI_SCRATCH.worldUp);
  } else {
    AI_SCRATCH.worldUp[0] = 0; AI_SCRATCH.worldUp[1] = 1; AI_SCRATCH.worldUp[2] = 0;
  }
  quatRotateInto(AI_SCRATCH.conj, AI_SCRATCH.worldUp, AI_SCRATCH.localUp);
  const rollAngle = -Math.atan2(AI_SCRATCH.localUp[0], AI_SCRATCH.localUp[1]);
  const roll = Math.max(-1, Math.min(1, rollAngle * 1.5 + yaw * 0.35));

  // Throttle
  const standoff = options.standoff || options.arrivalDist || 0;
  const brakeLead = Math.max(0, e.speed - targetSpeed) * 0.45;
  const effectiveDist = Math.max(0, dist - standoff - brakeLead);
  const maxSpd = options.maxSpeed || FLIGHT.impulse;
  let desiredSpeed;
  if (effectiveDist > 6.0) {
    desiredSpeed = maxSpd;
  } else {
    desiredSpeed = Math.min(maxSpd, targetSpeed + effectiveDist * 0.6);
  }
  if (laz < 0.2) {
    desiredSpeed = Math.min(desiredSpeed, maxSpd * 0.35);
  }
  const throttle = clamp01(desiredSpeed / FLIGHT.impulse);

  // Warp synchronization
  let toggleWarp = false;
  if (options.allowWarp !== false) {
    const targetWarp = options.targetWarpState || (options.target && options.target.warp ? options.target.warp.state : "off");
    const targetAtWarp = targetWarp === "on" || targetWarp === "charge";

    if (e.warp.state === "off") {
      if (targetAtWarp || (dist > 25 && laz > 0.7)) {
        toggleWarp = true;
      }
    } else {
      if (!targetAtWarp && (dist < 10 || laz < 0.2)) {
        toggleWarp = true;
      }
    }
  }

  intent.pitch = pitch;
  intent.yaw = yaw;
  intent.roll = roll;
  intent.throttle = throttle;
  intent.toggleWarp = toggleWarp;
  return intent;
}

const WINGMAN_SLOTS = [
  [-3.2, 0.4, -4.5],  // Port wingman
  [3.2, 0.4, -4.5],   // Starboard wingman
  [0.0, 1.8, -6.5],   // High rear escort
  [-5.5, 0.8, -8.0],  // Wide port wingman
  [5.5, 0.8, -8.0]    // Wide starboard wingman
];

function createWingmanController({ target = null, slotOffset = null, slotIndex = 0 } = {}) {
  const defaultSlot = slotOffset || WINGMAN_SLOTS[slotIndex % WINGMAN_SLOTS.length];
  const targetPos = [0, 0, 0];
  const targetVel = [0, 0, 0];
  const targetQuat = [0, 0, 0, 1];
  const options = { arrivalDist: 0.2, target: null, allowWarp: true };

  return function wingmanCtrl(e, dt, worldRef) {
    const lead = target || (worldRef ? worldRef.player : world.player);
    if (!lead) {
      const intent = e.intent || (e.intent = { pitch: 0, yaw: 0, roll: 0, throttle: 0, toggleWarp: false });
      intent.pitch = 0; intent.yaw = 0; intent.roll = 0; intent.throttle = 0.5; intent.toggleWarp = false;
      return intent;
    }

    // Determine formation slot offset without heap allocations
    let slot = defaultSlot;
    const ents = (worldRef && worldRef.entities) || (typeof world !== "undefined" && world.entities);
    if (!slotOffset && ents) {
      let idx = 0;
      for (let i = 0; i < ents.length; i++) {
        const ent = ents[i];
        if (ent === lead) continue;
        if (ent === e) {
          slot = WINGMAN_SLOTS[idx % WINGMAN_SLOTS.length];
          break;
        }
        idx++;
      }
    }

    // Calculate slot world position
    quatRotateInto(lead.quat, slot, AI_SCRATCH.slotWorld);
    targetPos[0] = lead.pos[0] + AI_SCRATCH.slotWorld[0];
    targetPos[1] = lead.pos[1] + AI_SCRATCH.slotWorld[1];
    targetPos[2] = lead.pos[2] + AI_SCRATCH.slotWorld[2];
    targetVel[0] = lead.vel[0];
    targetVel[1] = lead.vel[1];
    targetVel[2] = lead.vel[2];
    targetQuat[0] = lead.quat[0];
    targetQuat[1] = lead.quat[1];
    targetQuat[2] = lead.quat[2];
    targetQuat[3] = lead.quat[3];
    options.target = lead;

    return computeSteeringIntent(e, targetPos, targetVel, targetQuat, dt, options, e.intent);
  };
}

const defaultWingmanController = createWingmanController();
function wingmanController(e, dt, worldRef) {
  return defaultWingmanController(e, dt, worldRef);
}

function createPursuitController({ target = null, standoff = 2.0 } = {}) {
  const targetPos = [0, 0, 0];
  const targetVel = [0, 0, 0];
  const targetQuat = [0, 0, 0, 1];
  const options = { arrivalDist: 0.2, target: null, allowWarp: true };

  return function pursuitCtrl(e, dt, worldRef) {
    const tgt = target || (worldRef ? worldRef.player : world.player);
    if (!tgt) {
      const intent = e.intent || (e.intent = { pitch: 0, yaw: 0, roll: 0, throttle: 0, toggleWarp: false });
      intent.pitch = 0; intent.yaw = 0; intent.roll = 0; intent.throttle = 0; intent.toggleWarp = false;
      return intent;
    }

    // Offset target position along line from target to pursuer to maintain standoff
    const dx = e.pos[0] - tgt.pos[0];
    const dy = e.pos[1] - tgt.pos[1];
    const dz = e.pos[2] - tgt.pos[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > 1e-4 && standoff > 0) {
      const invD = 1 / d;
      targetPos[0] = tgt.pos[0] + dx * invD * standoff;
      targetPos[1] = tgt.pos[1] + dy * invD * standoff;
      targetPos[2] = tgt.pos[2] + dz * invD * standoff;
    } else {
      targetPos[0] = tgt.pos[0]; targetPos[1] = tgt.pos[1]; targetPos[2] = tgt.pos[2];
    }
    targetVel[0] = tgt.vel[0]; targetVel[1] = tgt.vel[1]; targetVel[2] = tgt.vel[2];
    targetQuat[0] = tgt.quat[0]; targetQuat[1] = tgt.quat[1]; targetQuat[2] = tgt.quat[2]; targetQuat[3] = tgt.quat[3];
    options.target = tgt;

    return computeSteeringIntent(e, targetPos, targetVel, targetQuat, dt, options, e.intent);
  };
}

const defaultPursuitController = createPursuitController();
function pursuitController(e, dt, worldRef) {
  return defaultPursuitController(e, dt, worldRef);
}

function createPatrolController({ waypoints = null, radius = 5.0, speed = 0.5 } = {}) {
  const pts = waypoints || [
    [radius, 0, 0],
    [0, radius * 0.5, radius],
    [-radius, 0, 0],
    [0, -radius * 0.5, -radius]
  ];
  const options = { standoff: 0.5, maxSpeed: speed * FLIGHT.impulse, allowWarp: false };

  return function patrolCtrl(e, dt) {
    let wpIndex = e.patrolIndex || 0;
    const wp = pts[wpIndex];
    const dist = Math.hypot(wp[0] - e.pos[0], wp[1] - e.pos[1], wp[2] - e.pos[2]);
    if (dist < 1.5) {
      wpIndex = (wpIndex + 1) % pts.length;
      e.patrolIndex = wpIndex;
    }
    return computeSteeringIntent(e, pts[wpIndex], null, null, dt, options, e.intent);
  };
}

const defaultPatrolController = createPatrolController();
function patrolController(e, dt, worldRef) {
  return defaultPatrolController(e, dt, worldRef);
}

// ---------------------------------------------------------------------------
// The helm: what the player is asking for right now (main.js writes it)
// ---------------------------------------------------------------------------
const helm = { pitch: 0, yaw: 0, roll: 0, lever: 0, leverRate: 0, toggleWarp: false };
function playerController(e, dt) {
  helm.lever = clamp01(helm.lever + helm.leverRate * FLIGHT.leverRate * dt);
  const intent = e.intent || (e.intent = { pitch: 0, yaw: 0, roll: 0, throttle: 0, toggleWarp: false });
  intent.pitch = helm.pitch;
  intent.yaw = helm.yaw;
  intent.roll = helm.roll;
  intent.throttle = helm.lever;
  intent.toggleWarp = helm.toggleWarp;
  helm.toggleWarp = false;          // a lever throw lasts one step
  return intent;
}

// ---------------------------------------------------------------------------
// The world and its clock
// ---------------------------------------------------------------------------
const world = { entities: [], player: null, helmT0: null, resetAt: null, pending: 0, engage: false };

// Back to how the page loads: one ship, riding the orbit
function resetWorld() {
  const player = makeEntity({ model: "galaxy", rail: orbitPose, role: "player" });
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

const SYSTEM_BODIES = [
  { center: [0, 0, 0], radius: PLANET.radius },
  { center: [0, 0, 0], radius: MOON.radius }
];

function stepWorld(t, dt) {
  const mc = moonCenter(t, SYSTEM_BODIES[1].center);
  if (mc !== SYSTEM_BODIES[1].center) {
    SYSTEM_BODIES[1].center[0] = mc[0];
    SYSTEM_BODIES[1].center[1] = mc[1];
    SYSTEM_BODIES[1].center[2] = mc[2];
  }

  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i];
    if (!e.prev) e.prev = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
    e.prev.pos[0] = e.pos[0];
    e.prev.pos[1] = e.pos[1];
    e.prev.pos[2] = e.pos[2];
    e.prev.quat[0] = e.quat[0];
    e.prev.quat[1] = e.quat[1];
    e.prev.quat[2] = e.quat[2];
    e.prev.quat[3] = e.quat[3];

    if (e.rail) {
      Object.assign(e, e.rail(t));
    } else {
      const intent = e.controller ? e.controller(e, dt, world) : (e.intent || { pitch: 0, yaw: 0, roll: 0, throttle: e.throttle, toggleWarp: false });
      fly(e, intent, dt, SYSTEM_BODIES);
    }
  }

  resolveEntityCollisions(world.entities);
}

const ADVANCE_POSE = {
  pos: [0, 0, 0],
  quat: [0, 0, 0, 1],
  vel: [0, 0, 0],
  speed: 0,
  throttle: 0,
  helm: false,
  warp: null,
  warpLevel: 0,
  streak: null
};

// Once a frame: advance the world to scene time t (dt since the last frame)
// and return the player's ship as the scene should draw it.
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

      // Transition wingmen into free flight formation
      for (let i = 0; i < world.entities.length; i++) {
        const e = world.entities[i];
        if (e === player) continue;
        if (e.rail && e.role === "wingman") {
          Object.assign(e, e.rail(t), {
            rail: null,
            controller: e.controller || wingmanController,
            speed: ORBIT_SPEED
          });
        }
      }
    }
  }

  if (player.rail) {
    // Rails are exact at any t: nothing to step or blend
    for (let i = 0; i < world.entities.length; i++) {
      const e = world.entities[i];
      if (e.rail) Object.assign(e, e.rail(t));
    }
    player.throttle = ORBIT_SPEED / FLIGHT.impulse;
    ADVANCE_POSE.pos[0] = player.pos[0];
    ADVANCE_POSE.pos[1] = player.pos[1];
    ADVANCE_POSE.pos[2] = player.pos[2];
    ADVANCE_POSE.quat[0] = player.quat[0];
    ADVANCE_POSE.quat[1] = player.quat[1];
    ADVANCE_POSE.quat[2] = player.quat[2];
    ADVANCE_POSE.quat[3] = player.quat[3];
  } else {
    world.pending += dt;
    while (world.pending >= FLIGHT.step) {
      world.pending -= FLIGHT.step;
      stepWorld(t - world.pending, FLIGHT.step);
    }
    const a = world.pending / FLIGHT.step, prev = player.prev ?? player;
    ADVANCE_POSE.pos[0] = prev.pos[0] + (player.pos[0] - prev.pos[0]) * a;
    ADVANCE_POSE.pos[1] = prev.pos[1] + (player.pos[1] - prev.pos[1]) * a;
    ADVANCE_POSE.pos[2] = prev.pos[2] + (player.pos[2] - prev.pos[2]) * a;
    slerpInto(prev.quat, player.quat, a, ADVANCE_POSE.quat);
    for (let i = 0; i < world.entities.length; i++) {
      const e = world.entities[i];
      if (e === player) continue;
      if (e.rail) {
        Object.assign(e, e.rail(t));
      } else if (e.prev) {
        if (!e.pose) e.pose = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
        e.pose.pos[0] = e.prev.pos[0] + (e.pos[0] - e.prev.pos[0]) * a;
        e.pose.pos[1] = e.prev.pos[1] + (e.pos[1] - e.prev.pos[1]) * a;
        e.pose.pos[2] = e.prev.pos[2] + (e.pos[2] - e.prev.pos[2]) * a;
        slerpInto(e.prev.quat, e.quat, a, e.pose.quat);
      } else {
        if (!e.pose) e.pose = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
        e.pose.pos[0] = e.pos[0];
        e.pose.pos[1] = e.pos[1];
        e.pose.pos[2] = e.pos[2];
        e.pose.quat[0] = e.quat[0];
        e.pose.quat[1] = e.quat[1];
        e.pose.quat[2] = e.quat[2];
        e.pose.quat[3] = e.quat[3];
      }
    }
  }

  ADVANCE_POSE.vel = player.vel;
  ADVANCE_POSE.speed = Math.hypot(player.vel[0], player.vel[1], player.vel[2]);
  ADVANCE_POSE.throttle = player.throttle;
  ADVANCE_POSE.helm = !player.rail;
  ADVANCE_POSE.warp = player.warp;
  ADVANCE_POSE.warpLevel = warpLevelOf(player);
  ADVANCE_POSE.streak = player.vel;
  return ADVANCE_POSE;
}

if (typeof window !== "undefined") {
  window.wingmanController = wingmanController;
  window.createWingmanController = createWingmanController;
  window.pursuitController = pursuitController;
  window.createPursuitController = createPursuitController;
  window.patrolController = patrolController;
  window.createPatrolController = createPatrolController;
  window.resolveEntityCollisions = resolveEntityCollisions;
  window.computeSteeringIntent = computeSteeringIntent;
}
