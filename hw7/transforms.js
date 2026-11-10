function multiply(a, b) {
  const r = new Float32Array(16);
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
  const a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7];
  const a8 = a[8], a9 = a[9], a10 = a[10], a11 = a[11];
  const a12 = a[12], a13 = a[13], a14 = a[14], a15 = a[15];

  const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  const b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7];
  const b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11];
  const b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];

  r[0] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
  r[1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
  r[2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
  r[3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;

  r[4] = a0 * b4 + a4 * b5 + a8 * b6 + a12 * b7;
  r[5] = a1 * b4 + a5 * b5 + a9 * b6 + a13 * b7;
  r[6] = a2 * b4 + a6 * b5 + a10 * b6 + a14 * b7;
  r[7] = a3 * b4 + a7 * b5 + a11 * b6 + a15 * b7;

  r[8] = a0 * b8 + a4 * b9 + a8 * b10 + a12 * b11;
  r[9] = a1 * b8 + a5 * b9 + a9 * b10 + a13 * b11;
  r[10] = a2 * b8 + a6 * b9 + a10 * b10 + a14 * b11;
  r[11] = a3 * b8 + a7 * b9 + a11 * b10 + a15 * b11;

  r[12] = a0 * b12 + a4 * b13 + a8 * b14 + a12 * b15;
  r[13] = a1 * b12 + a5 * b13 + a9 * b14 + a13 * b15;
  r[14] = a2 * b12 + a6 * b13 + a10 * b14 + a14 * b15;
  r[15] = a3 * b12 + a7 * b13 + a11 * b14 + a15 * b15;

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
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[4] * x + m[5] * y + m[6] * z,
    m[8] * x + m[9] * y + m[10] * z
  ];
}

// The inverse of an affine matrix (a linear part A, then a translation t).
// The rows of A's inverse are the cross products of its columns over its
// determinant, and the translation undoes as -A^-1 t.
function invertAffine(m) {
  const m0 = m[0], m1 = m[1], m2 = m[2];
  const m4 = m[4], m5 = m[5], m6 = m[6];
  const m8 = m[8], m9 = m[9], m10 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];

  const r0x = m5 * m10 - m6 * m9;
  const r0y = m6 * m8 - m4 * m10;
  const r0z = m4 * m9 - m5 * m8;

  const det = m0 * r0x + m1 * r0y + m2 * r0z;
  const invDet = 1 / det;

  const r1x = (m9 * m2 - m10 * m1) * invDet;
  const r1y = (m10 * m0 - m8 * m2) * invDet;
  const r1z = (m8 * m1 - m9 * m0) * invDet;

  const r2x = (m1 * m6 - m2 * m5) * invDet;
  const r2y = (m2 * m4 - m0 * m6) * invDet;
  const r2z = (m0 * m5 - m1 * m4) * invDet;

  const r0xInv = r0x * invDet;
  const r0yInv = r0y * invDet;
  const r0zInv = r0z * invDet;

  const out = new Float32Array(16);
  out[0] = r0xInv; out[4] = r0yInv; out[8] = r0zInv;
  out[12] = -(r0xInv * tx + r0yInv * ty + r0zInv * tz);

  out[1] = r1x; out[5] = r1y; out[9] = r1z;
  out[13] = -(r1x * tx + r1y * ty + r1z * tz);

  out[2] = r2x; out[6] = r2y; out[10] = r2z;
  out[14] = -(r2x * tx + r2y * ty + r2z * tz);

  out[15] = 1;
  return out;
}

// Inverts an affine matrix and writes its three rows directly into out at index at
function invertAffineToRows(m, out, at) {
  const m0 = m[0], m1 = m[1], m2 = m[2];
  const m4 = m[4], m5 = m[5], m6 = m[6];
  const m8 = m[8], m9 = m[9], m10 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];

  const r0x = m5 * m10 - m6 * m9;
  const r0y = m6 * m8 - m4 * m10;
  const r0z = m4 * m9 - m5 * m8;

  const det = m0 * r0x + m1 * r0y + m2 * r0z;
  const invDet = 1 / det;

  const r1x = (m9 * m2 - m10 * m1) * invDet;
  const r1y = (m10 * m0 - m8 * m2) * invDet;
  const r1z = (m8 * m1 - m9 * m0) * invDet;

  const r2x = (m1 * m6 - m2 * m5) * invDet;
  const r2y = (m2 * m4 - m0 * m6) * invDet;
  const r2z = (m0 * m5 - m1 * m4) * invDet;

  const r0xInv = r0x * invDet;
  const r0yInv = r0y * invDet;
  const r0zInv = r0z * invDet;

  out[at]     = r0xInv; out[at + 1] = r0yInv; out[at + 2] = r0zInv;
  out[at + 3] = -(r0xInv * tx + r0yInv * ty + r0zInv * tz);

  out[at + 4] = r1x;    out[at + 5] = r1y;    out[at + 6] = r1z;
  out[at + 7] = -(r1x * tx + r1y * ty + r1z * tz);

  out[at + 8] = r2x;    out[at + 9] = r2y;    out[at + 10] = r2z;
  out[at + 11] = -(r2x * tx + r2y * ty + r2z * tz);
}

// Vectors as plain arrays
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vmul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];

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
