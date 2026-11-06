// Starship built with the HW 4 functional hierarchy: each drawX(parent) derives
// its frame from the parent's, draws its own shape with a scaled copy (so the
// scale never reaches the children), then hands the unscaled frame down.
// Axes: +z = forward, +y = up. Uses gl, uniforms and meshes from main.js.

function drawPrimitive(mesh, texture, mapping, modelView) {
  gl.uniformMatrix4fv(uModelView, false, modelView);
  gl.uniform1i(uMapping, mapping);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
}

// Level 1: whole ship. Rotating the parent frame moves every part.
function drawShip(parent) {
  drawSaucer(multiply(parent, translate(0, 0.6, 0.9)));
  drawEngineering(multiply(parent, translate(0, -0.2, -0.8)));
}

// Level 2: engineering hull. The cylinder mesh runs along y, so rotateX(90°)
// lays it along +z: radius 0.35, half-length 1.4 (spans z = -1.4..1.4 locally).
const HULL_RADIUS = 0.35, HULL_HALF_LENGTH = 1.4;
function drawEngineering(parent) {
  const alongZ = multiply(parent, rotateX(Math.PI / 2));
  drawPrimitive(cylinderMesh, normalTexture, NORMAL_MAPPING,
    multiply(alongZ, scale(HULL_RADIUS, HULL_HALF_LENGTH, HULL_RADIUS)));

  // Rounded nose: a sphere the hull's radius, centered on the front cap
  drawPrimitive(sphereMesh, normalTexture, NORMAL_MAPPING,
    multiply(parent, multiply(translate(0, 0, HULL_HALF_LENGTH), scale(HULL_RADIUS, HULL_RADIUS, HULL_RADIUS))));

  // Neck midpoint sits above and ahead of the hull center
  drawNeck(multiply(parent, translate(0, 0.5, 0.5)));
}

// Level 3: neck, a thin fin from the hull's top up to the saucer's underside.
// Its ends are (0, -0.25, -0.3) and (0, 0.25, 0.3) here, so tilt the box's
// y axis toward +z by atan2(0.6, 0.5).
function drawNeck(parent) {
  const tilted = multiply(parent, rotateX(Math.atan2(0.6, 0.5)));
  drawPrimitive(cubeMesh, brickTexture, BUMP_MAPPING, multiply(tilted, scale(0.08, 0.45, 0.25)));
}

// Level 2: saucer section, a squashed sphere
function drawSaucer(parent) {
  drawPrimitive(sphereMesh, brickTexture, BUMP_MAPPING, multiply(parent, scale(1.6, 0.18, 1.6)));

  // The child gets the unscaled saucer frame, so it isn't squashed too
  drawBridge(multiply(parent, translate(0, 0.14, 0)));
  drawRim(parent);  // same center as the saucer, so no offset
}

// Level 3: rim, a thin torus hugging the saucer's edge (saucer radius 1.6).
// Uniform scale keeps the tube round; tube radius = 0.04 * 1.58 ≈ 0.06.
function drawRim(parent) {
  drawPrimitive(torusMesh, brickTexture, BUMP_MAPPING, multiply(parent, scale(1.58, 1.58, 1.58)));
}

// Level 3: bridge dome, half buried in the saucer's top (saucer top is y = 0.18)
function drawBridge(parent) {
  drawPrimitive(sphereMesh, normalTexture, NORMAL_MAPPING, multiply(parent, scale(0.45, 0.14, 0.45)));
}
