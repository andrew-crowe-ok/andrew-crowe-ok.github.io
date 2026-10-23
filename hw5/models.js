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

  const faceUVs = [0, 0,  1, 0,  1, 1,  0, 1];
  const texCoords = new Float32Array(Array(6).fill(faceUVs).flat());

  const indices = new Uint16Array([
     0,  1,  2,   0,  2,  3,   // front
     4,  5,  6,   4,  6,  7,   // back
     8,  9, 10,   8, 10, 11,   // top
    12, 13, 14,  12, 14, 15,   // bottom
    16, 17, 18,  16, 18, 19,   // right
    20, 21, 22,  20, 22, 23    // left
  ]);
  return { positions, normals, texCoords, indices };
}

function createCylinder(segments = 24) {
  const pos = [], nrm = [], tex = [], idx = [];

  // Side
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const a = u * Math.PI * 2;
    const x = Math.cos(a), z = Math.sin(a);
    pos.push(x, -1, z, x, 1, z);
    nrm.push(x, 0, z, x, 0, z);
    tex.push(u, 0, u, 1);
  }
  for (let i = 0; i < segments; i++) {
    const b = i * 2;
    idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
  }

  // Caps
  for (const y of [-1, 1]) {
    const center = pos.length / 3;
    pos.push(0, y, 0);
    nrm.push(0, y, 0);
    tex.push(0.5, 0.5);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const x = Math.cos(a), z = Math.sin(a);
      pos.push(x, y, z);
      nrm.push(0, y, 0);
      tex.push(0.5 + 0.5 * x, 0.5 + 0.5 * z);
    }
    for (let i = 1; i <= segments; i++) {
      if (y > 0) idx.push(center, center + i + 1, center + i);
      else idx.push(center, center + i, center + i + 1);
    }
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    texCoords: new Float32Array(tex),
    indices: new Uint16Array(idx)
  };
}

function createSphere(latBands = 24, longBands = 24) {
  const pos = [], nrm = [], tex = [], idx = [];

  for (let lat = 0; lat <= latBands; lat++) {
    const v = 1 - (lat / latBands);
    const theta = (lat / latBands) * Math.PI;
    const sinTheta = Math.sin(theta), cosTheta = Math.cos(theta);

    for (let lon = 0; lon <= longBands; lon++) {
      const u = 1 - (lon / longBands);
      const phi = (lon / longBands) * Math.PI * 2;
      const x = Math.cos(phi) * sinTheta;
      const y = cosTheta;
      const z = Math.sin(phi) * sinTheta;
      pos.push(x, y, z);
      nrm.push(x, y, z);
      tex.push(u, v);
    }
  }

  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < longBands; lon++) {
      const first = lat * (longBands + 1) + lon;
      const second = first + longBands + 1;
      idx.push(first, first + 1, second, second, first + 1, second + 1);
    }
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    texCoords: new Float32Array(tex),
    indices: new Uint16Array(idx)
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
  return { positions, normals, texCoords, indices };
}