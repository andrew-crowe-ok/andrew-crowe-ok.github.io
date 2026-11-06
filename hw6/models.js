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

// Cone along y: base radius 1 at y = -1, apex at y = +1, with a base cap.
// The side is a strip of quads like the cylinder, but the top row collapses to the
// apex. Each column keeps its own apex vertex, so u (and the normal) stay per-column
// instead of all meeting at one smeared point; one triangle per quad is degenerate.
function createCone(segments = 48, uRepeat = 1) {
  const positions = [], normals = [], tangents = [], texCoords = [], indices = [];
  const ny = 1 / Math.sqrt(5), nr = 2 / Math.sqrt(5);  // slant normal for radius 1, height 2

  for (let i = 0; i <= segments; i++) {
    const u = i / segments, theta = 2 * Math.PI * u;
    const s = Math.sin(theta), c = Math.cos(theta);
    for (const y of [-1, 1]) {
      const r = (1 - y) / 2;  // 1 at the base, 0 at the apex
      positions.push(r * s, y, r * c);
      normals.push(nr * s, ny, nr * c);
      tangents.push(c, 0, -s);
      texCoords.push(u * uRepeat, (y + 1) / 2);
    }
  }
  for (let i = 0; i < segments; i++) {
    const k = 2 * i;
    indices.push(k, k + 2, k + 3, k, k + 3, k + 1);
  }

  // Base cap: planar mapping of x, z, facing -y
  const center = positions.length / 3;
  positions.push(0, -1, 0);
  normals.push(0, -1, 0);
  tangents.push(1, 0, 0);
  texCoords.push(0.5, 0.5);
  for (let i = 0; i <= segments; i++) {
    const theta = 2 * Math.PI * i / segments;
    const s = Math.sin(theta), c = Math.cos(theta);
    positions.push(s, -1, c);
    normals.push(0, -1, 0);
    tangents.push(1, 0, 0);
    texCoords.push(0.5 + 0.5 * s, 0.5 + 0.5 * c);
  }
  for (let i = 0; i < segments; i++) indices.push(center, center + 2 + i, center + 1 + i);

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    tangents: new Float32Array(tangents),
    texCoords: new Float32Array(texCoords),
    indices: new Uint16Array(indices)
  };
}
