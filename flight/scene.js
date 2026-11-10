// Scene above the ship, in the same functional style as ship.js:
//
//   drawSystem
//   ├── setSky            (the sky's frame; the shader draws the stars)
//   ├── drawPlanet        (spins on its own axis)
//   ├── drawMoon          (a glass moon on its own tilted orbit)
//   └── drawShipAt        (wherever the world put the ship, world.js)
//       └── drawShip      (ship.js)
//
// The planet, the moon and the ship are siblings, so the planet's spin never
// reaches the ship.
//
// world.js says where the ship is and how it is turned: riding its orbit, or
// flown by whoever has the helm.

const PLANET = { radius: 2.4, spin: 0.08 };                     // spin in rad/s

// Matte rock: almost no ambient (dark night side, sharp terminator), full
// diffuse, a faint broad specular, gentler bumps than the ship, and a blue
// atmosphere glow on the sunlit limb
const PLANET_MATERIAL = {
  ka: 0.03, kd: 1.0, ks: 0.05, shininess: 8, bumpScale: 1.2, atmosphere: [0.35, 0.6, 1.0]
};
const ORBIT = { radius: 4.4, speed: 0.25, tilt: 0.25, shipScale: 0.32 };

// The moon: a ball of glass well outside the ship's orbit, on a slower orbit
// tilted the other way. `phase` puts it just in front of the planet on load,
// overlapping its limb, so the starting view sees the planet bent through it.
const MOON = { radius: 0.9, orbit: 7.6, speed: 0.045, tilt: -0.3, phase: -0.95 };
// Nearly all transmitted, a slight blue cast from absorbing red over the
// distance through it, and a sharp highlight from each light
const MOON_MATERIAL = {
  ka: 0.02, kd: 0.1, ks: 0.9, shininess: 240, bumpScale: 0, atmosphere: [0, 0, 0],
  kt: 0.94, absorb: [0.22, 0.08, 0.03]
};

// Level 0: planetary system at the origin; t is the scene clock (main.js).
// `ship` is this frame's advanceWorld(): the camera needs it before anything is
// drawn, so main.js advances the flight path and passes the result down.
function drawSystem(parent, t, ship) {
  // The stars are fixed in space around the system (raytrace.js), so the
  // sky's frame is the system's own. They streak by the ship's warp speed
  // through them, turned into eye space; they move past the eye the opposite
  // way to the ship. The streaks draw out with the lens as it opens (camera.js).
  const s = ship.streak;
  const sx = -(parent[0] * s[0] + parent[4] * s[1] + parent[8] * s[2]) * lensFisheye;
  const sy = -(parent[1] * s[0] + parent[5] * s[1] + parent[9] * s[2]) * lensFisheye;
  const sz = -(parent[2] * s[0] + parent[6] * s[1] + parent[10] * s[2]) * lensFisheye;
  setSky(parent, sx, sy, sz);
  drawPlanet(parent, t);
  drawMoon(parent, t);
  drawEntities(parent, t, ship);
}

const PLANET_LOCAL_MAT = new Float32Array(16);
const PLANET_MV_MAT = new Float32Array(16);
PLANET_LOCAL_MAT[15] = 1;

// Planet: a fine sphere wearing the antelope photo, bump-mapped from its luminance
function drawPlanet(parent, t) {
  const r = PLANET.radius;
  if (typeof addInstance === "function" && typeof PLANET_MODEL !== "undefined" && PLANET_MODEL) {
    const a = PLANET.spin * t;
    const c = Math.cos(a) * r, s = Math.sin(a) * r;
    PLANET_LOCAL_MAT[0] = c;
    PLANET_LOCAL_MAT[2] = s;
    PLANET_LOCAL_MAT[5] = r;
    PLANET_LOCAL_MAT[8] = -s;
    PLANET_LOCAL_MAT[10] = c;
    multiplyInto(parent, PLANET_LOCAL_MAT, PLANET_MV_MAT);
    addInstance(PLANET_MODEL, PLANET_MV_MAT);
  } else if (typeof drawPrimitive === "function") {
    const modelView = multiply(parent, multiply(rotateY(PLANET.spin * t), scale(r, r, r)));
    drawPrimitive(planetMesh, planetTexture, BUMP_MAPPING, modelView, PLANET_MATERIAL);
  }
}

// The moon's frame at scene time t, and where that puts its center
const moonFrame = t => multiply(rotateX(MOON.tilt),
  multiply(rotateY(MOON.phase + MOON.speed * t), translate(MOON.orbit, 0, 0)));

const MOON_CENTER_SCRATCH = [0, 0, 0];
function moonCenter(t, out = null) {
  const target = out || MOON_CENTER_SCRATCH;
  const a = MOON.phase + MOON.speed * t;
  const ca = Math.cos(a), sa = Math.sin(a);
  const ct = Math.cos(MOON.tilt), st = Math.sin(MOON.tilt);
  target[0] = ca * MOON.orbit;
  target[1] = st * sa * MOON.orbit;
  target[2] = -ct * sa * MOON.orbit;
  return target;
}

const MOON_LOCAL_MAT = new Float32Array(16);
const MOON_MV_MAT = new Float32Array(16);
MOON_LOCAL_MAT[15] = 1;

