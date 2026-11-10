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

// Planet: a fine sphere wearing the antelope photo, bump-mapped from its luminance
function drawPlanet(parent, t) {
  const r = PLANET.radius;
  const modelView = multiply(parent, multiply(rotateY(PLANET.spin * t), scale(r, r, r)));
  if (typeof addInstance === "function" && typeof PLANET_MODEL !== "undefined" && PLANET_MODEL) {
    addInstance(PLANET_MODEL, modelView);
  } else if (typeof drawPrimitive === "function") {
    drawPrimitive(planetMesh, planetTexture, BUMP_MAPPING, modelView, PLANET_MATERIAL);
  }
}

// The moon's frame at scene time t, and where that puts its center
const moonFrame = t => multiply(rotateX(MOON.tilt),
  multiply(rotateY(MOON.phase + MOON.speed * t), translate(MOON.orbit, 0, 0)));
const moonCenter = t => transformPoint(moonFrame(t), [0, 0, 0]);

// Moon: one glass sphere, no texture -- what it shows is what's behind it
function drawMoon(parent, t) {
  const r = MOON.radius;
  const modelView = multiply(parent, multiply(moonFrame(t), scale(r, r, r)));
  if (typeof addInstance === "function" && typeof MOON_MODEL !== "undefined" && MOON_MODEL) {
    addInstance(MOON_MODEL, modelView);
  } else if (typeof drawPrimitive === "function") {
    drawPrimitive(sphereMesh, null, BUMP_MAPPING, modelView, MOON_MATERIAL);
  }
}

// Level 1: place the ship where the world has it. Its attitude is a
// quaternion, so the frame is translate(pos) * rotation with no axis singled
// out: pitch, yaw and roll all arrive the same way.
function drawShipAt(parent, { pos, quat }, engineParams = null, isPlayer = false) {
  const frame = multiply(parent, multiply(translate(...pos), matrixFromQuat(quat)));
  const s = ORBIT.shipScale;
  const modelView = multiply(frame, scale(s, s, s));
  if (typeof addInstance === "function" && typeof GALAXY_MODEL !== "undefined" && GALAXY_MODEL) {
    addInstance(GALAXY_MODEL, modelView, engineParams || (typeof engines !== "undefined" ? engines : null));
    if (isPlayer && typeof setNavLight === "function") {
      setNavLight(transformPoint(multiply(modelView, translate(...vsub([0, 0, 0], SHIP_CENTER))), NAV_LIGHT.pos));
    }
  } else if (typeof drawShip === "function") {
    drawShip(modelView);
  }
}

// Draw all entities in the world (player plus any AI/companion ships)
function drawEntities(parent, t, playerShip) {
  const playerEngines = typeof engines !== "undefined" ? engines : null;
  drawShipAt(parent, playerShip, playerEngines, true);

  if (typeof world !== "undefined" && world.entities && world.entities.length > 1) {
    for (let i = 0; i < world.entities.length; i++) {
      const e = world.entities[i];
      if (e === world.player) continue;
      const pose = e.pose ?? (e.rail ? e.rail(t) : { pos: e.pos, quat: e.quat });
      const eng = e.engines ?? {
        impulse: e.throttle ? e.throttle * 1.5 : 0.8,
        coils: 0.6,
        bussard: 0.8,
        scroll: (0.15 * t) % 2
      };
      drawShipAt(parent, pose, eng, false);
    }
  }
}
