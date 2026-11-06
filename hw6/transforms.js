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

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

// The same for a direction, which the translation doesn't move
function transformVector(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z
  ];
}

// A direction through the transpose of m's rotation, which for a rigid m is
// its inverse: dots v with each of m's first three columns
function untransformVector(m, [x, y, z]) {
  return [0, 1, 2].map(i => m[i * 4] * x + m[i * 4 + 1] * y + m[i * 4 + 2] * z);
}

// Vectors as plain arrays
const vadd = (a, b) => a.map((v, i) => v + b[i]);
const vsub = (a, b) => a.map((v, i) => v - b[i]);
const vmul = (a, k) => a.map(v => v * k);
const vdot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);

// ---------------------------------------------------------------------------
// Blending two camera positions
//
// A view matrix built from translates and rotates is rigid: a rotation A, then
// a translation. Lerping two of them entry by entry shears and shrinks the
// rotation, so a camera move is blended through its parts instead -- the
// rotation as a quaternion (slerp), the eye point on its own.
// ---------------------------------------------------------------------------

// The rotation, as a quaternion, and the point the camera sits at: view maps
// the eye to the origin, so A * eye + t = 0 and eye = -A^T t.
function viewParts(m) {
  return { q: quatFromMatrix(m), eye: vmul(untransformVector(m, [m[12], m[13], m[14]]), -1) };
}

// The view matrix those parts describe: rotate, then bring the eye to the origin
function viewFromParts(q, eye) {
  return multiply(matrixFromQuat(q), translate(-eye[0], -eye[1], -eye[2]));
}

// Shepperd's method: take the quaternion component the matrix states most
// strongly (the largest of the trace and the three diagonal elements), so the
// square root is never taken of something near zero.
function quatFromMatrix(m) {
  const a = (i, j) => m[j * 4 + i];                 // row i, column j
  const trace = a(0, 0) + a(1, 1) + a(2, 2);
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(a(2, 1) - a(1, 2)) / s, (a(0, 2) - a(2, 0)) / s, (a(1, 0) - a(0, 1)) / s, s / 4];
  }
  const i = a(0, 0) > a(1, 1) ? (a(0, 0) > a(2, 2) ? 0 : 2) : (a(1, 1) > a(2, 2) ? 1 : 2);
  const j = (i + 1) % 3, k = (i + 2) % 3;
  const s = Math.sqrt(a(i, i) - a(j, j) - a(k, k) + 1) * 2;
  const q = [0, 0, 0, (a(k, j) - a(j, k)) / s];
  q[i] = s / 4;
  q[j] = (a(j, i) + a(i, j)) / s;
  q[k] = (a(k, i) + a(i, k)) / s;
  return q;
}

function matrixFromQuat([x, y, z, w]) {
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1
  ]);
}

// Constant-rate rotation from a to b. q and -q are the same rotation, so the
// sign is picked to turn the short way round; near-parallel quaternions get a
// plain lerp, where sin(theta) would divide out to nothing.
function slerp(a, b, u) {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const q = cos < 0 ? b.map(v => -v) : b;
  cos = Math.abs(cos);
  let wa = 1 - u, wb = u;
  if (cos < 0.9995) {
    const theta = Math.acos(cos), sin = Math.sin(theta);
    wa = Math.sin(wa * theta) / sin;
    wb = Math.sin(wb * theta) / sin;
  }
  const r = a.map((v, i) => v * wa + q[i] * wb);
  const len = Math.hypot(...r);
  return r.map(v => v / len);
}
