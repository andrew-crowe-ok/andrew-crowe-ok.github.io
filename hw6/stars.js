// Star field as point sprites: the whole sky in one draw call, as an
// alternative to the star texture on the sky sphere (scene.js picks between
// them). Stars are real positions on a sphere of `radius`, so there is no
// equirectangular squeeze at the poles, every star stays crisp whatever the
// resolution, and each one can twinkle on its own phase.
//
// This needs its own program: the scene's shader has no point path, and point
// sprites are shaded from gl_PointCoord rather than from a texture coordinate.

const STAR_VERTEX_SHADER = `#version 300 es
in vec3 aPosition;   // position on the sky sphere
in vec3 aColor;      // color, already scaled by the star's brightness
in vec2 aParams;     // x = size in pixels, y = twinkle phase

uniform mat4 uMVP;
uniform float uTime;
uniform float uPixelScale;  // device pixels per CSS pixel

out vec3 vColor;

void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  // Each star breathes on its own phase, the faint ones more than the bright
  float twinkle = 0.78 + 0.22 * sin(uTime * 1.7 + aParams.y);
  vColor = aColor * twinkle;
  gl_PointSize = aParams.x * uPixelScale;
}
`;

const STAR_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec3 vColor;
out vec4 fragColor;

void main() {
  // Round sprite with a soft edge, so the stars do not look like little squares
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.35, 1.0, d);
  if (a <= 0.0) discard;
  fragColor = vec4(vColor * a, 1.0);
}
`;

// createProgram and the main program come from main.js; draw() restores
// `restoreProgram` so the caller's state is untouched.
function createStarPoints(gl, createProgram, { count = 3000, radius = 45, seed = 53, restoreProgram = null } = {}) {
  const program = createProgram(STAR_VERTEX_SHADER, STAR_FRAGMENT_SHADER);
  const uMVP = gl.getUniformLocation(program, "uMVP");
  const uTime = gl.getUniformLocation(program, "uTime");
  const uPixelScale = gl.getUniformLocation(program, "uPixelScale");

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const params = new Float32Array(count * 2);

  let state = (Math.imul(seed, 2654435761) ^ 0x9e3779b9) >>> 0;
  const rand = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;

  for (let i = 0; i < count; i++) {
    // Uniform on the sphere: the polar angle comes from acos so the stars do
    // not bunch up at the poles. A third of them crowd into a galactic band
    // around the equator, matching the texture version.
    const phi = 2 * Math.PI * rand();
    let cosTheta = 1 - 2 * rand();
    if (rand() < 0.33) cosTheta = (rand() + rand() + rand() - 1.5) * 0.35;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    positions.set([radius * sinTheta * Math.cos(phi), radius * cosTheta,
                   radius * sinTheta * Math.sin(phi)], i * 3);

    const mag = Math.pow(rand(), 3);          // a few bright ones, many faint
    const temp = rand();                      // blue-white through to orange
    const level = 0.45 + 0.55 * mag;
    colors.set([level * (0.80 + 0.30 * temp),
                level * (0.88 + 0.08 * Math.abs(temp - 0.5)),
                level * (1.10 - 0.35 * temp)], i * 3);
    params.set([1.1 + 2.3 * mag, rand() * 6.283], i * 2);
  }

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const [name, data, size] of [["aPosition", positions, 3], ["aColor", colors, 3], ["aParams", params, 2]]) {
    const location = gl.getAttribLocation(program, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(location);
  }
  gl.bindVertexArray(null);

  return {
    count,
    // mvp: projection * the frame the sky is drawn in; time: seconds
    draw(mvp, time) {
      gl.useProgram(program);
      gl.uniformMatrix4fv(uMVP, false, mvp);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uPixelScale, window.devicePixelRatio || 1);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, count);
      if (restoreProgram) gl.useProgram(restoreProgram);
    }
  };
}
