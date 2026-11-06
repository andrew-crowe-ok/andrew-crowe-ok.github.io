function createCube() {
  const positions = new Float32Array([
    -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1,   // front
     1, -1, -1,  -1, -1, -1,  -1,  1, -1,   1,  1, -1,   // back
    -1,  1,  1,   1,  1,  1,   1,  1, -1,  -1,  1, -1,   // top
    -1, -1, -1,   1, -1, -1,   1, -1,  1,  -1, -1,  1,   // bottom
     1, -1,  1,   1, -1, -1,   1,  1, -1,   1,  1,  1,   // right
    -1, -1, -1,  -1, -1,  1,  -1,  1,  1,  -1,  1, -1    // left
  ]);
  const faceNormals = [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0]];
  const normals = new Float32Array(faceNormals.flatMap(n => [...n, ...n, ...n, ...n]));

  // Tangent; bitangent = cross(N, T)
  const faceTangents = [[1, 0, 0], [-1, 0, 0], [1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]];
  const tangents = new Float32Array(faceTangents.flatMap(t => [...t, ...t, ...t, ...t]));

  const texCoords = new Float32Array(faceNormals.flatMap(() => [0, 0, 1, 0, 1, 1, 0, 1]));

  const indices = new Uint16Array([
     0,  1,  2,   0,  2,  3,   // front
     4,  5,  6,   4,  6,  7,   // back
     8,  9, 10,   8, 10, 11,   // top
    12, 13, 14,  12, 14, 15,   // bottom
    16, 17, 18,  16, 18, 19,   // right
    20, 21, 22,  20, 22, 23    // left
  ]);
  return { positions, normals, tangents, texCoords, indices };
}


function createCylinder(segments = 64, uRepeat = 3) {
  const positions = [], normals = [], tangents = [], texCoords = [], indices = [];

  // Side: theta grows with u, so T points along the circle and B = cross(N, T) points up
  for (let i = 0; i <= segments; i++) {
    const u = i / segments, theta = 2 * Math.PI * u;
    const s = Math.sin(theta), c = Math.cos(theta);
    for (const y of [-1, 1]) {
      positions.push(s, y, c);
      normals.push(s, 0, c);
      tangents.push(c, 0, -s);
      texCoords.push(u * uRepeat, (y + 1) / 2);
    }
  }
  for (let i = 0; i < segments; i++) {
    const k = 2 * i;
    indices.push(k, k + 2, k + 3, k, k + 3, k + 1);
  }

  // Caps: planar mapping of x, z into the texture, T = +x on both
  for (const y of [1, -1]) {
    const center = positions.length / 3;
    positions.push(0, y, 0);
    normals.push(0, y, 0);
    tangents.push(1, 0, 0);
    texCoords.push(0.5, 0.5);
    for (let i = 0; i <= segments; i++) {
      const theta = 2 * Math.PI * i / segments;
      const s = Math.sin(theta), c = Math.cos(theta);
      positions.push(s, y, c);
      normals.push(0, y, 0);
      tangents.push(1, 0, 0);
      texCoords.push(0.5 + 0.5 * s, 0.5 - 0.5 * y * c);  // keeps cross(N, T) along +v
    }
    for (let i = 0; i < segments; i++) {
      const a = center + 1 + i, b = a + 1;
      if (y > 0) indices.push(center, a, b);
      else indices.push(center, b, a);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    tangents: new Float32Array(tangents),
    texCoords: new Float32Array(texCoords),
    indices: new Uint16Array(indices)
  };
}


// Per-triangle tangents from the UV gradient, accumulated and orthogonalized
// against the normal. Used by meshes whose tangents aren't trivially analytic.
function computeTangents(positions, normals, texCoords, indices) {
  const acc = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    const e1 = [0, 0, 0], e2 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      e1[k] = positions[b * 3 + k] - positions[a * 3 + k];
      e2[k] = positions[c * 3 + k] - positions[a * 3 + k];
    }
    const du1 = texCoords[b * 2] - texCoords[a * 2];
    const dv1 = texCoords[b * 2 + 1] - texCoords[a * 2 + 1];
    const du2 = texCoords[c * 2] - texCoords[a * 2];
    const dv2 = texCoords[c * 2 + 1] - texCoords[a * 2 + 1];

    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;  // degenerate UVs contribute nothing
    const r = 1 / det;

    for (const v of [a, b, c])
      for (let k = 0; k < 3; k++)
        acc[v * 3 + k] += (e1[k] * dv2 - e2[k] * dv1) * r;
  }

  const tangents = new Float32Array(positions.length);
  for (let v = 0; v < positions.length / 3; v++) {
    const n = [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]];
    let t = [acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]];

    // Gram-Schmidt: T must be perpendicular to N for the TBN frame
    const d = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
    t = [t[0] - d * n[0], t[1] - d * n[1], t[2] - d * n[2]];

    let len = Math.hypot(...t);
    if (len < 1e-8) {
      // No usable UV gradient: pick any axis not parallel to N
      const fallback = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const f = fallback[0] * n[0] + fallback[1] * n[1] + fallback[2] * n[2];
      t = [fallback[0] - f * n[0], fallback[1] - f * n[1], fallback[2] - f * n[2]];
      len = Math.hypot(...t);
    }
    for (let k = 0; k < 3; k++) tangents[v * 3 + k] = t[k] / len;
  }
  return tangents;
}


