// Starship built with the HW 4 functional hierarchy: each drawX(parent) derives
// its frame from the parent's, draws its own shape with a scaled copy (so the
// scale never reaches the children), then hands the unscaled frame down.
// Axes: +z = forward, +y = up. Uses drawPrimitive, meshes and textures from main.js,
// which hands every part to the ray tracer instead of drawing it.
//
// The layout follows the Galaxy-class design (Andrew Probert's 1987 design
// patent drawings, D307,923): a wide elliptical saucer, a short broad neck, an
// engineering hull tucked under the saucer's aft edge with a blue deflector,
// and two flat nacelles hung low and wide on pylons that sweep out and up from
// the back of the hull. Every part is a scaled and rotated sphere, cylinder,
// box or torus, the unit shapes the ray tracer intersects.
//
// The parts are boxed in four groups -- the saucer, the engineering hull, and
// each pylon with its nacelle -- so the ray tracer only tests the parts of a
// group whose box the ray passes through (beginGroup, main.js).

// Layout in ship space, with the saucer's midplane at y = 0. Parts are placed
// from these, so proportions live in one place.
const SAUCER = {
  pos: [0, 0, 1.16],
  base: [2.15, 0.075, 1.8],     // thin lens out to the rim: wider than long
  top: { y: -0.03, radii: [1.75, 0.25, 1.47] },     // raised upper decks
  bottom: { y: 0.03, radii: [1.55, 0.21, 1.3] },   // lower decks
};
// Engineering hull: an elliptical cylinder with a blunt nose cap (the deflector
// housing) and a long tapering tail. Its caps share its cross-section, so they
// meet the cylinder without a seam; each cap's hidden half has to stay inside
// the cylinder, so neither reaches further than its full length (2 * halfLength).
const HULL = { pos: [0, -0.62, -1.15], radii: [0.58, 0.31], halfLength: 0.65, nose: 0.2, tail: 1.15 };
// Right nacelle (+x); the left mirrors x. Flatter than it is wide.
const NACELLE = { pos: [1.17, -0.38, -1.85], radii: [0.21, 0.15], halfLength: 1.05, bussard: 0.34, tail: 0.22 };
// Pylon as a polyline from inside the hull, out and slightly down to an elbow,
// then up into the nacelle's underside (right side; the left mirrors x).
const PYLON = [[0.35, -0.75, -1.85], [0.95, -0.86, -2.05], [1.17, -0.42, -2.2]];
// Ship spans y -0.93..0.35 (hull keel to bridge) and z -3.12..3.01 (nacelle
// tails to the saucer's rim); shift so the root frame is its middle
const SHIP_CENTER = [0, -0.29, -0.055];
// Half the size of a box about that middle that holds the whole ship -- the
// rim reaches x 2.22 -- for clicking on it (camera.js)
const SHIP_HALF_EXTENT = [2.22, 0.65, 3.07];

// Painted plating: a touch more ambient than the planet so the panel lines stay
// readable on the night side, a tight specular for the clearcoat, and a little
// mirror (kr) so the polished hull picks up the planet and the moon. glow is
// how brightly the skin's emission -- lit windows, navigation lights -- shines.
// The skins are normal mapped, so bumpScale is unused: the relief comes from
// the maps themselves (textures.js).
const SAUCER_MATERIAL = { ka: 0.22, kd: 0.85, ks: 0.35, shininess: 48, bumpScale: 1.0, atmosphere: [0, 0, 0],
  kr: 0.18, glow: 1.1 };
const HULL_MATERIAL = { ka: 0.2, kd: 0.85, ks: 0.35, shininess: 64, bumpScale: 1.0, atmosphere: [0, 0, 0],
  kr: 0.15, glow: 1.1 };
// The bridge dome is a clear glass canopy: mostly transmitted (kt), with a
// faint blue-green tint from absorbing more red per unit length, and a hard
// highlight. Its index of refraction comes from the slider (main.js).
const DOME_MATERIAL = { ka: 0.05, kd: 0.2, ks: 0.9, shininess: 160, bumpScale: 0, atmosphere: [0, 0, 0],
  kt: 0.88, absorb: [2.0, 0.8, 0.3] };

