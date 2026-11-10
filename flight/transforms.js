function multiplyInto(a, b, r) {
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + i] * b[j * 4 + k];
      r[j * 4 + i] = sum;
    }
  return r;
}

function multiply(a, b) {
  return multiplyInto(a, b, new Float32Array(16));
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

// The inverse of an affine matrix (a linear part A, then a translation t).
// The rows of A's inverse are the cross products of its columns over its
// determinant, and the translation undoes as -A^-1 t. The ray tracer needs it
// for every part, which may be scaled unevenly, so the transpose won't do.
function invertAffine(m) {
  const c0 = [m[0], m[1], m[2]], c1 = [m[4], m[5], m[6]], c2 = [m[8], m[9], m[10]];
  const t = [m[12], m[13], m[14]];
  const det = vdot(c0, vcross(c1, c2));
  const rows = [vcross(c1, c2), vcross(c2, c0), vcross(c0, c1)].map(r => vmul(r, 1 / det));
  const out = new Float32Array(16);
  rows.forEach((r, i) => {
    out[i] = r[0]; out[4 + i] = r[1]; out[8 + i] = r[2];
    out[12 + i] = -vdot(r, t);
  });
  out[15] = 1;
  return out;
}

// Writes the 3 rows of an affine matrix's inverse directly into `out` at index `at`,
// avoiding intermediate array and Float32Array allocations in the render loop.
function invertAffineRows(m, out, at) {
  const x01 = m[5] * m[10] - m[6] * m[9];
  const y01 = m[6] * m[8]  - m[4] * m[10];
  const z01 = m[4] * m[9]  - m[5] * m[8];
  const det = m[0] * x01 + m[1] * y01 + m[2] * z01;
  const invDet = 1 / det;

  const r0_0 = x01 * invDet, r0_1 = y01 * invDet, r0_2 = z01 * invDet;
  const t0 = -(r0_0 * m[12] + r0_1 * m[13] + r0_2 * m[14]);

  const x02 = m[9] * m[2]  - m[10] * m[1];
  const y02 = m[10] * m[0] - m[8] * m[2];
  const z02 = m[8] * m[1]  - m[9] * m[0];
  const r1_0 = x02 * invDet, r1_1 = y02 * invDet, r1_2 = z02 * invDet;
  const t1 = -(r1_0 * m[12] + r1_1 * m[13] + r1_2 * m[14]);

  const x03 = m[1] * m[6] - m[2] * m[5];
  const y03 = m[2] * m[4] - m[0] * m[6];
  const z03 = m[0] * m[5] - m[1] * m[4];
  const r2_0 = x03 * invDet, r2_1 = y03 * invDet, r2_2 = z03 * invDet;
  const t2 = -(r2_0 * m[12] + r2_1 * m[13] + r2_2 * m[14]);

  out[at]      = r0_0; out[at + 1]  = r0_1; out[at + 2]  = r0_2; out[at + 3]  = t0;
  out[at + 4]  = r1_0; out[at + 5]  = r1_1; out[at + 6]  = r1_2; out[at + 7]  = t1;
  out[at + 8]  = r2_0; out[at + 9]  = r2_1; out[at + 10] = r2_2; out[at + 11] = t2;
}

// Writes an affine matrix's inverse directly into out (Float32Array(16)),
// avoiding array and object allocations in the render loop.
function invertAffineMat(m, out) {
  const x01 = m[5] * m[10] - m[6] * m[9];
  const y01 = m[6] * m[8]  - m[4] * m[10];
  const z01 = m[4] * m[9]  - m[5] * m[8];
  const det = m[0] * x01 + m[1] * y01 + m[2] * z01;
  const invDet = 1 / det;

  const r0_0 = x01 * invDet, r0_1 = y01 * invDet, r0_2 = z01 * invDet;
  const t0 = -(r0_0 * m[12] + r0_1 * m[13] + r0_2 * m[14]);

  const x02 = m[9] * m[2]  - m[10] * m[1];
  const y02 = m[10] * m[0] - m[8] * m[2];
  const z02 = m[8] * m[1]  - m[9] * m[0];
  const r1_0 = x02 * invDet, r1_1 = y02 * invDet, r1_2 = z02 * invDet;
  const t1 = -(r1_0 * m[12] + r1_1 * m[13] + r1_2 * m[14]);

  const x03 = m[1] * m[6] - m[2] * m[5];
  const y03 = m[2] * m[4] - m[0] * m[6];
  const z03 = m[0] * m[5] - m[1] * m[4];
  const r2_0 = x03 * invDet, r2_1 = y03 * invDet, r2_2 = z03 * invDet;
  const t2 = -(r2_0 * m[12] + r2_1 * m[13] + r2_2 * m[14]);

  out[0] = r0_0; out[1] = r1_0; out[2] = r2_0; out[3] = 0;
  out[4] = r0_1; out[5] = r1_1; out[6] = r2_1; out[7] = 0;
  out[8] = r0_2; out[9] = r1_2; out[10] = r2_2; out[11] = 0;
  out[12] = t0;  out[13] = t1;  out[14] = t2;  out[15] = 1;
  return out;
}

// Vectors as plain arrays
const vadd = (a, b) => a.map((v, i) => v + b[i]);
const vsub = (a, b) => a.map((v, i) => v - b[i]);
const vmul = (a, k) => a.map(v => v * k);
const vdot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
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

// ---------------------------------------------------------------------------
// Quaternions as rotations, [x, y, z, w]: what a flying ship's attitude is
// kept in (world.js). quatMul(a, b) is "b, then a" on a vector, like the
// matrices; so a ship turning about its OWN axes multiplies on the right.
// ---------------------------------------------------------------------------
const quatMul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz
];
const quatConj = ([x, y, z, w]) => [-x, -y, -z, w];   // the inverse, at unit length
function quatNormalize(q) {
  const len = Math.hypot(...q);
  return q.map(v => v / len);
}
// The rotation by |v| radians about v: what an angular velocity turns
// through in one step. Small angles fall back to the series' first term.
function quatFromRotVec([x, y, z]) {
  const a = Math.hypot(x, y, z);
  const s = a < 1e-9 ? 0.5 : Math.sin(a / 2) / a;
  return [x * s, y * s, z * s, Math.cos(a / 2)];
}
// q turns v: v + 2w (u x v) + 2 u x (u x v), u being q's vector part
function quatRotate(q, v) {
  const u = [q[0], q[1], q[2]];
  const c = vcross(u, v), cc = vcross(u, c);
  return v.map((x, i) => x + 2 * (q[3] * c[i] + cc[i]));
}
