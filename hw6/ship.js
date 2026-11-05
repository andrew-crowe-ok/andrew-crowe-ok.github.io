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
}

// Level 2: saucer section, a squashed sphere
function drawSaucer(parent) {
  drawPrimitive(sphereMesh, brickTexture, BUMP_MAPPING, multiply(parent, scale(1.6, 0.18, 1.6)));
}