function createSphere(latBands = 24, longBands = 24) {
  const positions = [], normals = [], tangents = [], texCoords = [], indices = [];

  for (let lat = 0; lat <= latBands; lat++) {
    const v = 1 - lat / latBands;
    const theta = (lat / latBands) * Math.PI;
    const sinTheta = Math.sin(theta), cosTheta = Math.cos(theta);

    for (let lon = 0; lon <= longBands; lon++) {
      const u = 1 - lon / longBands;
      const phi = (lon / longBands) * Math.PI * 2;
      const s = Math.sin(phi), c = Math.cos(phi);
      positions.push(c * sinTheta, cosTheta, s * sinTheta);
      normals.push(c * sinTheta, cosTheta, s * sinTheta);
      // u decreases with phi, so T = -d(pos)/d(phi) normalized
      tangents.push(s, 0, -c);
      texCoords.push(u, v);
    }
  }

  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < longBands; lon++) {
      const first = lat * (longBands + 1) + lon, second = first + longBands + 1;
      indices.push(first, first + 1, second, second, first + 1, second + 1);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    tangents: new Float32Array(tangents),
    texCoords: new Float32Array(texCoords),
    indices: new Uint16Array(indices)
  };
}


function createPyramid() {
  const positions = new Float32Array([
     0, -1,  0,   1,  1,  1,  -1,  1,  1,   // front
     0, -1,  0,   1,  1, -1,   1,  1,  1,   // right
     0, -1,  0,  -1,  1, -1,   1,  1, -1,   // back
     0, -1,  0,  -1,  1,  1,  -1,  1, -1,   // left
    -1,  1,  1,   1,  1,  1,   1,  1, -1,  -1,  1, -1  // top base
  ]);
  const ny = -1 / Math.hypot(1, 2);
  const nxz = 2 / Math.hypot(1, 2);
  const sideNormals = [[0, ny, nxz], [nxz, ny, 0], [0, ny, -nxz], [-nxz, ny, 0]];
  const topNormal = [0, 1, 0];
  const normals = new Float32Array([
    ...sideNormals.flatMap(n => [...n, ...n, ...n]),
    ...topNormal, ...topNormal, ...topNormal, ...topNormal
  ]);
  const texCoords = new Float32Array([
    0.5, 0.0,  1.0, 1.0,  0.0, 1.0,
    0.5, 0.0,  1.0, 1.0,  0.0, 1.0,
    0.5, 0.0,  1.0, 1.0,  0.0, 1.0,
    0.5, 0.0,  1.0, 1.0,  0.0, 1.0,
    0.0, 0.0,  1.0, 0.0,  1.0, 1.0,  0.0, 1.0
  ]);
  const indices = new Uint16Array([
     0,  1,  2,   3,  4,  5,   6,  7,  8,   9, 10, 11,
    12, 13, 14,  12, 14, 15
  ]);
  const tangents = computeTangents(positions, normals, texCoords, indices);
  return { positions, normals, tangents, texCoords, indices };
}


// Torus in the xz plane: ring radius 1, tube radius tubeRatio (scale it uniformly).
// theta goes around the ring (u), phi around the tube (v), same orientation as the
// cylinder: T = d(pos)/d(theta) along the ring, B = cross(N, T) along the tube.
function createTorus(tubeRatio = 0.25, ringSegments = 64, tubeSegments = 24, uRepeat = 8) {
  const positions = [], normals = [], tangents = [], texCoords = [], indices = [];

  for (let i = 0; i <= ringSegments; i++) {
    const u = i / ringSegments, theta = 2 * Math.PI * u;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let j = 0; j <= tubeSegments; j++) {
      const v = j / tubeSegments, phi = 2 * Math.PI * v;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      const r = 1 + tubeRatio * cp;  // distance from the y axis
      positions.push(r * st, tubeRatio * sp, r * ct);
      normals.push(cp * st, sp, cp * ct);
      tangents.push(ct, 0, -st);
      texCoords.push(u * uRepeat, v);
    }
  }

  // Seam vertices are duplicated (i = ringSegments, j = tubeSegments) so u and v wrap cleanly
  const row = tubeSegments + 1;
  for (let i = 0; i < ringSegments; i++) {
    for (let j = 0; j < tubeSegments; j++) {
      const a = i * row + j, b = a + row;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    tangents: new Float32Array(tangents),
    texCoords: new Float32Array(texCoords),
    indices: new Uint16Array(indices)
  };
}