// Nav light: a blue floodlight in a small glowing bulb under the saucer's
// leading edge, lighting the neck, hull and deflector from above and in front,
// so they throw shadows on each other. The light sits just below the bulb, so
// the bulb's own shell doesn't hide it.
const NAV_LIGHT = { pos: [0, -0.17, 2.4], bulb: [0, -0.1, 2.4], radius: 0.05 };

const mirrorX = ([x, y, z], side) => [side * x, y, z];
const vnorm = v => vmul(v, 1 / Math.hypot(...v));

// Rotation taking +y to direction d and keeping +z as close to forward as it
// can, so a part's long axis follows d and its chord stays fore-and-aft
function alongY(d) {
  const Y = vnorm(d);
  const Z = vnorm(vsub([0, 0, 1], vmul(Y, Y[2])));
  const X = vcross(Y, Z);
  return new Float32Array([...X, 0, ...Y, 0, ...Z, 0, 0, 0, 0, 1]);
}

// An ellipsoid with its pole along +z: rotateX(90°) turns the sphere's +y pole
// forward, so u wraps around the z axis and v runs along it, the same way the
// hull cylinder's texture does. The sphere's local z ends up along -y, which is
// why the y radius goes in the third slot.
const podZ = ([rx, ry, rz]) => multiply(rotateX(Math.PI / 2), scale(rx, rz, ry));
// An elliptical cylinder (hullMesh) along z, radii rx and ry, half-length l.
// rotateX(90°) lays the cylinder's y axis along +z, and rotateY(90°) first
// turns its texture seam to the right side, so u = 0 lands where a podZ cap's
// does and u = 0.25 is the top. That turn swaps x and z, hence (ry, l, rx).
const tubeZ = ([rx, ry], l) => multiply(rotateX(Math.PI / 2), multiply(rotateY(Math.PI / 2), scale(ry, l, rx)));

// Level 1: whole ship. Rotating the parent frame moves every part.
function drawShip(parent) {
  const ship = multiply(parent, translate(...vsub([0, 0, 0], SHIP_CENTER)));
  beginGroup(ship);
  drawSaucer(multiply(ship, translate(...SAUCER.pos)));
  drawNavLight(ship);
  endGroup();
  drawEngineering(multiply(ship, translate(...HULL.pos)));
}

// Level 2: the nav light, and the glowing bulb that shows where it is
function drawNavLight(ship) {
  setNavLight(transformPoint(ship, NAV_LIGHT.pos));
  const r = NAV_LIGHT.radius;
  drawPrimitive(sphereMesh, beaconTexture, EMISSIVE,
    multiply(ship, multiply(translate(...NAV_LIGHT.bulb), scale(r, r, r))));
}

// Level 2: saucer section, three stacked squashed spheres -- a thin lens out to
// the rim and two smaller, deeper ones for the upper and lower decks -- so the
// edge stays sharp while the middle swells, as in the side view. The lens goes
// first: rays that hit it cut short the march through the rim's torus.
function drawSaucer(parent) {
  drawPrimitive(saucerMesh, saucerTexture, NORMAL_MAPPING, multiply(parent, scale(...SAUCER.base)),
    SAUCER_MATERIAL, saucerNormalMap);
  for (const { y, radii } of [SAUCER.top, SAUCER.bottom]) {
    drawPrimitive(saucerMesh, deckTexture, NORMAL_MAPPING,
      multiply(parent, multiply(translate(0, y, 0), scale(...radii))), SAUCER_MATERIAL, deckNormalMap);
  }

  // Children get the unscaled saucer frame, so they aren't squashed too
  drawRim(parent);
  drawSuperstructure(parent);
  // Sensor dome on the belly, under the bridge
  drawPrimitive(saucerMesh, deckTexture, NORMAL_MAPPING,
    multiply(parent, multiply(translate(0, -0.17, 0), scale(0.32, 0.07, 0.28))), SAUCER_MATERIAL, deckNormalMap);
}

