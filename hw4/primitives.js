// Six-faced geometric shape (Cuboid / Box) with distinct face colors
function createCuboid(width = 2.0, height = width, depth = width) {
  let w = width, h = height, d = depth;
  if (Array.isArray(width)) {
    [w, h, d] = width;
  }
  const x = w / 2.0, y = h / 2.0, z = d / 2.0;

  const corners = [
    [-x, -y, -z], // 0
     [x, -y, -z], // 1
     [x,  y, -z], // 2
    [-x,  y, -z], // 3
    [-x, -y,  z], // 4
     [x, -y,  z], // 5
     [x,  y,  z], // 6
    [-x,  y,  z]  // 7
  ];

  const faces = [
    [4, 5, 6, 7], // Front (+Z)
    [1, 0, 3, 2], // Back (-Z)
    [3, 2, 6, 7], // Top (+Y)
    [0, 1, 5, 4], // Bottom (-Y)
    [1, 5, 6, 2], // Right (+X)
    [0, 4, 7, 3]  // Left (-X)
  ];

  const faceColors = [
    [0.72, 0.74, 0.78], // Front: light silver
    [0.28, 0.30, 0.34], // Back: deep slate
    [0.90, 0.90, 0.90], // Top: crisp off-white
    [0.18, 0.20, 0.22], // Bottom: dark graphite
    [0.55, 0.58, 0.62], // Right: mid steel gray
    [0.38, 0.40, 0.44]  // Left: pewter gray
  ];

  const positions = [];
  const colors = [];
  const indices = [];

  faces.forEach((face, faceIndex) => {
    const [r, g, b] = faceColors[faceIndex];

    face.forEach(cornerIndex => {
      positions.push(...corners[cornerIndex]);
      colors.push(r, g, b);
    });

    const offset = faceIndex * 4;
    indices.push(
      offset, offset + 1, offset + 2,
      offset, offset + 2, offset + 3
    );
  });

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint16Array(indices)
  };
}

const createBox = createCuboid;
const createCube = (size = 1.0) => createCuboid(size * 2.0, size * 2.0, size * 2.0);

const defaultCuboid = createCuboid(2.0, 2.0, 2.0);
const cuboidPos = defaultCuboid.positions;
const cuboidColors = defaultCuboid.colors;
const cuboidIndices = defaultCuboid.indices;

// Aliases for compatibility
const boxPos = cuboidPos;
const boxColors = cuboidColors;
const boxIndices = cuboidIndices;
const cubePos = cuboidPos;
const cubeColors = cuboidColors;
const cubeIndices = cuboidIndices;

function createTrapezoidalPrism(width = 2.0, height = 2.0, depth = 2.0, topRatio = 0.5) {
  let w = width, h = height, d = depth, r = topRatio;
  if (Array.isArray(width)) {
    [w, h, d, r = 0.5] = width;
  }
  const hw = w / 2.0, hh = h / 2.0, hd = d / 2.0;
  const topX = -hw + w * r;

  const v = [
    [-hw, -hh,  hd], [ hw, -hh,  hd], [ topX,  hh,  hd], [-hw,  hh,  hd], // Front (Z = hd)
    [-hw, -hh, -hd], [ hw, -hh, -hd], [ topX,  hh, -hd], [-hw,  hh, -hd]  // Back (Z = -hd)
  ];

  const faces = [
    [0, 1, 2, 3], // Front
    [5, 4, 7, 6], // Back
    [3, 2, 6, 7], // Top
    [4, 5, 1, 0], // Bottom
    [1, 5, 6, 2], // Right
    [4, 0, 3, 7]  // Left
  ];

  // Muted architectural slate palette
  const faceColors = [
    [0.68, 0.70, 0.74], // Front: cool silver
    [0.30, 0.32, 0.36], // Back: dark slate
    [0.85, 0.85, 0.88], // Top: pale steel
    [0.18, 0.20, 0.22], // Bottom: dark graphite
    [0.50, 0.53, 0.58], // Right: mid slate
    [0.40, 0.42, 0.46]  // Left: pewter
  ];

  const positions = [];
  const colors = [];
  const indices = [];

  faces.forEach((face, faceIndex) => {
    const [r, g, b] = faceColors[faceIndex];

    face.forEach(cornerIndex => {
      positions.push(...v[cornerIndex]);
      colors.push(r, g, b);
    });

    const offset = faceIndex * 4;
    indices.push(
      offset, offset + 1, offset + 2,
      offset, offset + 2, offset + 3
    );
  });

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint16Array(indices)
  };
}

const prismData = createTrapezoidalPrism();

const prismPos = prismData.positions;
const prismCol = prismData.colors;
const prismInd = prismData.indices;

