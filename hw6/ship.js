// Starship built with the HW 4 functional hierarchy: each drawX(parent) derives
// its frame from the parent's, draws its own shape with a scaled copy (so the
// scale never reaches the children), then hands the unscaled frame down.
// Axes: +z = forward, +y = up. Uses gl, uniforms, meshes and textures from main.js.

// Layout in ship space. Parts are placed from these, so proportions live in one
// place; children get offsets relative to their parent's position.
const SAUCER = { pos: [0, 0.6, 1.2], radius: 1.45, halfThick: 0.16 };
const HULL = { pos: [0, -0.25, -0.9], radius: 0.32, halfLength: 1.3 };
// Right nacelle (+x); the left mirrors x. Raised to the saucer's top and kept
// behind its rim, so neither the Bussard cap nor the pylon cuts into the saucer.
const NACELLE = { pos: [1.0, 0.75, -1.65], radius: 0.16, halfLength: 1.3 };
// Struts as [bottom, top] endpoints, each end buried inside the part it joins
const NECK = [[0, -0.1, -0.3], [0, 0.6, 0.15]];
const PYLON = [[0.18, 0.0, -1.6], [1.0, 0.63, -1.6]];
// Ship spans z -3.25..2.71 and y -0.57..0.91; shift so the root frame is its middle
const SHIP_CENTER = [0, 0.17, -0.27];

// Painted plating: a touch more ambient than the planet so the panel lines stay
// readable on the night side, and a tight specular for the clearcoat.
// The saucer's bumpScale is negative because the shader takes relief from
// 1 - luminance: its panel lines are dark, so flipping the sign makes them
// grooves between raised plates instead of ridges.
const SAUCER_MATERIAL = { ka: 0.22, kd: 0.85, ks: 0.45, shininess: 48, bumpScale: -5.0, atmosphere: [0, 0, 0] };
// bumpScale is unused in mode 3: the relief comes from the normal map
const HULL_MATERIAL = { ka: 0.2, kd: 0.85, ks: 0.6, shininess: 64, bumpScale: 1.0, atmosphere: [0, 0, 0] };

const sub = (a, b) => a.map((v, i) => v - b[i]);
const mirrorX = ([x, y, z], side) => [side * x, y, z];
// Midpoint, length and direction of a strut
function strut([a, b]) {
  const d = sub(b, a);
  return { mid: a.map((v, i) => v + d[i] / 2), length: Math.hypot(...d), d };
}

// material: Phong coefficients etc. (see DEFAULT_MATERIAL in main.js)
// normalMap: only for TEXTURED_NORMAL_MAPPING, where it is sampled on unit 1
function drawPrimitive(mesh, texture, mapping, modelView, material = DEFAULT_MATERIAL, normalMap = null) {
  setMaterial(material);
  gl.uniformMatrix4fv(uModelView, false, modelView);
  gl.uniform1i(uMapping, mapping);
  if (normalMap) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, normalMap);
  }
  gl.activeTexture(gl.TEXTURE0);  // left active, so the video texture lands here
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
}

// Level 1: whole ship. Rotating the parent frame moves every part.
function drawShip(parent) {
  const ship = multiply(parent, translate(...sub([0, 0, 0], SHIP_CENTER)));
  drawSaucer(multiply(ship, translate(...SAUCER.pos)));
  drawEngineering(multiply(ship, translate(...HULL.pos)));
}

// Level 2: saucer section, a squashed sphere
function drawSaucer(parent) {
  const { radius: r, halfThick: h } = SAUCER;
  drawPrimitive(sphereMesh, saucerTexture, BUMP_MAPPING, multiply(parent, scale(r, h, r)), SAUCER_MATERIAL);

  // Children get the unscaled saucer frame, so they aren't squashed too
  drawBridge(multiply(parent, translate(0, 0.75 * h, 0)));
  drawRim(parent);  // same center as the saucer, so no offset
}

// Level 3: bridge dome, half buried in the saucer's top
function drawBridge(parent) {
  drawPrimitive(sphereMesh, normalTexture, NORMAL_MAPPING, multiply(parent, scale(0.42, 0.13, 0.42)));
}

// Level 3: rim, a thin torus hugging the saucer's edge. Uniform scale keeps the
// tube round; tube radius = 0.04 * scale ≈ 0.057.
function drawRim(parent) {
  const s = SAUCER.radius - 0.02;
  drawPrimitive(torusMesh, saucerTexture, BUMP_MAPPING, multiply(parent, scale(s, s, s)), SAUCER_MATERIAL);
}