// Level 3: rim, a thin torus following the saucer's elliptical edge, with two
// rows of windows and the navigation lights around its outer face. Tube
// radius = 0.04 * scale.
function drawRim(parent) {
  const [rx, , rz] = SAUCER.base;
  drawPrimitive(torusMesh, rimTexture, NORMAL_MAPPING,
    multiply(parent, scale(rx - 0.02, 1.0, rz - 0.02)), SAUCER_MATERIAL, rimNormalMap);
}

// Level 3: the raised keyhole on the saucer's top -- a round head around the
// bridge and a flat-ended tail running aft, with the impulse engines across
// its back face
function drawSuperstructure(parent) {
  drawPrimitive(saucerMesh, deckTexture, NORMAL_MAPPING,
    multiply(parent, multiply(translate(0, 0.13, -0.15), scale(0.55, 0.16, 0.5))), SAUCER_MATERIAL, deckNormalMap);

  // Tail: an elliptical cylinder laid along z (rotateX(90°) sends its y axis
  // forward), 0.9 long, so its aft cap is a flat face
  const tail = multiply(parent, translate(0, 0.12, -0.7));
  drawPrimitive(hullMesh, hullTexture, NORMAL_MAPPING,
    multiply(tail, multiply(rotateX(Math.PI / 2), scale(0.3, 0.45, 0.12))), HULL_MATERIAL, hullNormalMap);

  drawBridge(multiply(parent, translate(0, 0.28, -0.15)));
  drawImpulse(multiply(tail, translate(0, 0.05, -0.46)));
}

// Level 4: bridge dome, a glass canopy half sunk into the keyhole's head
function drawBridge(parent) {
  drawPrimitive(sphereMesh, null, BUMP_MAPPING, multiply(parent, scale(0.24, 0.07, 0.2)), DOME_MATERIAL);
}

// Level 4: impulse engines, a red glowing slab across the keyhole's aft face.
// The box's back face maps u across and v up, so the glow peaks along the middle.
function drawImpulse(parent) {
  drawPrimitive(cubeMesh, impulseGlow, EMISSIVE, multiply(parent, scale(0.22, 0.035, 0.015)));
}

// Level 2: engineering hull, an elliptical cylinder along z (tubeZ), boxed as
// one group; each pylon and its nacelle get a group of their own
function drawEngineering(parent) {
  const { radii: [rx, ry], halfLength: l, nose, tail } = HULL;
  beginGroup(parent);
  drawPrimitive(hullMesh, hullTexture, NORMAL_MAPPING, multiply(parent, tubeZ([rx, ry], l)),
    HULL_MATERIAL, hullNormalMap);

  // Blunt nose and long tapering tail, each centered on a cylinder end
  drawPrimitive(sphereMesh, hullTexture, NORMAL_MAPPING,
    multiply(parent, multiply(translate(0, 0, l), podZ([rx, ry, nose]))), HULL_MATERIAL, hullNormalMap);
  drawPrimitive(sphereMesh, hullTexture, NORMAL_MAPPING,
    multiply(parent, multiply(translate(0, 0, -l), podZ([rx, ry, tail]))), HULL_MATERIAL, hullNormalMap);

  drawNeck(multiply(parent, translate(0, 0.42, 0.7)));
  drawDeflector(multiply(parent, translate(0, -0.05, l)));
  endGroup();

  // side = +1 (right, +x) or -1 (left)
  for (const side of [1, -1]) {
    beginGroup(parent);
    drawPylon(multiply(parent, translate(...vsub([0, 0, 0], HULL.pos))), PYLON.map(p => mirrorX(p, side)), side);
    endGroup();
  }
}

// Level 3: neck, a broad fairing from the hull's back up under the saucer,
// its front tipped up (rotateX of a negative angle raises +z)
function drawNeck(parent) {
  drawPrimitive(sphereMesh, hullTexture, NORMAL_MAPPING,
    multiply(parent, multiply(rotateX(-0.32), podZ([0.32, 0.13, 0.8]))), HULL_MATERIAL, hullNormalMap);
}

