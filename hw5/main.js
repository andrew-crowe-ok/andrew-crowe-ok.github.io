const VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
in vec2 aTexCoord;

uniform mat4 uModelView;
uniform mat4 uProjection;

out vec3 vPosition;
out vec3 vNormal;
out vec2 vTexCoord;

void main() {
  vec4 p = uModelView * vec4(aPosition, 1.0);
  vPosition = p.xyz;
  vNormal = mat3(transpose(inverse(uModelView))) * aNormal;
  vTexCoord = aTexCoord;
  gl_Position = uProjection * p;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec3 vPosition;
in vec3 vNormal;
in vec2 vTexCoord;

// Light 1
uniform vec3 uLightPos;
uniform vec3 uLightColor;
uniform float uLightIntensity;

// Light 2
uniform vec3 uLight2Pos;
uniform vec3 uLight2Color;
uniform float uLight2Intensity;

// Material Properties
uniform vec3 uColor;
uniform sampler2D uTexture;
uniform float uUseTexture;
uniform float uAmbient;
uniform float uDiffuse;
uniform float uSpecular;
uniform float uShininess;
uniform float uFlatShading;

// Master Shading Toggle (1.0 = shaded, 0.0 = unshaded)
uniform float uShadingEnabled;

out vec4 fragColor;

void main() {
  vec3 baseColor = (uUseTexture > 0.5) ? texture(uTexture, vTexCoord).rgb : uColor;

  // When shading is disabled, output pure unshaded color/texture
  if (uShadingEnabled < 0.5) {
    fragColor = vec4(baseColor, 1.0);
    return;
  }

  vec3 N;
  if (uFlatShading > 0.5) {
    N = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
  } else {
    N = normalize(vNormal);
  }

  vec3 V = normalize(-vPosition);

  // Light 1
  vec3 L1 = normalize(uLightPos - vPosition);
  vec3 R1 = reflect(-L1, N);
  float diff1 = max(dot(N, L1), 0.0);
  float spec1 = 0.0;
  if (diff1 > 0.0 && uSpecular > 0.0) {
    spec1 = pow(max(dot(V, R1), 0.0), max(uShininess, 1.0));
  }
  vec3 ambient1 = uAmbient * baseColor * uLightColor;
  vec3 diffuse1 = uDiffuse * diff1 * baseColor * uLightColor;
  vec3 specular1 = uSpecular * spec1 * vec3(1.0) * uLightColor;
  vec3 color1 = uLightIntensity * (ambient1 + diffuse1 + specular1);

  // Light 2
  vec3 L2 = normalize(uLight2Pos - vPosition);
  vec3 R2 = reflect(-L2, N);
  float diff2 = max(dot(N, L2), 0.0);
  float spec2 = 0.0;
  if (diff2 > 0.0 && uSpecular > 0.0) {
    spec2 = pow(max(dot(V, R2), 0.0), max(uShininess, 1.0));
  }
  vec3 ambient2 = uAmbient * baseColor * uLight2Color;
  vec3 diffuse2 = uDiffuse * diff2 * baseColor * uLight2Color;
  vec3 specular2 = uSpecular * spec2 * uLight2Color;
  vec3 color2 = uLight2Intensity * (ambient2 + diffuse2 + specular2);

  fragColor = vec4(color1 + color2, 1.0);
}
`;

window.createCube = function() {
  const positions = new Float32Array([
    -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1,
     1, -1, -1,  -1, -1, -1,  -1,  1, -1,   1,  1, -1,
    -1,  1,  1,   1,  1,  1,   1,  1, -1,  -1,  1, -1,
    -1, -1, -1,   1, -1, -1,   1, -1,  1,  -1, -1,  1,
     1, -1,  1,   1, -1, -1,   1,  1, -1,   1,  1,  1,
    -1, -1, -1,  -1, -1,  1,  -1,  1,  1,  -1,  1, -1
  ]);
  const faceNormals = [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0]];
  const normals = new Float32Array(faceNormals.flatMap(n => [...n, ...n, ...n, ...n]));
  const faceUVs = [0, 0,  1, 0,  1, 1,  0, 1];
  const texCoords = new Float32Array(Array(6).fill(faceUVs).flat());
  const indices = new Uint16Array([
     0,  1,  2,   0,  2,  3,
     4,  5,  6,   4,  6,  7,
     8,  9, 10,   8, 10, 11,
    12, 13, 14,  12, 14, 15,
    16, 17, 18,  16, 18, 19,
    20, 21, 22,  20, 22, 23
  ]);
  return { positions, normals, texCoords, indices };
};

window.createCylinder = function(segments = 24) {
  const pos = [], nrm = [], tex = [], idx = [];
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
};

window.createSphere = function(latBands = 24, longBands = 24) {
  const pos = [], nrm = [], tex = [], idx = [];
  for (let lat = 0; lat <= latBands; lat++) {
    const v = 1 - (lat / latBands);
    const theta = (lat / latBands) * Math.PI;
    const sinTheta = Math.sin(theta), cosTheta = Math.cos(theta);
    for (let lon = 0; lon <= longBands; lon++) {
      const u = 1 - (lon / longBands);
      const phi = (lon / longBands) * Math.PI * 2;
      const x = Math.cos(phi) * sinTheta, y = cosTheta, z = Math.sin(phi) * sinTheta;
      pos.push(x, y, z); nrm.push(x, y, z); tex.push(u, v);
    }
  }
  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < longBands; lon++) {
      const first = lat * (longBands + 1) + lon, second = first + longBands + 1;
      idx.push(first, first + 1, second, second, first + 1, second + 1);
    }
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    texCoords: new Float32Array(tex),
    indices: new Uint16Array(idx)
  };
};

window.createPyramid = function() {
  const positions = new Float32Array([
     0, -1,  0,   1,  1,  1,  -1,  1,  1,
     0, -1,  0,   1,  1, -1,   1,  1,  1,
     0, -1,  0,  -1,  1, -1,   1,  1, -1,
     0, -1,  0,  -1,  1,  1,  -1,  1, -1,
    -1,  1,  1,   1,  1,  1,   1,  1, -1,  -1,  1, -1
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
};

// WebGL Setup
const canvas = document.getElementById("glcanvas");
const gl = canvas.getContext("webgl2");

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

const ATTRIBUTES = { aPosition: 0, aNormal: 1, aTexCoord: 2 };

function createProgram(vsSource, fsSource) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSource));
  for (const name in ATTRIBUTES) gl.bindAttribLocation(prog, ATTRIBUTES[name], name);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

const program = createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
gl.useProgram(program);

const uModelView = gl.getUniformLocation(program, "uModelView");
const uProjection = gl.getUniformLocation(program, "uProjection");

const uLightPos = gl.getUniformLocation(program, "uLightPos");
const uLightColor = gl.getUniformLocation(program, "uLightColor");
const uLightIntensity = gl.getUniformLocation(program, "uLightIntensity");

const uLight2Pos = gl.getUniformLocation(program, "uLight2Pos");
const uLight2Color = gl.getUniformLocation(program, "uLight2Color");
const uLight2Intensity = gl.getUniformLocation(program, "uLight2Intensity");

const uColor = gl.getUniformLocation(program, "uColor");
const uTexture = gl.getUniformLocation(program, "uTexture");
const uUseTexture = gl.getUniformLocation(program, "uUseTexture");
const uAmbient = gl.getUniformLocation(program, "uAmbient");
const uDiffuse = gl.getUniformLocation(program, "uDiffuse");
const uSpecular = gl.getUniformLocation(program, "uSpecular");
const uShininess = gl.getUniformLocation(program, "uShininess");
const uFlatShading = gl.getUniformLocation(program, "uFlatShading");
const uShadingEnabled = gl.getUniformLocation(program, "uShadingEnabled");

function bindAttribute(name, data, size = 3) {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.vertexAttribPointer(ATTRIBUTES[name], size, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(ATTRIBUTES[name]);
}

function createMesh({ positions, normals, texCoords, indices }) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  bindAttribute("aPosition", positions, 3);
  bindAttribute("aNormal", normals, 3);
  bindAttribute("aTexCoord", texCoords, 2);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  return { vao, count: indices.length };
}

function loadTexture(url) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([200, 200, 200, 255])
  );

  const image = new Image();
  image.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  };
  image.src = url;
  return texture;
}

const antelopeTex = loadTexture("antelope.jpg");
const marsTex = loadTexture("mars2.jpg");

const cubeMesh = createMesh(createCube());
const cylinderMesh = createMesh(createCylinder(28));
const sphereMesh = createMesh(createSphere(28, 28));
const pyramidMesh = createMesh(createPyramid());
const lightMesh = createMesh(createSphere(16, 16));

gl.enable(gl.DEPTH_TEST);
gl.clearColor(0.05, 0.05, 0.07, 1);
const projection = perspective(Math.PI / 4, canvas.width / canvas.height, 0.1, 100);

// Two Light Sources
const lightWorld = [3.0, 5.0, 6.0];
const lightColor = [1.0, 0.95, 0.9];
let light1Intensity = 1.0;

// Light 2 corners in the bounded XZ plane: [-3, 3] on X and Z at Y = -5.0
const LIGHT2_MAX_OFFSET = 3.0;
const LIGHT2_Y = 2.0; // <-- Set your desired Y elevation here

const LIGHT2_CORNERS = [
  [-LIGHT2_MAX_OFFSET, LIGHT2_Y, -LIGHT2_MAX_OFFSET],
  [ LIGHT2_MAX_OFFSET, LIGHT2_Y, -LIGHT2_MAX_OFFSET],
  [ LIGHT2_MAX_OFFSET, LIGHT2_Y,  LIGHT2_MAX_OFFSET],
  [-LIGHT2_MAX_OFFSET, LIGHT2_Y,  LIGHT2_MAX_OFFSET]
];
const light2World = [...LIGHT2_CORNERS[0]];
const light2Color = [1.0, 1.0, 1.0];
let light2Intensity = 1.0;

// Camera Navigation
let dragRotX = 0.25, dragRotY = -0.45;
let camX = 0, camY = 0, camZ = -7.5;
let mouseDown = false, lastX, lastY;

canvas.addEventListener("mousedown", e => { mouseDown = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener("mouseup", () => mouseDown = false);
window.addEventListener("mousemove", e => {
  if (!mouseDown) return;
  dragRotY += (e.clientX - lastX) * 0.01;
  dragRotX += (e.clientY - lastY) * 0.01;
  lastX = e.clientX; lastY = e.clientY;
});

document.addEventListener("keydown", e => {
  const step = 0.2;
  switch (e.key) {
    case "ArrowUp": camY -= step; break;
    case "ArrowDown": camY += step; break;
    case "ArrowLeft": camX += step; break;
    case "ArrowRight": camX += step; break;
    case "w": camZ += step; break;
    case "s": camZ += step; break;
    default: return;
  }
  e.preventDefault();
});

const IDENTITY = translate(0, 0, 0);

function createNode(mesh, color, shape, material = {}, texture = null) {
  return {
    mesh,
    color,
    shape,
    ambient: material.ambient ?? 0.25,
    diffuse: material.diffuse ?? 0.70,
    specular: material.specular ?? 0.0,
    shininess: material.shininess ?? 32.0,
    flatShading: material.flatShading ?? 0.0,
    texture,
    joint: IDENTITY,
    children: []
  };
}

// --- Hierarchical Model Tree ---
// Level 1: Lower Arm (Cylinder) -> Diffuse/Ambient only, Smooth Shaded
const lowerArm = createNode(
  cylinderMesh,
  [0.95, 0.35, 0.35],
  multiply(translate(0, 0.6, 0), scale(0.3, 0.6, 0.3)),
  { ambient: 0.25, diffuse: 0.85, specular: 0.0, shininess: 1.0, flatShading: 0.0 }
);

// Level 2: Upper Arm (Cube) -> Flat Shaded
const upperArm = createNode(
  cubeMesh,
  [0.2, 0.5, 1.0],
  multiply(translate(0, 0.5, 0), scale(0.2, 0.5, 0.2)),
  { ambient: 0.25, diffuse: 0.65, specular: 1.0, shininess: 64.0, flatShading: 1.0 }
);
lowerArm.children.push(upperArm);

// Level 3: Mounting Pyramid -> Brightened ambient and diffuse lighting
const pyramidColor = [1.0, 0.85, 0.40];
const frameX = 2.1, frameZ = 0.75;
const topY = 1.0, botY = -1.35;
const barThick = 0.07;
const cradleScale = 0.35;
const pyrHalfH = 0.35;
const pyrHeight = pyrHalfH * 2.0;
const pyrHalfX = cradleScale * (frameX + barThick);
const pyrHalfZ = cradleScale * (frameZ + barThick);

const pyramidNode = createNode(
  pyramidMesh,
  pyramidColor,
  multiply(translate(0, pyrHalfH, 0), scale(pyrHalfX, pyrHalfH, pyrHalfZ)),
  { ambient: 0.55, diffuse: 1.15, specular: 1.0, shininess: 32.0, flatShading: 1.0 },
  antelopeTex
);
upperArm.children.push(pyramidNode);

// Level 4: Newton's Cradle Frame -> Black, Shiny, Flat Shaded
const frameColor = [0.02, 0.02, 0.02];
const frameMaterial = {
  ambient: 0.15,
  diffuse: 0.10,
  specular: 1.4,
  shininess: 96.0,
  flatShading: 1.0
};

const frameRoot = createNode(
  cubeMesh,
  frameColor,
  multiply(translate(0, botY, frameZ), scale(frameX + barThick, barThick, barThick)),
  frameMaterial
);

const cradleOffsetY = -(botY - barThick);
frameRoot.joint = multiply(
  translate(0, pyrHeight, 0),
  multiply(
    scale(cradleScale, cradleScale, cradleScale),
    translate(0, cradleOffsetY, 0)
  )
);
pyramidNode.children.push(frameRoot);

function addFrameRectangle(tx, ty, tz, sx, sy, sz) {
  frameRoot.children.push(
    createNode(cubeMesh, frameColor, multiply(translate(tx, ty, tz), scale(sx, sy, sz)), frameMaterial)
  );
}

addFrameRectangle(0, botY, -frameZ, frameX + barThick, barThick, barThick);
addFrameRectangle(-frameX, botY, 0, barThick, barThick, frameZ);
addFrameRectangle( frameX, botY, 0, barThick, barThick, frameZ);

const postHalfH = (topY - botY) / 2;
const postMidY = (topY + botY) / 2;
for (const x of [-frameX, frameX]) {
  for (const z of [-frameZ, frameZ]) {
    addFrameRectangle(x, postMidY, z, barThick, postHalfH, barThick);
  }
}

addFrameRectangle(0, topY,  frameZ, frameX + barThick, barThick, barThick);
addFrameRectangle(0, topY, -frameZ, frameX + barThick, barThick, barThick);
addFrameRectangle(-frameX, topY, 0, barThick, barThick, frameZ);
addFrameRectangle( frameX, topY, 0, barThick, barThick, frameZ);

// Levels 5 & 6: Wires (Smooth Shaded, Diffuse/Ambient only) and Spheres (Shiny, Smooth)
const wireColor = [0.70, 0.70, 0.75];
const ballColor = [0.88, 0.90, 0.95];
const sphereRadius = 0.34;
const dropY = 1.65;
const wireHalfLen = Math.hypot(dropY, frameZ) / 2;
const wireTilt = Math.atan2(frameZ, dropY);
const wireRadius = 0.015;

const pendulums = [];

for (let i = 0; i < 5; i++) {
  const pivotX = (i - 2) * (sphereRadius * 2);

  const frontWireShape = multiply(
    translate(0, -dropY / 2, -frameZ / 2),
    multiply(rotateX(-wireTilt), scale(wireRadius, wireHalfLen, wireRadius))
  );
  const pendulumPivot = createNode(
    cylinderMesh,
    wireColor,
    frontWireShape,
    { ambient: 0.3, diffuse: 0.7, specular: 0.0, shininess: 1.0, flatShading: 0.0 }
  );

  const backWireShape = multiply(
    translate(0, -dropY / 2, frameZ / 2),
    multiply(rotateX(wireTilt), scale(wireRadius, wireHalfLen, wireRadius))
  );
  const backWire = createNode(
    cylinderMesh,
    wireColor,
    backWireShape,
    { ambient: 0.3, diffuse: 0.7, specular: 0.0, shininess: 1.0, flatShading: 0.0 }
  );

  const sphereShape = multiply(
    translate(0, -dropY, 0),
    scale(sphereRadius, sphereRadius, sphereRadius)
  );
  const sphereNode = createNode(
    sphereMesh,
    ballColor,
    sphereShape,
    { ambient: 0.20, diffuse: 0.60, specular: 1.8, shininess: 128.0, flatShading: 0.0 },
    marsTex
  );

  pendulumPivot.children.push(backWire, sphereNode);
  frameRoot.children.push(pendulumPivot);
  pendulums.push({ node: pendulumPivot, pivotX });
}

function drawNode(node, frame) {
  gl.uniformMatrix4fv(uModelView, false, multiply(frame, node.shape));
  gl.uniform3fv(uColor, node.color);
  gl.uniform1f(uAmbient, node.ambient);
  gl.uniform1f(uDiffuse, node.diffuse);
  gl.uniform1f(uSpecular, node.specular);
  gl.uniform1f(uShininess, node.shininess);
  gl.uniform1f(uFlatShading, node.flatShading);

  if (node.texture) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, node.texture);
    gl.uniform1i(uTexture, 0);
    gl.uniform1f(uUseTexture, 1.0);
  } else {
    gl.uniform1f(uUseTexture, 0.0);
  }

  gl.bindVertexArray(node.mesh.vao);
  gl.drawElements(gl.TRIANGLES, node.mesh.count, gl.UNSIGNED_SHORT, 0);
}

function drawTree(root, rootFrame) {
  const stack = [[root, rootFrame]];
  while (stack.length > 0) {
    const [node, parentFrame] = stack.pop();
    const frame = multiply(parentFrame, node.joint);
    drawNode(node, frame);
    for (const child of node.children) stack.push([child, frame]);
  }
}

// --- UI Controls Setup ---
// Shading Toggle
let shadingEnabled = true;
const toggleShadingBtn = document.getElementById("toggleShadingBtn");
toggleShadingBtn.addEventListener("click", () => {
  shadingEnabled = !shadingEnabled;
  toggleShadingBtn.textContent = shadingEnabled ? "Disable Shading" : "Enable Shading";
});

// Light Intensities (0.0 to 3.0)
const sliderLight1Intensity = document.getElementById("sliderLight1Intensity");
const sliderLight2Intensity = document.getElementById("sliderLight2Intensity");
const valLight1Intensity = document.getElementById("valLight1Intensity");
const valLight2Intensity = document.getElementById("valLight2Intensity");

sliderLight1Intensity.addEventListener("input", e => {
  light1Intensity = parseFloat(e.target.value);
  valLight1Intensity.textContent = light1Intensity.toFixed(2);
});

sliderLight2Intensity.addEventListener("input", e => {
  light2Intensity = parseFloat(e.target.value);
  valLight2Intensity.textContent = light2Intensity.toFixed(2);
});

// Segment Movements
let lowerArmAngle = 0.0;
let upperArmAngle = 0.0;

const sliderLowerArm = document.getElementById("sliderLowerArm");
const sliderUpperArm = document.getElementById("sliderUpperArm");
const valLowerArm = document.getElementById("valLowerArm");
const valUpperArm = document.getElementById("valUpperArm");

sliderLowerArm.addEventListener("input", e => {
  lowerArmAngle = parseFloat(e.target.value);
  valLowerArm.textContent = lowerArmAngle.toFixed(2);
});

sliderUpperArm.addEventListener("input", e => {
  upperArmAngle = parseFloat(e.target.value);
  valUpperArm.textContent = upperArmAngle.toFixed(2);
});

// Light 2 RGB Controls
const sliderR = document.getElementById("sliderR");
const sliderG = document.getElementById("sliderG");
const sliderB = document.getElementById("sliderB");
const valR = document.getElementById("valR");
const valG = document.getElementById("valG");
const valB = document.getElementById("valB");

function updateColorFromSliders() {
  light2Color[0] = parseFloat(sliderR.value);
  light2Color[1] = parseFloat(sliderG.value);
  light2Color[2] = parseFloat(sliderB.value);
  valR.textContent = light2Color[0].toFixed(2);
  valG.textContent = light2Color[1].toFixed(2);
  valB.textContent = light2Color[2].toFixed(2);
}

sliderR.addEventListener("input", updateColorFromSliders);
sliderG.addEventListener("input", updateColorFromSliders);
sliderB.addEventListener("input", updateColorFromSliders);

document.getElementById("randomColorBtn").addEventListener("click", () => {
  sliderR.value = (Math.round(Math.random() * 20) * 0.05).toFixed(2);
  sliderG.value = (Math.round(Math.random() * 20) * 0.05).toFixed(2);
  sliderB.value = (Math.round(Math.random() * 20) * 0.05).toFixed(2);
  updateColorFromSliders();
});

let isAnimating = true;
let stopRequested = false;
let targetStopTime = 0;
let animTime = 0;
let lastFrameTime = null;

const toggleAnimBtn = document.getElementById("toggleAnimBtn");
toggleAnimBtn.addEventListener("click", () => {
  if (isAnimating && !stopRequested) {
    const currentPhase = 3.0 * animTime;
    targetStopTime = ((Math.floor(currentPhase / Math.PI) + 1) * Math.PI) / 3.0;
    stopRequested = true;
    toggleAnimBtn.textContent = "Stopping...";
  } else {
    isAnimating = true;
    stopRequested = false;
    toggleAnimBtn.textContent = "Stop Pendulum";
  }
});

// Render Loop
function render(time) {
  const t = time / 1000;
  if (lastFrameTime === null) lastFrameTime = time;
  const dt = (time - lastFrameTime) / 1000;
  lastFrameTime = time;

  if (isAnimating) {
    animTime += dt;
    if (stopRequested && animTime >= targetStopTime) {
      animTime = targetStopTime;
      isAnimating = false;
      stopRequested = false;
      toggleAnimBtn.textContent = "Start Pendulum";
    }
  }

  // Snap Light 2 between the 4 corners of its XZ bounding box every 1.5 seconds
  const cornerIdx = Math.floor(t / 1.5) % LIGHT2_CORNERS.length;
  light2World[0] = LIGHT2_CORNERS[cornerIdx][0];
  light2World[1] = LIGHT2_CORNERS[cornerIdx][1];
  light2World[2] = LIGHT2_CORNERS[cornerIdx][2];

  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const view = translate(camX, camY, camZ);
  gl.uniformMatrix4fv(uProjection, false, projection);

  // Master shading enable/disable
  gl.uniform1f(uShadingEnabled, shadingEnabled ? 1.0 : 0.0);

  // Light 1 uniforms
  gl.uniform3fv(uLightPos, transformPoint(view, lightWorld));
  gl.uniform3fv(uLightColor, lightColor);
  gl.uniform1f(uLightIntensity, light1Intensity);

  // Light 2 uniforms
  gl.uniform3fv(uLight2Pos, transformPoint(view, light2World));
  gl.uniform3fv(uLight2Color, light2Color);
  gl.uniform1f(uLight2Intensity, light2Intensity);

  const rotation = multiply(rotateY(dragRotY), rotateX(dragRotX));

  const lowerDynamic = isAnimating ? (0.5 * Math.sin(t)) : 0.0;
  const upperDynamic = isAnimating ? Math.sin(1.5 * t) : 0.0;

  lowerArm.joint = multiply(multiply(translate(0, -2.0, 0), rotation), rotateZ(lowerArmAngle + lowerDynamic));
  upperArm.joint = multiply(translate(0, 1.2, 0), rotateZ(upperArmAngle + upperDynamic));
  pyramidNode.joint = multiply(translate(0, 1.0, 0), rotateY(2.5 * (isAnimating ? t : 0.0)));

  const swing = isAnimating ? 0.75 * Math.sin(3.0 * animTime) : 0.0;
  for (let i = 0; i < 5; i++) {
    let angle = 0;
    if (i === 0) angle = Math.min(0, swing);
    else if (i === 4) angle = Math.max(0, swing);
    pendulums[i].node.joint = multiply(translate(pendulums[i].pivotX, topY, 0), rotateZ(angle));
  }

  drawTree(lowerArm, view);

  // Light 1 Marker Sphere
  const light1Matrix = multiply(
    view,
    multiply(translate(lightWorld[0], lightWorld[1], lightWorld[2]), scale(0.12, 0.12, 0.12))
  );
  gl.uniformMatrix4fv(uModelView, false, light1Matrix);
  gl.uniform3fv(uColor, lightColor);
  gl.uniform1f(uAmbient, 1.0);
  gl.uniform1f(uDiffuse, 0.0);
  gl.uniform1f(uSpecular, 0.0);
  gl.uniform1f(uFlatShading, 0.0);
  gl.uniform1f(uUseTexture, 0.0);
  gl.bindVertexArray(lightMesh.vao);
  gl.drawElements(gl.TRIANGLES, lightMesh.count, gl.UNSIGNED_SHORT, 0);

// Light 2 Marker Sphere (snaps with Light 2)
  const light2Matrix = multiply(
    view,
    multiply(translate(light2World[0], light2World[1], light2World[2]), scale(0.3, 0.3, 0.3))
  );
  gl.uniformMatrix4fv(uModelView, false, light2Matrix);
  gl.uniform3fv(uColor, light2Color);

  // --- Material Uniforms for Specular Reflection ---
  gl.uniform1f(uAmbient, 0.2);       // Lowered from 1.0 so the highlight isn't washed out
  gl.uniform1f(uDiffuse, 0.6);       // Adds curvature shading across the sphere
  gl.uniform1f(uSpecular, 1.2);      // Enables specular reflection (> 0.0)
  gl.uniform1f(uShininess, 64.0);    // Controls the tightness/gloss of the highlight
  gl.uniform1f(uFlatShading, 0.0);   // Smooth shading keeps the highlight rounded
  gl.uniform1f(uUseTexture, 0.0);

  gl.bindVertexArray(lightMesh.vao);
  gl.drawElements(gl.TRIANGLES, lightMesh.count, gl.UNSIGNED_SHORT, 0);

  requestAnimationFrame(render);
}
requestAnimationFrame(render);