// Level 2: engineering hull. The cylinder mesh runs along y, so rotateX(90°)
// lays it along +z.
function drawEngineering(parent) {
  const { radius: r, halfLength: l } = HULL;
  drawPrimitive(cylinderMesh, hullTexture, TEXTURED_NORMAL_MAPPING,
    multiply(parent, multiply(rotateX(Math.PI / 2), scale(r, l, r))), HULL_MATERIAL, hullNormalMap);

  // Rounded nose: a sphere the hull's radius, centered on the front cap
  drawPrimitive(sphereMesh, hullTexture, TEXTURED_NORMAL_MAPPING,
    multiply(parent, multiply(translate(0, 0, l), scale(r, r, r))), HULL_MATERIAL, hullNormalMap);

  const neck = strut(NECK);
  drawNeck(multiply(parent, translate(...sub(neck.mid, HULL.pos))), neck);

  // Dish base just behind the nose tip; any further back and the sphere pokes
  // through the shallow cone's face
  drawDeflector(multiply(parent, translate(0, 0, l + 0.92 * r)));

  // side = +1 (right, +x) or -1 (left)
  for (const side of [1, -1]) {
    const pylon = strut(PYLON.map(p => mirrorX(p, side)));
    drawPylon(multiply(parent, translate(...sub(pylon.mid, HULL.pos))), pylon, side);
  }
}

// Level 3: neck, a thin fin from inside the hull up into the saucer. rotateX tips
// the box's long y axis toward +z to follow the strut's (dy, dz) direction.
function drawNeck(parent, { length, d }) {
  const tilted = multiply(parent, rotateX(Math.atan2(d[2], d[1])));
  drawPrimitive(cubeMesh, hullTexture, TEXTURED_NORMAL_MAPPING,
    multiply(tilted, scale(0.035, length / 2, 0.075)), HULL_MATERIAL, hullNormalMap);
}

// Level 3: deflector dish, a wide shallow cone with a thin antenna spike, both
// pointing forward. parent's origin is the dish's base; rotateX(90°) turns the
// cone's +y apex toward +z, and each cone is shifted up by its half-height so
// its base (local y = -1) lands on that origin.
function drawDeflector(parent) {
  const forward = multiply(parent, rotateX(Math.PI / 2));
  const copper = getTexture("textures/mars2.jpg");
  drawPrimitive(coneMesh, copper, BUMP_MAPPING,
    multiply(forward, multiply(translate(0, 0.06, 0), scale(0.28, 0.06, 0.28))));
  drawPrimitive(coneMesh, copper, BUMP_MAPPING,
    multiply(forward, multiply(translate(0, 0.2, 0), scale(0.035, 0.2, 0.035))));
}

// Level 3: pylon, a thin blade from the hull's top out to the nacelle's underside.
// rotateZ(a) sends the box's y axis to (-sin a, cos a), so a = atan2(-dx, dy)
// lines it up with the strut; the mirrored strut gives the left pylon its tilt.
function drawPylon(parent, { mid, length, d }, side) {
  const tilted = multiply(parent, rotateZ(Math.atan2(-d[0], d[1])));
  drawPrimitive(cubeMesh, hullTexture, TEXTURED_NORMAL_MAPPING,
    multiply(tilted, scale(0.03, length / 2, 0.12)), HULL_MATERIAL, hullNormalMap);

  drawNacelle(multiply(parent, translate(...sub(mirrorX(NACELLE.pos, side), mid))));
}

// Level 4: nacelle, a long cylinder along z with a Bussard collector cap in front
// and a tail cone behind
function drawNacelle(parent) {
  const { radius: r, halfLength: l } = NACELLE;
  drawPrimitive(cylinderMesh, nacelleTexture, TEXTURED_NORMAL_MAPPING,
    multiply(parent, multiply(rotateX(Math.PI / 2), scale(r, l, r))), HULL_MATERIAL, nacelleNormalMap);

  drawBussard(multiply(parent, translate(0, 0, l)));

  // Tail cone: rotateX(-90°) points the apex backward (-z); shift by the half-height
  drawPrimitive(coneMesh, nacelleTexture, TEXTURED_NORMAL_MAPPING,
    multiply(parent, multiply(translate(0, 0, -l - 0.15),
      multiply(rotateX(-Math.PI / 2), scale(r, 0.15, r)))), HULL_MATERIAL, nacelleNormalMap);
}

// Level 5: Bussard collector, a sphere stretched forward and lit by the animated
// plasma video. rotateX(90°) turns the sphere's +y pole forward, so the video's
// top row (v = 1) glows at the tip and u wraps around the nacelle's axis.
function drawBussard(parent) {
  const r = NACELLE.radius;
  drawPrimitive(sphereMesh, plasma.texture, EMISSIVE,
    multiply(parent, multiply(rotateX(Math.PI / 2), scale(r, 0.24, r))));
}
