// Scene above the ship, in the same functional style as ship.js:
//
//   drawSystem
//   ├── drawPlanet        (spins on its own axis)
//   └── drawOrbit         (tilted orbital plane, carries the ship around)
//       └── drawShip      (ship.js)
//
// The planet and the orbit are siblings, so the planet's spin never reaches the ship.

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
  drawPlanet(parent, t);
  drawOrbit(multiply(parent, rotateX(ORBIT.tilt)), t);
}

// Planet: a fine sphere wearing the antelope photo, bump-mapped from its luminance
function drawPlanet(parent, t) {
  const r = PLANET.radius;
  drawPrimitive(planetMesh, getTexture("textures/antelope.jpg"), BUMP_MAPPING,
    multiply(parent, multiply(rotateY(PLANET.spin * t), scale(r, r, r))), PLANET_MATERIAL);
}

// Orbit: rotateY(a) carries the point (R, 0, 0) around the y axis. With a = -speed*t
// the direction of travel is the frame's +z, which is the ship's forward axis, so
// the ship always flies nose-first along its orbit.
function drawOrbit(parent, t) {
  const a = -ORBIT.speed * t;
  const onOrbit = multiply(parent, multiply(rotateY(a), translate(ORBIT.radius, 0, 0)));
  const s = ORBIT.shipScale;  // uniform, so the ship's normals stay correct
  drawShip(multiply(onOrbit, scale(s, s, s)));
}
