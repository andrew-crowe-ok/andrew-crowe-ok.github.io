// 4x4 matrix helpers. Matrices are column-major Float32Arrays, the layout
// WebGL's uniformMatrix4fv expects (element [col * 4 + row]).

function multiply(a, b) {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + i] * b[j * 4 + k];
      r[j * 4 + i] = sum;
    }
  return r;
}

// compose(A, B, C) = A * B * C: C is applied to a point first
const compose = (...ms) => ms.reduce(multiply);

function translate(x, y, z) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function scale(x, y, z) {
  return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
}

function rotateX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function rotateY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

function rotateZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

// View matrix for a camera at `eye` looking at `target`
function lookAt(eye, target, up) {
  const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const f = norm(target.map((v, i) => v - eye[i]));   // forward
  const s = norm(cross(f, up));                        // right
  const u = cross(s, f);                               // true up
  return new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1]);
}

// Perspective projection with an off-center view window (OpenGL's glFrustum):
// l, r, b, t are the window's edges on the near plane
function frustum(l, r, b, t, near, far) {
  return new Float32Array([2 * near / (r - l), 0, 0, 0, 0, 2 * near / (t - b), 0, 0,
    (r + l) / (r - l), (t + b) / (t - b), -(far + near) / (far - near), -1,
    0, 0, -2 * far * near / (far - near), 0]);
}