// Level 3: deflector, a housing that juts out of the nose with a glowing dish
// set in its face. parent's origin is the nose cap's center.
function drawDeflector(parent) {
  // Housing: a short elliptical cylinder along z, front face at z = 0.2
  drawPrimitive(hullMesh, hullTexture, NORMAL_MAPPING,
    multiply(parent, multiply(translate(0, 0, 0.1), multiply(rotateX(Math.PI / 2), scale(0.48, 0.1, 0.26)))),
    HULL_MATERIAL, hullNormalMap);
  // Dish: a shallow dome whose pole faces forward, so the glow texture's
  // bright v = 1 sits at its center
  drawPrimitive(sphereMesh, deflectorGlow, EMISSIVE,
    multiply(parent, multiply(translate(0, 0, 0.19), podZ([0.42, 0.21, 0.07]))));
}

// Level 3: pylon, two blades along the polyline with a rounded joint at the
// elbow. Each blade is a cylinder squashed to a wing section -- thin across,
// broad fore and aft -- stood along its segment (alongY) and run a little past
// both ends, so its flat caps sink into the part it joins. They wear the
// nacelles' skin, which has no windows. parent is the ship frame's origin,
// where the polyline lives.
function drawPylon(parent, points, side) {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], d = vsub(points[i + 1], a);
    const mid = vadd(a, vmul(d, 0.5)), half = Math.hypot(...d) / 2;
    const chord = i === 0 ? 0.24 : 0.18;   // broad at the root, narrower out by the nacelle
    drawPrimitive(cylinderMesh, nacelleTexture, NORMAL_MAPPING,
      multiply(parent, multiply(translate(...mid), multiply(alongY(d), scale(0.04, half + 0.06, chord)))),
      HULL_MATERIAL, nacelleNormalMap);
  }
  drawPrimitive(sphereMesh, nacelleTexture, NORMAL_MAPPING,
    multiply(parent, multiply(translate(...points[1]), scale(0.06, 0.06, 0.2))), HULL_MATERIAL, nacelleNormalMap);

  drawNacelle(multiply(parent, translate(...mirrorX(NACELLE.pos, side))));
}

// Level 4: nacelle, a flat elliptical cylinder along z with a Bussard
// collector in front, a rounded tail, and a glowing warp grille down each side
function drawNacelle(parent) {
  const { radii: [rx, ry], halfLength: l, tail } = NACELLE;
  // Body: tubeZ, so the skin's spine runs along the top and its trim down the
  // sides behind the grilles
  drawPrimitive(hullMesh, nacelleTexture, NORMAL_MAPPING, multiply(parent, tubeZ([rx, ry], l)),
    HULL_MATERIAL, nacelleNormalMap);
  drawPrimitive(sphereMesh, nacelleTexture, NORMAL_MAPPING,
    multiply(parent, multiply(translate(0, 0, -l), podZ([rx, ry, tail]))), HULL_MATERIAL, nacelleNormalMap);

  // Grilles: one thin glowing slab straight through the nacelle, standing just
  // proud of both sides; the body hides the rest of it. A box's side faces
  // map u along z and v up, so the slats cross the nacelle.
  drawPrimitive(cubeMesh, grilleGlow, EMISSIVE,
    multiply(parent, multiply(translate(0, 0.01, -0.08), scale(rx + 0.006, 0.07, l * 0.82))));

  drawBussard(multiply(parent, translate(0, 0, l)));
}

// Level 5: Bussard collector, a long dome on the nacelle's nose lit by the
// animated plasma video. Its pole faces forward (podZ), so the video's top row
// (v = 1) glows at the tip and u wraps around the nacelle's axis.
function drawBussard(parent) {
  const { radii: [rx, ry], bussard } = NACELLE;
  drawPrimitive(sphereMesh, plasma.texture, EMISSIVE, multiply(parent, podZ([rx * 0.97, ry * 0.97, bussard])));
}