function createSphere(radius = 1.0, latBands = 20, longBands = 20) {
  let rx = 1.0, ry = 1.0, rz = 1.0;
  if (Array.isArray(radius)) {
    [rx, ry, rz] = radius;
  } else if (typeof radius === 'number') {
    rx = ry = rz = radius;
  }

  const positions = [];
  const colors = [];
  const indices = [];

  // Generate vertices and colors
  for (let latNumber = 0; latNumber <= latBands; latNumber++) {
    const theta = latNumber * Math.PI / latBands;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    for (let longNumber = 0; longNumber <= longBands; longNumber++) {
      const phi = longNumber * 2 * Math.PI / longBands;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      const x = cosPhi * sinTheta;
      const y = cosTheta;
      const z = sinPhi * sinTheta;

      positions.push(rx * x, ry * y, rz * z);
      
      // Muted tonal shading from graphite to silver
      const lum = 0.25 + 0.60 * ((y + 1) / 2);
      colors.push(lum, lum, lum);
    }
  }

  // Generate indices for the triangles
  for (let latNumber = 0; latNumber < latBands; latNumber++) {
    for (let longNumber = 0; longNumber < longBands; longNumber++) {
      const first = (latNumber * (longBands + 1)) + longNumber;
      const second = first + longBands + 1;

      // Two triangles per grid square
      indices.push(first, second, first + 1);
      indices.push(second, second + 1, first + 1);
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint16Array(indices)
  };
}

function createHemisphere(type = 'top', radius = 1.0, latBands = 20, longBands = 20) {
  let rx = 1.0, ry = 1.0, rz = 1.0;
  if (Array.isArray(radius)) {
    [rx, ry, rz] = radius;
  } else if (typeof radius === 'number') {
    rx = ry = rz = radius;
  }

  const positions = [];
  const colors = [];
  const indices = [];

  const numLatRings = Math.floor(latBands / 2);

  // Generate outer shell vertices
  for (let latNumber = 0; latNumber <= numLatRings; latNumber++) {
    const theta = latNumber * Math.PI / latBands;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    for (let longNumber = 0; longNumber <= longBands; longNumber++) {
      const phi = longNumber * 2 * Math.PI / longBands;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      const bx = cosPhi * sinTheta;
      const by = cosTheta;
      const bz = sinPhi * sinTheta;

      let x, y, z;
      if (type === 'right') {
        x = by * rx;
        y = -bx * ry;
        z = bz * rz;
      } else if (type === 'left') {
        x = -by * rx;
        y = bx * ry;
        z = bz * rz;
      } else if (type === 'bottom') {
        x = bx * rx;
        y = -by * ry;
        z = bz * rz;
      } else { // 'top'
        x = bx * rx;
        y = by * ry;
        z = bz * rz;
      }

      positions.push(x, y, z);
      if (x < 0) {
        colors.push(0.15, 0.15, 0.15); // Visible dark charcoal "black"
      } else {
        colors.push(1.0, 1.0, 1.0);    // Crisp white
      }
    }
  }

  // Generate shell triangle indices
  for (let latNumber = 0; latNumber < numLatRings; latNumber++) {
    for (let longNumber = 0; longNumber < longBands; longNumber++) {
      const first = (latNumber * (longBands + 1)) + longNumber;
      const second = first + longBands + 1;

      indices.push(first, second, first + 1);
      indices.push(second, second + 1, first + 1);
    }
  }

  // Generate flat circular cap at the cut face
  const centerIndex = positions.length / 3;
  positions.push(0, 0, 0);
  colors.push(0.55, 0.55, 0.55);

  const capStart = positions.length / 3;
  for (let longNumber = 0; longNumber <= longBands; longNumber++) {
    const phi = longNumber * 2 * Math.PI / longBands;
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    let cx, cy, cz;
    if (type === 'right' || type === 'left') {
      cx = 0;
      cy = ry * c;
      cz = rz * s;
    } else {
      cx = rx * c;
      cy = 0;
      cz = rz * s;
    }

    positions.push(cx, cy, cz);
    if (cx < 0) {
      colors.push(0.15, 0.15, 0.15);
    } else {
      colors.push(1.0, 1.0, 1.0);
    }
  }

  for (let longNumber = 0; longNumber < longBands; longNumber++) {
    const p1 = capStart + longNumber;
    const p2 = capStart + longNumber + 1;
    indices.push(centerIndex, p1, p2);
    indices.push(centerIndex, p2, p1);
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint16Array(indices)
  };
}

function createCuttingPlane(width = 2.8, height = width) {
  let w = width, h = height;
  if (Array.isArray(width)) {
    [w, h = w] = width;
  }
  const hw = w / 2.0, hh = h / 2.0;

  // Vertical blade in the YZ plane (x = 0)
  const positions = new Float32Array([
    0, -hh, -hw,
    0,  hh, -hw,
    0,  hh,  hw,
    0, -hh,  hw
  ]);

  // Muted steel / silver blade
  const colors = new Float32Array([
    0.72, 0.76, 0.80,
    0.72, 0.76, 0.80,
    0.72, 0.76, 0.80,
    0.72, 0.76, 0.80
  ]);

  // Double-sided quad
  const indices = new Uint16Array([
    0, 1, 2,  0, 2, 3,
    2, 1, 0,  3, 2, 0
  ]);

  return {
    positions,
    colors,
    indices
  };
}