// Moon: one glass sphere, no texture -- what it shows is what's behind it
function drawMoon(parent, t) {
  const r = MOON.radius;
  if (typeof addInstance === "function" && typeof MOON_MODEL !== "undefined" && MOON_MODEL) {
    const a = MOON.phase + MOON.speed * t;
    const ca = Math.cos(a), sa = Math.sin(a);
    const ct = Math.cos(MOON.tilt), st = Math.sin(MOON.tilt);
    const orb = MOON.orbit;

    MOON_LOCAL_MAT[0]  = ca * r;
    MOON_LOCAL_MAT[1]  = st * sa * r;
    MOON_LOCAL_MAT[2]  = -ct * sa * r;

    MOON_LOCAL_MAT[5]  = ct * r;
    MOON_LOCAL_MAT[6]  = st * r;

    MOON_LOCAL_MAT[8]  = sa * r;
    MOON_LOCAL_MAT[9]  = -st * ca * r;
    MOON_LOCAL_MAT[10] = ct * ca * r;

    MOON_LOCAL_MAT[12] = ca * orb;
    MOON_LOCAL_MAT[13] = st * sa * orb;
    MOON_LOCAL_MAT[14] = -ct * sa * orb;

    multiplyInto(parent, MOON_LOCAL_MAT, MOON_MV_MAT);
    addInstance(MOON_MODEL, MOON_MV_MAT);
  } else if (typeof drawPrimitive === "function") {
    const modelView = multiply(parent, multiply(moonFrame(t), scale(r, r, r)));
    drawPrimitive(sphereMesh, null, BUMP_MAPPING, modelView, MOON_MATERIAL);
  }
}

// Level 1: place the ship where the world has it. Its attitude is a
// quaternion, so the frame is translate(pos) * rotation with no axis singled
// out: pitch, yaw and roll all arrive the same way.
const NAV_LIGHT_MODEL_OFFSET = [0, 0.12, 2.455];
const SHIP_LOCAL_MAT = new Float32Array(16);
const SHIP_MV_MAT = new Float32Array(16);

function drawShipAt(parent, { pos, quat }, engineParams = null, isPlayer = false) {
  if (typeof addInstance === "function" && typeof GALAXY_MODEL !== "undefined" && GALAXY_MODEL) {
    if (typeof scene !== "undefined" && typeof MAX_INSTANCES !== "undefined" && scene.instCount >= MAX_INSTANCES) return;
    const s = ORBIT.shipScale;
    const x = quat[0], y = quat[1], z = quat[2], w = quat[3];
    const px = pos[0], py = pos[1], pz = pos[2];

    SHIP_LOCAL_MAT[0]  = (1 - 2 * (y * y + z * z)) * s;
    SHIP_LOCAL_MAT[1]  = (2 * (x * y + z * w)) * s;
    SHIP_LOCAL_MAT[2]  = (2 * (x * z - y * w)) * s;
    SHIP_LOCAL_MAT[3]  = 0;

    SHIP_LOCAL_MAT[4]  = (2 * (x * y - z * w)) * s;
    SHIP_LOCAL_MAT[5]  = (1 - 2 * (x * x + z * z)) * s;
    SHIP_LOCAL_MAT[6]  = (2 * (y * z + x * w)) * s;
    SHIP_LOCAL_MAT[7]  = 0;

    SHIP_LOCAL_MAT[8]  = (2 * (x * z + y * w)) * s;
    SHIP_LOCAL_MAT[9]  = (2 * (y * z - x * w)) * s;
    SHIP_LOCAL_MAT[10] = (1 - 2 * (x * x + y * y)) * s;
    SHIP_LOCAL_MAT[11] = 0;

    SHIP_LOCAL_MAT[12] = px;
    SHIP_LOCAL_MAT[13] = py;
    SHIP_LOCAL_MAT[14] = pz;
    SHIP_LOCAL_MAT[15] = 1;

    multiplyInto(parent, SHIP_LOCAL_MAT, SHIP_MV_MAT);
    addInstance(GALAXY_MODEL, SHIP_MV_MAT, engineParams || (typeof engines !== "undefined" ? engines : null));
    if (isPlayer && typeof setNavLight === "function") {
      const lx = NAV_LIGHT_MODEL_OFFSET[0], ly = NAV_LIGHT_MODEL_OFFSET[1], lz = NAV_LIGHT_MODEL_OFFSET[2];
      const m = SHIP_MV_MAT;
      setNavLight(
        m[0] * lx + m[4] * ly + m[8] * lz + m[12],
        m[1] * lx + m[5] * ly + m[9] * lz + m[13],
        m[2] * lx + m[6] * ly + m[10] * lz + m[14]
      );
    }
  } else if (typeof drawShip === "function") {
    const frame = multiply(parent, multiply(translate(...pos), matrixFromQuat(quat)));
    const s = ORBIT.shipScale;
    const modelView = multiply(frame, scale(s, s, s));
    drawShip(modelView);
  }
}

// Draw all entities in the world (player plus any AI/companion ships)
function drawEntities(parent, t, playerShip) {
  const playerEngines = typeof engines !== "undefined" ? engines : null;
  drawShipAt(parent, playerShip, playerEngines, true);

  if (typeof world !== "undefined" && world.entities && world.entities.length > 1) {
    for (let i = 0; i < world.entities.length; i++) {
      if (typeof scene !== "undefined" && typeof MAX_INSTANCES !== "undefined" && scene.instCount >= MAX_INSTANCES) break;
      const e = world.entities[i];
      if (e === world.player) continue;
      const pose = e.rail ? e : (e.pose || e);
      if (!e.engines) {
        e.engines = {
          impulse: e.throttle ? e.throttle * 1.5 : 0.8,
          coils: 0.6,
          bussard: 0.8,
          scroll: 0
        };
      }
      if (e.warp) {
        if (e.warp.state === "on") e.engines.coils = 2.0;
        else if (e.warp.state === "charge") e.engines.coils = 0.6 + (e.warp.tau / FLIGHT.warpCharge) * 1.0;
        else e.engines.coils = 0.6;
      }
      e.engines.impulse = (e.throttle ?? 0.5) * 1.5;
      e.engines.scroll = (0.15 * t) % 2;
      drawShipAt(parent, pose, e.engines, false);
    }
  }
}
