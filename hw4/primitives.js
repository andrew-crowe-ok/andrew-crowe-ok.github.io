// cube
const positions = new Float32Array([
  -1, -1, -1,  // 0
   1, -1, -1,  // 1
   1,  1, -1,  // 2
  -1,  1, -1,  // 3
  -1, -1,  1,  // 4
   1, -1,  1,  // 5
   1,  1,  1,  // 6
  -1,  1,  1   // 7
]);

const colors = new Float32Array([
  // Warm sunset fire palette (coral, orange, gold, magenta)
  1.0, 0.15, 0.25,  // 0: bright coral red
  1.0, 0.55, 0.0,   // 1: electric orange
  1.0, 0.85, 0.1,   // 2: vivid gold
  0.9, 0.1,  0.55,  // 3: hot rose
  1.0, 0.25, 0.7,   // 4: neon pink
  1.0, 0.45, 0.05,  // 5: sunset amber
  0.85, 0.1, 0.95,  // 6: electric violet
  1.0, 0.75, 0.2    // 7: warm yellow
]);


const indices = new Uint16Array([
  // Front
  4, 5, 6,   4, 6, 7,
  // Back
  1, 0, 3,   1, 3, 2,
  // Top
  3, 7, 6,   3, 6, 2,
  // Bottom
  0, 1, 5,   0, 5, 4,
  // Right
  1, 2, 6,   1, 6, 5,
  // Left
  0, 4, 7,   0, 7, 3,
]);

function createTrapezoidalPrism() {
  const v = [
    [-1, -1,  1], [ 1, -1,  1], [ 0,  1,  1], [-1,  1,  1], // Front (Z = 1)
    [-1, -1, -1], [ 1, -1, -1], [ 0,  1, -1], [-1,  1, -1]  // Back (Z = -1)
  ];

  const faces = [
    [0, 1, 2, 3], // Front
    [5, 4, 7, 6], // Back
    [3, 2, 6, 7], // Top
    [4, 5, 1, 0], // Bottom
    [1, 5, 6, 2], // Right
    [4, 0, 3, 7]  // Left
  ];

  // Cool cyan / emerald / deep blue cyberpunk palette
  const faceColors = [
    [0.0,  0.95, 0.85], // Front: bright turquoise / cyan
    [0.1,  0.4,  0.95], // Back: royal blue
    [0.2,  1.0,  0.35], // Top: electric neon lime
    [0.05, 0.65, 0.9],  // Bottom: deep oceanic teal
    [0.0,  0.9,  1.0],  // Right: vibrant sky cyan
    [0.4,  0.2,  0.95]  // Left: electric indigo / violet
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

function createSphere(radius = 1, latBands = 20, longBands = 20) {
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

      positions.push(radius * x, radius * y, radius * z);
      
      // Map spatial coordinates [-1, 1] to RGB values [0, 1]
      colors.push((x + 1) / 2, (y + 1) / 2, (z + 1) / 2);
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

function createHemisphere(type = 'right', radius = 1, latBands = 20, longBands = 20) {
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
        // Rotated -90 deg around Z: (x, y, z) -> (y, -x, z), x >= 0
        x = by * radius;
        y = -bx * radius;
        z = bz * radius;
      } else if (type === 'left') {
        // Rotated +90 deg around Z: (x, y, z) -> (-y, x, z), x <= 0
        x = -by * radius;
        y = bx * radius;
        z = bz * radius;
      } else if (type === 'bottom') {
        x = bx * radius;
        y = -by * radius;
        z = bz * radius;
      } else { // 'top'
        x = bx * radius;
        y = by * radius;
        z = bz * radius;
      }

      positions.push(x, y, z);
      colors.push((x + 1) / 2, (y + 1) / 2, (z + 1) / 2);
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
  // Interior sliced color: warm amber/orange
  colors.push(1.0, 0.55, 0.15);

  const capStart = positions.length / 3;
  for (let longNumber = 0; longNumber <= longBands; longNumber++) {
    const phi = longNumber * 2 * Math.PI / longBands;
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    let cx, cy, cz;
    if (type === 'right' || type === 'left') {
      // Cut is at x = 0 in YZ plane
      cx = 0;
      cy = radius * c;
      cz = radius * s;
    } else {
      // Cut is at y = 0 in XZ plane
      cx = radius * c;
      cy = 0;
      cz = radius * s;
    }

    positions.push(cx, cy, cz);
    colors.push(0.95, 0.45, 0.1);
  }

  for (let longNumber = 0; longNumber < longBands; longNumber++) {
    const p1 = capStart + longNumber;
    const p2 = capStart + longNumber + 1;
    // Two-sided cap triangles so they are visible from all angles
    indices.push(centerIndex, p1, p2);
    indices.push(centerIndex, p2, p1);
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint16Array(indices)
  };
}

function createCuttingPlane(size = 1.4) {
  // Vertical blade in the YZ plane (x = 0)
  const positions = new Float32Array([
    0, -size, -size,
    0,  size, -size,
    0,  size,  size,
    0, -size,  size
  ]);

  // Glowing energetic cyan blade
  const colors = new Float32Array([
    0.35, 0.9, 1.0,
    0.35, 0.9, 1.0,
    0.35, 0.9, 1.0,
    0.35, 0.9, 1.0
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


