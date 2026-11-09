// Star field as point sprites: the whole sky in one draw call. Stars are real
// positions on a sphere of `radius`, so every star stays crisp whatever the
// resolution, and each one can twinkle on its own phase.
//
// This needs its own program: the scene's shader has no point path, and point
// sprites are shaded from gl_PointCoord rather than from a texture coordinate.

// The lens (camera.js) is shared with the scene's shader, so the stars bow out
// with everything else once the fisheye comes in. The sky wraps all the way
// around the eye, so most of these points sit behind it -- the one place in the
// scene where the fisheye's view past its own sides actually shows.
//
// At speed each star stretches into a short streak along the way it is moving
// on screen: the vertex shader projects the star where it will be STREAK.shutter
// seconds on and takes the difference, so stars dead ahead or behind barely
// stretch and the ones sweeping past the sides stretch most. The sprite grows
// to hold the streak and the fragment shader draws a capsule inside it.
const STREAK = {
  shutter: 0.45,   // s of motion each streak covers
  max: 40,         // CSS pixels, the longest a streak gets
  dim: 0.1         // how much a star dims per pixel of streak, relative to its size
};
const STAR_VERTEX_SHADER = `#version 300 es
in vec3 aPosition;   // position on the sky sphere
in vec3 aColor;      // color, already scaled by the star's brightness
in vec2 aParams;     // x = size in pixels, y = twinkle phase

uniform mat4 uProjection;
uniform mat4 uModelView;
uniform float uTime;
uniform float uPixelScale;  // device pixels per CSS pixel
uniform vec3 uStreak;       // the stars' velocity past the eye, eye space, units/s
uniform float uShutter;     // s
uniform float uMaxStreak;   // device pixels
uniform vec2 uViewport;     // device pixels
uniform float uStreakDim;
${LENS_GLSL}
out vec3 vColor;
out vec2 vHalfStreak;   // half the streak, in pixels with y up
out float vRadius;      // the star's own radius, in pixels
out float vSpriteSize;  // the sprite's side, in pixels

void main() {
  vec4 p = uModelView * vec4(aPosition, 1.0);
  gl_Position = project(uProjection, p);
  float size = aParams.x * uPixelScale;

  vec2 streak = vec2(0.0);
  vec4 q = project(uProjection, p + vec4(uStreak * uShutter, 0.0));
  if (dot(uStreak, uStreak) > 0.0 && gl_Position.w > 1e-3 && q.w > 1e-3) {
    streak = (q.xy / q.w - gl_Position.xy / gl_Position.w) * 0.5 * uViewport;
    float len = length(streak);
    if (len > uMaxStreak) streak *= uMaxStreak / len;
  }
  float len = length(streak);

  // Each star breathes on its own phase, the faint ones more than the bright,
  // and dims a little as its light is spread along the streak
  float twinkle = 0.78 + 0.22 * sin(uTime * 1.7 + aParams.y);
  vColor = aColor * twinkle * size / (size + uStreakDim * len);
  vHalfStreak = 0.5 * streak;
  vRadius = 0.5 * size;
  vSpriteSize = size + len;
  gl_PointSize = vSpriteSize;
}
`;

const STAR_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec3 vColor;
in vec2 vHalfStreak;
in float vRadius;
in float vSpriteSize;
out vec4 fragColor;

void main() {
  // This fragment in pixels from the sprite's center, y up like the streak
  // (gl_PointCoord runs down)
  vec2 q = (gl_PointCoord - 0.5) * vec2(1.0, -1.0) * vSpriteSize;
  // Distance to the streak's center line, in star radii: a round sprite when
  // the streak is zero, a capsule when it is not. The soft edge keeps the
  // stars from looking like little squares.
  float k = dot(vHalfStreak, vHalfStreak);
  float h = k > 0.0 ? clamp(dot(q, vHalfStreak) / k, -1.0, 1.0) : 0.0;
  float d = length(q - vHalfStreak * h) / vRadius;
  float a = 1.0 - smoothstep(0.35, 1.0, d);
  if (a <= 0.0) discard;
  fragColor = vec4(vColor * a, 1.0);
}
`;

// Uses gl and createProgram from main.js. draw() leaves the star program in use.
function createStarPoints({ radius, count = 3000, seed = 53 }) {
  const program = createProgram(STAR_VERTEX_SHADER, STAR_FRAGMENT_SHADER);
  const uProjection = gl.getUniformLocation(program, "uProjection");
  const uModelView = gl.getUniformLocation(program, "uModelView");
  const setLens = lensUniforms(program);
  const uTime = gl.getUniformLocation(program, "uTime");
  const uPixelScale = gl.getUniformLocation(program, "uPixelScale");
  const uStreak = gl.getUniformLocation(program, "uStreak");
  const uShutter = gl.getUniformLocation(program, "uShutter");
  const uMaxStreak = gl.getUniformLocation(program, "uMaxStreak");
  const uViewport = gl.getUniformLocation(program, "uViewport");
  const uStreakDim = gl.getUniformLocation(program, "uStreakDim");
  // The sprite holds the whole streak, so the streak can be no longer than the
  // largest point the GPU draws, less room for the biggest star
  const maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const params = new Float32Array(count * 2);

  let state = (Math.imul(seed, 2654435761) ^ 0x9e3779b9) >>> 0;
  const rand = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;

  for (let i = 0; i < count; i++) {
    // Uniform on the sphere: the polar angle comes from acos so the stars do
    // not bunch up at the poles. A third of them crowd into a galactic band
    // around the equator.
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
    // modelView: the frame the sky is drawn in; time: seconds; streak: the
    // stars' velocity past the eye, in eye space
    draw(projection, modelView, time, streak = [0, 0, 0]) {
      gl.useProgram(program);
      gl.uniformMatrix4fv(uProjection, false, projection);
      gl.uniformMatrix4fv(uModelView, false, modelView);
      setLens();
      gl.uniform1f(uTime, time);
      const pixelScale = window.devicePixelRatio || 1;
      gl.uniform1f(uPixelScale, pixelScale);
      gl.uniform3fv(uStreak, streak);
      gl.uniform1f(uShutter, STREAK.shutter);
      gl.uniform1f(uMaxStreak, Math.min(STREAK.max * pixelScale, maxPointSize - 4 * pixelScale));
      gl.uniform1f(uStreakDim, STREAK.dim);
      gl.uniform2f(uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, count);
    }
  };
}
