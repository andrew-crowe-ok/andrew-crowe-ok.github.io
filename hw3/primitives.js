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
  1,0,0,  0,1,0,  0,0,1, 1,1,0, 1,0,1, 0,1,1, 1,1,0, 1,0,1
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

  const positions = [];
  const colors = [];
  const indices = [];

  faces.forEach((face, faceIndex) => {
    const r = (faceIndex % 2 === 0) ? 1.0 : 0.2;
    const g = (faceIndex % 3 === 0) ? 1.0 : 0.2;
    const b = (faceIndex % 4 === 0) ? 1.0 : 0.2;

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

