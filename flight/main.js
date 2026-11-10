// WebGL setup
const canvas = document.getElementById("glcanvas");

// Phones and tablets: a touch screen and a GPU a fraction of a desktop's. They
// get touch controls, smaller textures, fewer pixels and fewer default bounces.
const MOBILE = matchMedia("(pointer: coarse)").matches;

// If the ray tracer can't run -- no WebGL 2, a shader this GPU won't build, a
// lost context -- say so on the page rather than leave it black (the fade
// over the canvas only lifts once frames are being drawn)
function showError(message) {
  const el = document.getElementById("error");
  if (!el.hidden) return;     // the first failure is the one that explains the rest
  el.textContent = message;
  el.hidden = false;
}
window.addEventListener("error", e => {
  if (e.target && e.target !== window) return;
  showError(`The ray tracer stopped: ${e.message}`);
});
canvas.addEventListener("webglcontextlost", () =>
  showError("The GPU dropped the WebGL context. Reload the page, or lower the bounces with ?bounces=1."));

const gl = canvas.getContext("webgl2");
if (!gl) showError("This browser has no WebGL 2, which the ray tracer needs.");

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(vsSource, fsSource) {
  const prog = gl.createProgram();
  let vs = null, fs = null;
  try {
    vs = compile(gl.VERTEX_SHADER, vsSource);
    fs = compile(gl.FRAGMENT_SHADER, fsSource);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(prog) || "the GPU could not build the shader");
    return prog;
  } catch (e) {
    gl.deleteProgram(prog);  // also releases the attached shaders
    throw e;
  } finally {
    // flag for deletion: freed once detached or with the program
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  }
}

// One program does everything (raytrace.js)
const program = createProgram(RAYTRACE_VS, RAYTRACE_FS);
gl.useProgram(program);
const uniforms = new Proxy({}, {
  get: (cache, name) => cache[name] ??= gl.getUniformLocation(program, name)
});
gl.uniform1iv(uniforms.uTex, Array.from({ length: TEXTURE_UNITS }, (_, i) => i));

// Lights, fixed in the scene as in HW6: a warm sun off to the side and outside
// the orbit, so the planet shows a terminator, and a dim cool fill opposite it
// to lift the night side. The third rides the ship (ship.js). Each light's
// intensity is folded into its color; `ref` is the distance at which
// attenuation leaves it at full strength -- the planet's center for the two
// fixed ones, the ship's hull for its own -- and `reach` how far out it keeps
// falling off: the ship stays lit at warp, leaving the system behind.
const SUN = { pos: [12, 5, 3], color: [1.25, 1.19, 1.06], ref: 13.3, reach: 21 };
const FILL = { pos: [-12, -5, -3], color: [0.12, 0.17, 0.3], ref: 13.3, reach: 21 };
const NAV = { color: [0.35, 0.62, 1.0], ref: 0.85, reach: 1e6 };

// ---------------------------------------------------------------------------
// The scene, as the ray tracer sees it
//
// The hierarchy from HW6 (ship.js, scene.js) is unchanged: every part still
// goes through drawPrimitive with its model-view matrix. Instead of drawing a
// mesh, drawPrimitive now records the part -- its shape, the inverse of that
// matrix, its textures and material -- and the whole list goes to the shader
// once a frame.
// ---------------------------------------------------------------------------

// The meshes are now just which unit shape to intersect. `repeats` is how many
// times the texture wraps around (models.js's uRepeat), `tube` the torus's.
const cubeMesh = { shape: BOX, repeats: 1 };
const cylinderMesh = { shape: CYLINDER, repeats: 3 };
const hullMesh = { shape: CYLINDER, repeats: 1 };   // once around, to line up with the hull's caps
const coneMesh = { shape: CONE, repeats: 1 };
const torusMesh = { shape: TORUS, repeats: 1, tube: 0.04 };   // saucer rim
const sphereMesh = { shape: SPHERE, repeats: 1 };
const saucerMesh = sphereMesh, planetMesh = sphereMesh;

// Shiny painted metal, for parts that don't name a material of their own.
//   kr      share of light mirrored (reflection rays)
//   kt      share let through (glass: refraction rays)
//   ior     index of refraction, for glass
//   absorb  glass's absorption per unit length (Beer-Lambert), per channel
//   glow    how brightly the texture's emission (its alpha) shines
//   power   an EMISSIVE part's brightness (the engines' animated levels, ship.js)
//   scroll  how far an EMISSIVE part's texture has slid along its z axis
const DEFAULT_MATERIAL = { ka: 0.2, kd: 0.8, ks: 0.5, shininess: 32, bumpScale: 3.0, atmosphere: [0, 0, 0] };

// The per-primitive arrays live in one ArrayBuffer laid out as raytrace.js's
// Scene block (std140, one vec4 per element, in this order), so a frame's
// upload is a single call. Each entry: its length in vec4s.
const SCENE_BLOCK = {
  primInv: 3 * MAX_PRIMS, info: MAX_PRIMS, matA: MAX_PRIMS, matB: MAX_PRIMS,
  matC: MAX_PRIMS, matD: MAX_PRIMS, matE: MAX_PRIMS,
  groupInv: 3 * MAX_GROUPS, groupHalf: MAX_GROUPS, groupRange: MAX_GROUPS,
  instInv: 3 * MAX_INSTANCES, instBoxCenter: MAX_INSTANCES, instBoxHalf: MAX_INSTANCES,
  instInfo: MAX_INSTANCES, instParams: MAX_INSTANCES
};
const sceneBytes = new ArrayBuffer(16 * Object.values(SCENE_BLOCK).reduce((a, n) => a + n, 0));

const scene = {
  count: 0,
  groupCount: 0,
  instCount: 0,
  nav: [0, 0, 0],
  sky: { center: new Float32Array(3), rot: new Float32Array(9), streak: new Float32Array(3) }
};
let blockAt = 0;
for (const [name, vec4s] of Object.entries(SCENE_BLOCK)) {
  scene[name] = new (name === "info" || name === "groupRange" || name === "instInfo" ? Int32Array : Float32Array)(sceneBytes, 16 * blockAt, 4 * vec4s);
  blockAt += vec4s;
}

const sceneBuffer = gl.createBuffer();
gl.bindBuffer(gl.UNIFORM_BUFFER, sceneBuffer);
gl.bufferData(gl.UNIFORM_BUFFER, sceneBytes.byteLength, gl.DYNAMIC_DRAW);
const sceneBlock = gl.getUniformBlockIndex(program, "Scene");
if (gl.getActiveUniformBlockParameter(program, sceneBlock, gl.UNIFORM_BLOCK_DATA_SIZE) !== sceneBytes.byteLength)
  throw new Error("SCENE_BLOCK doesn't match the shader's Scene block");
gl.uniformBlockBinding(program, sceneBlock, 0);
gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, sceneBuffer);

const unitOf = texture => texture ? TEXTURES.indexOf(texture) : -1;
const ZERO3 = Object.freeze([0, 0, 0]);

function drawPrimitive(mesh, texture, mapping, modelView, material = DEFAULT_MATERIAL,
  normalMap = null) {
  if (scene.count >= MAX_PRIMS) throw new Error(`more than ${MAX_PRIMS} primitives`);
  const i = scene.count++;
  const { ka, kd, ks, shininess, bumpScale, atmosphere, kr = 0, kt = 0, absorb, glow = 0,
    power = 1 } = material;
  // Every glass part takes its index of refraction from the slider (updated in uploadScene)
  const ior = kt > 0 ? (material.ior ?? 1.5) : 1;
  invertAffineRows(modelView, scene.primInv, i * 12);
  const base = i * 4;
  scene.info[base]     = mesh.shape;
  scene.info[base + 1] = unitOf(texture);
  scene.info[base + 2] = unitOf(normalMap);
  scene.info[base + 3] = mapping;

  scene.matA[base]     = ka;
  scene.matA[base + 1] = kd;
  scene.matA[base + 2] = ks;
  scene.matA[base + 3] = shininess;

  scene.matB[base]     = kr;
  scene.matB[base + 1] = kt;
  scene.matB[base + 2] = ior;
  scene.matB[base + 3] = bumpScale;

  const atm = atmosphere || ZERO3;
  scene.matC[base]     = atm[0];
  scene.matC[base + 1] = atm[1];
  scene.matC[base + 2] = atm[2];
  scene.matC[base + 3] = mesh.tube ?? 0;

  const abs = absorb || ZERO3;
  scene.matD[base]     = abs[0];
  scene.matD[base + 1] = abs[1];
  scene.matD[base + 2] = abs[2];
  scene.matD[base + 3] = mesh.repeats;

  scene.matE[base]     = glow;
  scene.matE[base + 1] = group ? group.index : -1;
  scene.matE[base + 2] = material.engineType || 0;
  scene.matE[base + 3] = material.engineType ? 1.0 : (material.power ?? 1.0);

  if (group) fitGroup(mesh, modelView);
}

function addInstance(model, modelView, params = null) {
  if (scene.instCount >= MAX_INSTANCES) throw new Error(`more than ${MAX_INSTANCES} instances`);
  const inst = scene.instCount++;
  invertAffineRows(modelView, scene.instInv, inst * 12);
  const base = inst * 4;
  const c = model.boxCenter, h = model.boxHalf;
  scene.instBoxCenter[base]     = c[0];
  scene.instBoxCenter[base + 1] = c[1];
  scene.instBoxCenter[base + 2] = c[2];
  scene.instBoxCenter[base + 3] = 0;

  scene.instBoxHalf[base]     = h[0];
  scene.instBoxHalf[base + 1] = h[1];
  scene.instBoxHalf[base + 2] = h[2];
  scene.instBoxHalf[base + 3] = 0;

  scene.instInfo[base]     = model.primStart;
  scene.instInfo[base + 1] = model.primStart + model.primCount;
  scene.instInfo[base + 2] = model.groupStart;
  scene.instInfo[base + 3] = model.groupCount;

  if (params) {
    scene.instParams[base]     = params.impulse ?? 1;
    scene.instParams[base + 1] = params.coils ?? 1;
    scene.instParams[base + 2] = params.bussard ?? 1;
    scene.instParams[base + 3] = params.scroll ?? 0;
  } else {
    scene.instParams[base]     = 1;
    scene.instParams[base + 1] = 1;
    scene.instParams[base + 2] = 1;
    scene.instParams[base + 3] = 0;
  }
}
window.addInstance = addInstance;

// The parts drawn between beginGroup(frame) and endGroup() are boxed together,
// so the shader can skip them all for a ray that misses the box. The box is
// aligned with frame and fitted as they're drawn: each part's unit shape fits
// in a box of its own (|p| <= 1, or the torus's ring plus tube), and that
// box's corners, carried into frame's space, bound the part there.
const groupPool = Array.from({ length: MAX_GROUPS }, (_, i) => ({
  index: i,
  toFrame: new Float32Array(16),
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
  start: 0
}));
const fitGroupScratch = new Float32Array(16);
let group = null;

function beginGroup(frame) {
  if (group) throw new Error("groups don't nest");
  if (scene.groupCount >= MAX_GROUPS) throw new Error(`more than ${MAX_GROUPS} groups`);
  const g = groupPool[scene.groupCount++];
  g.start = scene.count;
  g.min[0] = Infinity;  g.min[1] = Infinity;  g.min[2] = Infinity;
  g.max[0] = -Infinity; g.max[1] = -Infinity; g.max[2] = -Infinity;
  invertAffineMat(frame, g.toFrame);
  group = g;
}

function fitGroup(mesh, modelView) {
  const m = multiplyInto(group.toFrame, modelView, fitGroupScratch);
  const r = mesh.shape === TORUS ? 1 + mesh.tube : 1, h = mesh.shape === TORUS ? mesh.tube : 1;
  const gmin = group.min, gmax = group.max;
  for (let s = 0; s < 8; s++) {
    const x = (s & 1) ? r : -r;
    const y = (s & 2) ? h : -h;
    const z = (s & 4) ? r : -r;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    const pz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    if (px < gmin[0]) gmin[0] = px; if (px > gmax[0]) gmax[0] = px;
    if (py < gmin[1]) gmin[1] = py; if (py > gmax[1]) gmax[1] = py;
    if (pz < gmin[2]) gmin[2] = pz; if (pz > gmax[2]) gmax[2] = pz;
  }
}

// The box's matrix takes eye space to the box's own, centered on it
function endGroup() {
  const idx = group.index;
  const gmin = group.min, gmax = group.max;
  const cx = (gmin[0] + gmax[0]) * 0.5, cy = (gmin[1] + gmax[1]) * 0.5, cz = (gmin[2] + gmax[2]) * 0.5;
  const at = 12 * idx;
  const T = group.toFrame;
  const out = scene.groupInv;
  out[at]      = T[0]; out[at + 1]  = T[4]; out[at + 2]  = T[8];  out[at + 3]  = T[12] - cx;
  out[at + 4]  = T[1]; out[at + 5]  = T[5]; out[at + 6]  = T[9];  out[at + 7]  = T[13] - cy;
  out[at + 8]  = T[2]; out[at + 9]  = T[6]; out[at + 10] = T[10]; out[at + 11] = T[14] - cz;
  const base = 4 * idx;
  scene.groupHalf[base]     = (gmax[0] - gmin[0]) * 0.5;
  scene.groupHalf[base + 1] = (gmax[1] - gmin[1]) * 0.5;
  scene.groupHalf[base + 2] = (gmax[2] - gmin[2]) * 0.5;
  scene.groupHalf[base + 3] = 0;
  scene.groupRange[base]     = group.start;
  scene.groupRange[base + 1] = scene.count;
  scene.groupRange[base + 2] = 0;
  scene.groupRange[base + 3] = 0;
  group = null;
}

// The ship's own light, in eye space (ship.js)
function setNavLight(x, y, z) {
  if (typeof y === "number") {
    scene.nav[0] = x; scene.nav[1] = y; scene.nav[2] = z;
  } else {
    scene.nav[0] = x[0]; scene.nav[1] = x[1]; scene.nav[2] = x[2];
  }
}

// The sky's frame (scene.js): where its center is and how it is turned, in
// eye space, and the stars' velocity past the eye at warp
function setSky(frame, sx, sy, sz) {
  scene.sky.center[0] = frame[12]; scene.sky.center[1] = frame[13]; scene.sky.center[2] = frame[14];
  const rot = scene.sky.rot;
  rot[0] = frame[0]; rot[1] = frame[1]; rot[2] = frame[2];
  rot[3] = frame[4]; rot[4] = frame[5]; rot[5] = frame[6];
  rot[6] = frame[8]; rot[7] = frame[9]; rot[8] = frame[10];
  scene.sky.streak[0] = sx; scene.sky.streak[1] = sy; scene.sky.streak[2] = sz;
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

// Anisotropic filtering keeps textures sharp on surfaces seen at a slant
// (raytrace.js filters by the footprint's two axes, which brings it into play)
const ANISO = gl.getExtension("EXT_texture_filter_anisotropic");
const MAX_ANISO = ANISO ? gl.getParameter(ANISO.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;

// Resolves once every image file has loaded (bench.js waits on it)
const assetsReady = [];

// An image file: a 1x1 gray placeholder until it decodes, then the image with mipmaps
function loadTexture(url) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
  // A mipmap filter on a texture with no mipmaps is incomplete and samples as black
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

  const image = new Image();
  assetsReady.push(new Promise((resolve, reject) => {
    image.addEventListener("load", resolve);
    image.addEventListener("error", () => reject(new Error(`could not load ${url}`)));
  }));
  image.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);  // images start at the top row, texture coordinates at the bottom
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    if (ANISO) gl.texParameterf(gl.TEXTURE_2D, ANISO.TEXTURE_MAX_ANISOTROPY_EXT, MAX_ANISO);
  };
  image.src = url;
  return texture;
}

const planetTexture = loadTexture("textures/antelope.jpg");

// Procedural ship skin, generated on the GPU (textures.js). Every part's
// texture is sized to the surface it wraps -- the saucer's go around a
// circumference several times their height, so they are four times as wide as
// tall -- for roughly even detail over the ship. Phones get half the
// resolution each way, a quarter of the memory.
const generateSkin = createSkinGenerator(gl, { scale: MOBILE ? 0.5 : 1 });

const PAINT = [0.52, 0.535, 0.56];   // light blue-gray
// Windows on the saucer: pane width, pane height, spacing (ship units)
const SAUCER_WINDOWS = [0.02, 0.009, 0.04];

// Saucer lens: the outer ring is all that shows, with an escape pod or two
// in some plates and a thruster quad on each diagonal near the rim
const { color: saucerTexture, normal: saucerNormalMap } = generateSkin("saucer", {
  size: [4096, 1024], seed: 7,
  uniforms: { uRadius: 1.97, uThick: 0.075, uPlate: [0.2, 0.16], uPaint: PAINT, uContrast: 0.07,
    uFeatures: 1, uPods: true, uRowCount: 0, uRcs: [0.94, 4] } });
// Decks, the keyhole's head and the sensor dome: two rows of windows on each
// face's flank, just inside where it rises out of the lens -- rho 0.86 and
// 0.905 on top, 0.83 and 0.87 underneath, where the lower deck is smaller
const { color: deckTexture, normal: deckNormalMap } = generateSkin("saucer", {
  size: [4096, 1024], seed: 9,
  uniforms: { uRadius: 1.55, uThick: 0.22, uPlate: [0.2, 0.16], uPaint: PAINT, uContrast: 0.07,
    uFeatures: 1, uPods: true, uRcs: [0, 0], uWindow: SAUCER_WINDOWS,
    uRows: [[0.86, 1, 0, 0], [0.905, 1, 0, 0], [0.83, -1, 0, 0], [0.87, -1, 0, 0]], uRowCount: 4 } });
// Rim: a torus around the lens's edge, whose tube closes on itself (wrapV)
const { color: rimTexture, normal: rimNormalMap } = generateSkin("rim", {
  size: [4096, 256], seed: 13, wrapV: true,
  uniforms: { uRadius: 1.95, uTube: 0.062, uPlate: [0.2, 0.1], uPaint: PAINT, uContrast: 0.07,
    uWindow: [0.018, 0.008, 0.04], uRowY: [0.014, -0.014] } });
// Engineering hull: the cylinder's circumference and length set the scale
// (its caps, neck and pylons reuse the texture); a raised spine along the top
// (u = 0.25) and three rows of windows down each flank, just above and below
// its widest line
const { color: hullTexture, normal: hullNormalMap } = generateSkin("plating", {
  size: [2048, 1024], seed: 11,
  uniforms: { uCirc: 2.86, uLength: 1.3, uPlate: [0.18, 0.13], uPaint: [0.5, 0.515, 0.54], uContrast: 0.07,
    uFeatures: 1, uSpine: [0.25, 0.03, 0.002], uTrim: [0, 0],
    uWinU: [0.015, 0.05, 0.985, 0.485, 0.45, 0.515], uWinCount: 6, uWinV: [0.1, 0.9],
    uWindow: [0.022, 0.01, 0.045] } });
// Nacelles: darker, with a spine on top and dark trim down both sides behind
// the glowing grilles (u = 0 and 0.5)
const { color: nacelleTexture, normal: nacelleNormalMap } = generateSkin("plating", {
  size: [512, 1024], seed: 23,
  uniforms: { uCirc: 1.14, uLength: 2.1, uPlate: [0.12, 0.15], uPaint: [0.42, 0.44, 0.49], uContrast: 0.06,
    uFeatures: 0.6, uSpine: [0.25, 0.025, 0.002], uTrim: [0, 0.085], uWinCount: 0 } });

// Emissive glows, drawn unlit: the deflector dish, the warp grilles (blue)
// and the impulse engines (red-orange)
const { color: deflectorGlow } = generateSkin("deflector", {
  size: [1024, 1024], uniforms: { uInner: [0.85, 0.97, 1.0], uOuter: [0.05, 0.3, 0.95], uRings: 9, uSpokes: 24 } });
const { color: grilleGlow } = generateSkin("strip", {
  size: [1024, 128], uniforms: { uInner: [0.55, 0.82, 1.0], uOuter: [0.06, 0.22, 0.8],
    uFrame: [0.08, 0.09, 0.12], uSlats: 40, uFlow: 0.35 } });
const { color: impulseGlow } = generateSkin("strip", {
  size: [512, 128], uniforms: { uInner: [1.0, 0.6, 0.35], uOuter: [0.75, 0.06, 0.03],
    uFrame: [0.1, 0.08, 0.08], uSlats: 10, uFlow: 0.25 } });

// The nav light's bulb: one flat color, drawn glowing
const beaconTexture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, beaconTexture);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([150, 205, 255, 255]));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

// Animated texture: a muted, looping <video> whose current frame is re-uploaded
// every render, so it gets no mipmaps (LINEAR min filter). REPEAT on s lets u
// wrap around the sphere.
function loadVideoTexture(sources) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 60, 20, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const video = document.createElement("video");
  Object.assign(video, { muted: true, loop: true, playsInline: true, autoplay: true });
  if (location.protocol !== "file:") video.crossOrigin = "anonymous";
  video.addEventListener("error", () => {}, { once: true });
  video.src = sources.find(src => video.canPlayType(src.endsWith(".webm") ? "video/webm" : "video/mp4")) ?? sources[0];
  assetsReady.push(new Promise(resolve => {
    if (video.readyState >= video.HAVE_CURRENT_DATA) return resolve();
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    setTimeout(resolve, 800);
  }));
  video.play().catch(() => {});  // autoplay of muted video is allowed; ignore if blocked

  function update() {
    if (video.readyState < video.HAVE_CURRENT_DATA) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }
  // Playback speed; only touched when it changes, since every change makes
  // the browser re-time the stream
  function setRate(rate) {
    if (video.playbackRate !== rate) video.playbackRate = rate;
  }
  return { texture, update, setRate };
}

const plasma = loadVideoTexture(["textures/plasma.webm", "textures/plasma.mp4"]);

// Unit i holds TEXTURES[i] (raytrace.js samples them by unit)
const TEXTURES = [planetTexture, saucerTexture, saucerNormalMap, deckTexture, deckNormalMap,
  rimTexture, rimNormalMap, hullTexture, hullNormalMap, nacelleTexture, nacelleNormalMap,
  deflectorGlow, grilleGlow, impulseGlow, plasma.texture, beaconTexture];
if (TEXTURES.length !== TEXTURE_UNITS) throw new Error("TEXTURE_UNITS is out of date");
function bindTextures() {
  TEXTURES.forEach((texture, i) => {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  });
}

let GALAXY_MODEL = null, PLANET_MODEL = null, MOON_MODEL = null;
function initModels() {
  scene.count = 0;
  scene.groupCount = 0;

  const shipStart = scene.count, shipGrpStart = scene.groupCount;
  drawShip(identity());
  GALAXY_MODEL = {
    id: 0,
    primStart: shipStart,
    primCount: scene.count - shipStart,
    groupStart: shipGrpStart,
    groupCount: scene.groupCount - shipGrpStart,
    boxCenter: [0, 0, 0],
    boxHalf: [2.35, 0.75, 3.20]
  };

  const planetStart = scene.count, planetGrpStart = scene.groupCount;
  drawPrimitive(planetMesh, planetTexture, BUMP_MAPPING, identity(), PLANET_MATERIAL);
  PLANET_MODEL = {
    id: 1,
    primStart: planetStart,
    primCount: scene.count - planetStart,
    groupStart: planetGrpStart,
    groupCount: scene.groupCount - planetGrpStart,
    boxCenter: [0, 0, 0],
    boxHalf: [1.05, 1.05, 1.05]
  };

  const moonStart = scene.count, moonGrpStart = scene.groupCount;
  drawPrimitive(sphereMesh, null, BUMP_MAPPING, identity(), MOON_MATERIAL);
  MOON_MODEL = {
    id: 2,
    primStart: moonStart,
    primCount: scene.count - moonStart,
    groupStart: moonGrpStart,
    groupCount: scene.groupCount - moonGrpStart,
    boxCenter: [0, 0, 0],
    boxHalf: [1.05, 1.05, 1.05]
  };
}
initModels();
window.GALAXY_MODEL = GALAXY_MODEL;
window.PLANET_MODEL = PLANET_MODEL;
window.MOON_MODEL = MOON_MODEL;

// ---------------------------------------------------------------------------
// Canvas and lens
// ---------------------------------------------------------------------------

// Full-window canvas, kept framed as in HW6: vertical FOV 45 deg, widened on
// windows narrower than 16:10 so the whole orbit stays in frame. Every pixel is
// a ray tree, so the drawing buffer is capped at about 1440p's pixel count
// (540p's on phones), or whatever the Resolution control picks, and the
// browser scales it up past that.
//
// On phones, with Resolution on Auto, the cap also adapts: every ADAPT.window seconds the mean frame time
// is checked, and the pixel budget shrinks by ADAPT.step while frames run slower
// than ADAPT.slow, or grows back toward the cap while they run faster than
// ADAPT.fast, never below ADAPT.floor of it.
const BASE_FOVY = Math.PI / 4, MIN_ASPECT = 1.6;
const AUTO_PIXELS = MOBILE ? 960 * 540 : 2560 * 1440;
const ADAPT = { window: 1.0, slow: 45, fast: 24, step: 0.8, floor: 0.25 };
let maxPixels = AUTO_PIXELS;
let pixelBudget = 1;   // share of maxPixels in use
let projection, renderScale = 1;
// Resolution control: 0 is Auto, otherwise the cap is that many lines of 16:9
function setResolution(lines) {
  maxPixels = lines ? Math.round(lines * 16 / 9) * lines : AUTO_PIXELS;
  pixelBudget = 1;
  controls.resolution = lines;
  const resSelect = document.getElementById("resolution");
  if (resSelect && resSelect.value !== String(lines)) resSelect.value = String(lines);
  resize();
}
// The drawing buffer's size in pixels, and how many of them go to a CSS pixel
function setDrawingSize(width, height, scale) {
  renderScale = scale;
  canvas.width = width;
  canvas.height = height;
  gl.viewport(0, 0, canvas.width, canvas.height);
  const aspect = canvas.width / canvas.height;
  const fovy = aspect >= MIN_ASPECT ? BASE_FOVY
    : 2 * Math.atan(Math.tan(BASE_FOVY / 2) * MIN_ASPECT / aspect);
  projection = perspective(fovy, aspect, 0.1, 150);   // only its x and y scales matter now
}
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const css = canvas.clientWidth * canvas.clientHeight;
  const scale = Math.min(dpr, Math.sqrt(maxPixels * pixelBudget / Math.max(css, 1)));
  setDrawingSize(Math.round(canvas.clientWidth * scale), Math.round(canvas.clientHeight * scale), scale);
}
window.addEventListener("resize", resize);
resize();

const adapt = { t0: null, frames: 0, ms: 0 };
function adaptResolution(now, frameMs) {
  if (!MOBILE || controls.resolution) { adapt.t0 = null; adapt.frames = 0; adapt.ms = 0; return; }
  adapt.t0 ??= now;
  adapt.frames++; adapt.ms += frameMs;
  if (now - adapt.t0 < ADAPT.window) return;
  const mean = adapt.ms / adapt.frames;
  adapt.t0 = now; adapt.frames = 0; adapt.ms = 0;
  const next = mean > ADAPT.slow ? Math.max(ADAPT.floor, pixelBudget * ADAPT.step)
    : mean < ADAPT.fast ? Math.min(1, pixelBudget / ADAPT.step) : pixelBudget;
  if (next !== pixelBudget) { pixelBudget = next; resize(); }
}

// The angle one pixel spans mid-frame, which sizes the stars and picks
// mipmap levels: the plain lens's, blended toward the fisheye's as it opens
function pixelAngle() {
  const rect = 2 / (projection[5] * canvas.height);
  const fish = 4 * Math.sin(CHASE.fishHalfX / 2) / canvas.width;
  return rect + (fish - rect) * lensFisheye;
}

// ---------------------------------------------------------------------------
// Telemetry & stats overlay
// ---------------------------------------------------------------------------
const controls = {};
const statsOverlay = document.getElementById("statsOverlay");
const statsClose = document.getElementById("statsClose");
if (statsClose) {
  statsClose.addEventListener("click", () => {
    const statsInput = document.getElementById("stats");
    if (statsInput) {
      statsInput.checked = false;
      statsInput.dispatchEvent(new Event("input"));
    }
  });
}
function setStatsVisible(visible) {
  if (statsOverlay) statsOverlay.hidden = !visible;
}

const statEls = {
  phase: document.getElementById("statsFlightPhase"),
  fps: document.getElementById("statFps"),
  latency: document.getElementById("statLatency"),
  cpu: document.getElementById("statCpu"),
  gpuRow: document.getElementById("statGpuRow"),
  gpu: document.getElementById("statGpu"),
  res: document.getElementById("statRes"),
  scale: document.getElementById("statScale"),
  prims: document.getElementById("statPrims"),
  bounces: document.getElementById("statBounces"),
  entities: document.getElementById("statEntities"),
  targetRow: document.getElementById("statTargetRow"),
  target: document.getElementById("statTarget"),
  graph: document.getElementById("statsGraph"),
  gpuInfo: document.getElementById("statsGpuInfo"),
};
const graphCtx = statEls.graph ? statEls.graph.getContext("2d") : null;

if (statEls.gpuInfo) {
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  if (renderer) {
    statEls.gpuInfo.textContent = renderer;
    statEls.gpuInfo.title = renderer;
  }
}

// WebGL2 Disjoint Timer Query for measuring GPU fragment shader raytracing
const timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
let activeGpuQuery = null;
let pendingGpuQuery = null;
let lastGpuMs = null;

function beginGpuTimer() {
  if (!timerExt || !controls.stats || activeGpuQuery || pendingGpuQuery) return;
  activeGpuQuery = gl.createQuery();
  gl.beginQuery(timerExt.TIME_ELAPSED_EXT, activeGpuQuery);
}

function endGpuTimer() {
  if (!timerExt || !activeGpuQuery) return;
  gl.endQuery(timerExt.TIME_ELAPSED_EXT);
  pendingGpuQuery = activeGpuQuery;
  activeGpuQuery = null;
}

function pollGpuTimer() {
  if (!timerExt || !pendingGpuQuery) return;
  const available = gl.getQueryParameter(pendingGpuQuery, gl.QUERY_RESULT_AVAILABLE);
  const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
  if (available) {
    if (!disjoint) {
      const elapsedNs = gl.getQueryParameter(pendingGpuQuery, gl.QUERY_RESULT);
      lastGpuMs = elapsedNs / 1e6;
    }
    gl.deleteQuery(pendingGpuQuery);
    pendingGpuQuery = null;
  }
}

let statFrames = 0;
let statAccumTime = 0;
let statAccumCpu = 0;
let lastStatUpdate = 0;
let lastRafTime = 0;
const latencyHistory = [];
const MAX_LATENCY_HISTORY = 70;

function drawStatsGraph(history) {
  if (!graphCtx) return;
  const w = statEls.graph.width;
  const h = statEls.graph.height;
  graphCtx.clearRect(0, 0, w, h);

  // Guide lines: 16.67ms (60 FPS) and 33.33ms (30 FPS) against a 50ms ceiling
  const maxMs = 50;
  const y60 = h - (16.67 / maxMs) * h;
  const y30 = h - (33.33 / maxMs) * h;

  graphCtx.lineWidth = 1;
  graphCtx.setLineDash([2, 3]);

  // 60 FPS reference line (cyan)
  graphCtx.strokeStyle = "rgba(110, 200, 255, 0.3)";
  graphCtx.beginPath();
  graphCtx.moveTo(0, y60);
  graphCtx.lineTo(w, y60);
  graphCtx.stroke();

  // 30 FPS reference line (dim red)
  graphCtx.strokeStyle = "rgba(255, 120, 100, 0.22)";
  graphCtx.beginPath();
  graphCtx.moveTo(0, y30);
  graphCtx.lineTo(w, y30);
  graphCtx.stroke();
  graphCtx.setLineDash([]);

  const n = history.length;
  if (!n) return;
  const barWidth = w / MAX_LATENCY_HISTORY;
  const startX = w - n * barWidth;

  for (let i = 0; i < n; i++) {
    const ms = history[i];
    const barH = Math.max(1, Math.min(h, (ms / maxMs) * h));
    const x = startX + i * barWidth;
    const y = h - barH;

    if (ms <= 18) graphCtx.fillStyle = "rgba(110, 200, 255, 0.85)";       // ~60+ FPS
    else if (ms <= 35) graphCtx.fillStyle = "rgba(255, 209, 102, 0.85)";  // ~30-55 FPS
    else graphCtx.fillStyle = "rgba(255, 107, 107, 0.85)";                 // < 30 FPS

    graphCtx.fillRect(x, y, Math.max(1, barWidth - 0.5), barH);
  }
}

function updateStats(nowMs, frameDelta, cpuMs, ship) {
  if (!controls.stats) return;

  statFrames++;
  statAccumTime += frameDelta;
  statAccumCpu += cpuMs;

  latencyHistory.push(frameDelta);
  if (latencyHistory.length > MAX_LATENCY_HISTORY) latencyHistory.shift();

  drawStatsGraph(latencyHistory);

  if (nowMs - lastStatUpdate >= 250) {
    const avgDelta = statAccumTime / statFrames;
    const fps = 1000 / avgDelta;
    const avgCpu = statAccumCpu / statFrames;

    if (statEls.fps) {
      statEls.fps.textContent = `${fps.toFixed(1)} FPS`;
      statEls.fps.className = fps >= 55 ? "stat-val accent" : fps >= 28 ? "stat-val warn" : "stat-val alert";
    }
    if (statEls.latency) {
      statEls.latency.textContent = `${avgDelta.toFixed(1)} ms`;
    }
    if (statEls.cpu) {
      statEls.cpu.textContent = `${avgCpu.toFixed(1)} ms`;
    }
    if (statEls.gpuRow) {
      if (lastGpuMs !== null) {
        statEls.gpuRow.hidden = false;
        statEls.gpu.textContent = `${lastGpuMs.toFixed(1)} ms`;
      } else {
        statEls.gpuRow.hidden = true;
      }
    }
    if (statEls.res) {
      const mp = (canvas.width * canvas.height / 1e6).toFixed(2);
      statEls.res.textContent = `${canvas.width}×${canvas.height} (${mp}MP)`;
    }
    if (statEls.scale) {
      const dpr = (window.devicePixelRatio || 1).toFixed(1);
      const pct = Math.round(renderScale * 100);
      statEls.scale.textContent = `${pct}% @ ${dpr}× DPR`;
    }
    if (statEls.prims) {
      statEls.prims.textContent = `${scene.count} prims, ${scene.instCount} insts (${scene.groupCount} grp)`;
    }
    if (statEls.bounces) {
      const sh = controls.shadows ? "+shd" : "";
      const at = controls.attenuation ? "+atn" : "";
      statEls.bounces.textContent = `${controls.bounces} ${sh} ${at}`.trim();
    }
    if (statEls.phase) {
      const phase = ship.warp.state === "on" ? "WARP" : ship.helm ? "HELM" : "ORBIT";
      statEls.phase.textContent = phase;
      statEls.phase.classList.toggle("warp", phase === "WARP");
    }
    if (statEls.entities) {
      const entCount = (typeof world !== "undefined" && world.entities) ? world.entities.length : 1;
      statEls.entities.textContent = `${entCount} ${entCount === 1 ? "ship" : "ships"}`;
    }
    if (statEls.target && statEls.targetRow) {
      let escort = null;
      if (typeof world !== "undefined" && world.entities) {
        for (let i = 0; i < world.entities.length; i++) {
          const ent = world.entities[i];
          if (ent === world.player) continue;
          if (ent.role === "wingman") { escort = ent; break; }
          if (!escort) escort = ent;
        }
      }
      if (escort) {
        statEls.targetRow.hidden = false;
        const dx = escort.pos[0] - ship.pos[0];
        const dy = escort.pos[1] - ship.pos[1];
        const dz = escort.pos[2] - ship.pos[2];
        const dist = Math.hypot(dx, dy, dz);
        const state = escort.rail ? "ORBIT" : (escort.warp && escort.warp.state === "on") ? "WARP" : (escort.warp && escort.warp.state === "charge") ? "CHARGE" : (dist < 6 ? "ESCORT" : "FLYING");
        statEls.target.textContent = `${dist.toFixed(1)}u [${state}]`;
      } else {
        statEls.targetRow.hidden = true;
      }
    }

    statFrames = 0;
    statAccumTime = 0;
    statAccumCpu = 0;
    lastStatUpdate = nowMs;
  }
}

// ---------------------------------------------------------------------------
// Ray tracer controls (index.html)
// ---------------------------------------------------------------------------
const CONTROL_INPUTS = {
  bounces:     { read: el => parseInt(el.value), show: v => `${v}` },
  sun:         { read: el => parseFloat(el.value), show: v => v.toFixed(2) },
  fill:        { read: el => parseFloat(el.value), show: v => v.toFixed(2) },
  nav:         { read: el => parseFloat(el.value), show: v => v.toFixed(2) },
  shininess:   { read: el => 2 ** parseFloat(el.value), show: v => `×${v.toFixed(2)}` },
  ior:         { read: el => parseFloat(el.value), show: v => v.toFixed(2) },
  shadows:     { read: el => el.checked },
  attenuation: { read: el => el.checked },
  stats:       { read: el => el.checked },
  invert:      { read: el => el.checked },
  resolution:  { read: el => parseInt(el.value) || 0 },
  fps:         { read: el => parseInt(el.value) || 0 }
};
// The panel starts folded on small screens, where it would cover the scene
if (MOBILE || innerWidth < 560) document.getElementById("controls").open = false;

// The page's query string can preset any of them, e.g. ?bounces=0&shadows=0
const presets = new URLSearchParams(location.search);
for (const [id, { read, show }] of Object.entries(CONTROL_INPUTS)) {
  const input = document.getElementById(id);
  const output = document.querySelector(`output[for="${id}"]`);
  if (MOBILE && id === "bounces" && !presets.has(id)) input.value = "2";
  if (presets.has(id)) {
    if (input.type === "checkbox") input.checked = presets.get(id) !== "0" && presets.get(id) !== "false";
    else input.value = presets.get(id);
  } else if (id === "stats") {
    try {
      const saved = localStorage.getItem("hw7_stats");
      if (saved !== null) input.checked = saved === "1";
    } catch {}
  }
  const update = () => {
    controls[id] = read(input);
    if (output && show) output.textContent = show(controls[id]);
    if (id === "stats") {
      try { localStorage.setItem("hw7_stats", controls.stats ? "1" : "0"); } catch {}
      setStatsVisible(controls.stats);
    }
    if (id === "resolution") setResolution(controls.resolution);
  };
  input.addEventListener("input", update);
  update();
}

// Interactive controls. While the chase camera has the view, the drag angles
// steer it around the ship instead of turning the scene, and clicks, the
// wheel and the keys are ignored (camera.js).
let dragRotX, dragRotY;      // mouse drag
let camX, camY;              // arrow keys; w, s and the wheel zoom (camera.js)
// The scene's own clock starts here, so a reset restarts the orbit and the
// planet's spin along with everything else
let sceneStart = 0;

// Pointer input, mouse and touch alike. One pointer down drags the view
// around. Two (fingers) pinch to zoom, as the wheel does, and move together to
// pan, as the arrow keys do, the pan scaled so the focus point tracks the
// fingers. A press that strays more than CLICK_SLOP pixels from where it
// started, or that ever has a second finger, is a drag, and its release is not
// a click.
const CLICK_SLOP = 5;
const pointers = new Map();   // pointerId -> { x, y } where it was last seen
let dragged = false, pressX, pressY, pinch = null;

function pinchState() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
canvas.addEventListener("pointerdown", e => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    dragged = false;
    pressX = e.clientX; pressY = e.clientY;
  } else {
    dragged = true;
  }
  pinch = pointers.size === 2 ? pinchState() : null;
});
canvas.addEventListener("pointermove", e => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) {
    dragRotY += (e.clientX - p.x) * 0.01;
    dragRotX += (e.clientY - p.y) * 0.01;
    if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > CLICK_SLOP) dragged = true;
  }
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2 && pinch) {
    const now = pinchState();
    if (!offOrbit()) {
      if (now.dist > 0 && pinch.dist > 0) zoomPinch(pinch.dist / now.dist);
      const k = 2 * zoom.dist / (projection[5] * canvas.clientHeight);   // units per px at the focus
      camX += (now.x - pinch.x) * k;
      camY -= (now.y - pinch.y) * k;
    }
    pinch = now;
  }
});
function liftPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  pinch = pointers.size === 2 ? pinchState() : null;
}
canvas.addEventListener("pointerup", liftPointer);
canvas.addEventListener("pointercancel", liftPointer);

const CONTROL_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "s"];
document.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "i" || e.key === "I" || e.key === "o" || e.key === "O") {
    const statsInput = document.getElementById("stats");
    if (statsInput) {
      statsInput.checked = !statsInput.checked;
      statsInput.dispatchEvent(new Event("input"));
    }
    return;
  }
  if (!CONTROL_KEYS.includes(e.key)) return;
  e.preventDefault();         // arrows would scroll the page even when ignored
  if (offOrbit()) return;
  const step = 0.2;
  switch (e.key) {
    case "ArrowUp": camY -= step; break;
    case "ArrowDown": camY += step; break;
    case "ArrowLeft": camX += step; break;
    case "ArrowRight": camX -= step; break;
    case "w": zoomKey(-1); break;
    case "s": zoomKey(1); break;
  }
});

// Clicking the ship, the planet or the moon centers the view on it. Picking
// reads the view, ship and moon of the last frame drawn, which is what was
// clicked on.
let lastView = null, lastShip = null, lastMoon = null;
canvas.addEventListener("click", e => {
  if (!lastView || offOrbit() || dragged) return;
  const r = canvas.getBoundingClientRect();
  const hit = pickObject(2 * (e.clientX - r.left) / r.width - 1,
    1 - 2 * (e.clientY - r.top) / r.height, lastView, lastShip, lastMoon);
  if (!hit) return;
  focusOn(hit, performance.now() / 1000, [camX, camY]);
  camX = 0; camY = 0;
});

// The wheel zooms. Line and page deltas are turned into pixels first, a line
// at Chrome's 100 px per 3-line notch, so a notch zooms alike in every browser.
canvas.addEventListener("wheel", e => {
  e.preventDefault();         // also keeps a trackpad pinch from zooming the page
  if (offOrbit()) return;
  zoomWheel(e.deltaY * (e.deltaMode === 1 ? 100 / 3 : e.deltaMode === 2 ? canvas.clientHeight : 1));
}, { passive: false });

// Engage hands the player the helm. The press is handled on the next frame,
// where the clock is known (world.js), and the button stays down until the
// ship is back in orbit.
const engageButton = document.getElementById("engageButton");
engageButton.addEventListener("click", requestEngage);

// ---------------------------------------------------------------------------
// The helm. world.js flies the ship from `helm`; this keeps `helm` saying
// what the player is asking for, from the keys held down and, on touch
// screens, a stick and two roll buttons:
//
//   W / S       nose down / up (the stick: push forward, pull back)
//   A / D       nose left / right
//   Q / E       roll left / right
//   R / F       throttle up / down (also the up and down arrows, and the slider)
//   Space       warp lever
//   Escape      back to orbit
//
// Keys are read by e.code, the key's place on the board, so the layout holds
// on AZERTY and Dvorak too. Dragging on the scene still swings the camera
// round the ship.
// ---------------------------------------------------------------------------
const FLIGHT_KEYS = ["KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyF", "KeyC",
  "ArrowUp", "ArrowDown", "Space", "Escape"];
const held = new Set();                     // flight keys down right now
const stick = { x: 0, y: 0, id: null };     // the touch stick: -1 .. 1, y down the screen
let rollHeld = 0;                           // the touch roll buttons: -1, 0 or 1
let sceneT = 0;                             // the scene clock, as of the last frame

const returnToOrbit = () => requestReset(sceneT, FADE.out);
window.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "KeyC") {
    if (!e.repeat) toggleWingman();
    return;
  }
  if (!offOrbit() || !FLIGHT_KEYS.includes(e.code)) return;
  // A slider that has the focus keeps its own arrow keys
  if (e.code.startsWith("Arrow") && e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  if (e.code === "Space") { if (!e.repeat) helm.toggleWarp = true; }
  else if (e.code === "Escape") returnToOrbit();
  else held.add(e.code);
});
window.addEventListener("keyup", e => held.delete(e.code));
window.addEventListener("blur", () => held.clear());

const helmHud = document.getElementById("helmHud");
const helmEls = Object.fromEntries(["helmMode", "helmSpeed", "helmTarget", "throttle", "warpButton",
  "wingmanButton", "orbitButton", "stick", "stickKnob", "rollLeft", "rollRight"].map(id => [id, document.getElementById(id)]));

helmEls.throttle.addEventListener("input", () => { helm.lever = parseFloat(helmEls.throttle.value); });
// Buttons and the slider give the focus back once used, so Space and the
// arrows go on flying the ship instead of pressing them again
for (const el of [helmEls.throttle, helmEls.warpButton, helmEls.wingmanButton, helmEls.orbitButton])
  if (el) el.addEventListener("pointerup", () => el.blur());
helmEls.warpButton.addEventListener("click", () => { helm.toggleWarp = true; });
if (helmEls.wingmanButton) helmEls.wingmanButton.addEventListener("click", toggleWingman);
helmEls.orbitButton.addEventListener("click", returnToOrbit);

const wingmanToggleEl = document.getElementById("wingmanToggle");
if (wingmanToggleEl) {
  wingmanToggleEl.addEventListener("change", toggleWingman);
}

function toggleWingman() {
  if (typeof world === "undefined" || !world.entities) return;
  if (typeof toggleCompanionEntity === "function") {
    toggleCompanionEntity(world);
  } else {
    const companionIdx = world.entities.findIndex(e => e !== world.player && e.role === "wingman");
    if (companionIdx >= 0) {
      world.entities.splice(companionIdx, 1);
    } else {
      if (world.player.rail) {
        addEntity({
          model: "galaxy",
          rail: companionOrbitPose(-0.5),
          role: "wingman"
        });
      } else {
        const p = world.player;
        const slot = [-3.2, 0.4, -4.5];
        const rotSlot = quatRotate(p.quat, slot);
        const slotPos = [p.pos[0] + rotSlot[0], p.pos[1] + rotSlot[1], p.pos[2] + rotSlot[2]];
        const isWarp = p.warp && (p.warp.state === "on" || p.warp.state === "charge");
        addEntity({
          model: "galaxy",
          rail: null,
          controller: wingmanController,
          pos: slotPos,
          quat: p.quat.slice(),
          vel: p.vel.slice(),
          speed: p.speed,
          role: "wingman",
          warp: isWarp ? { state: p.warp.state, tau: p.warp.tau } : { state: "off", tau: 0 },
          warpRamp: isWarp ? p.warpRamp : 0
        });
      }
    }
  }
  const hasCompanion = world.entities.some(e => e !== world.player && e.role === "wingman");
  if (wingmanToggleEl) wingmanToggleEl.checked = hasCompanion;
  if (helmEls.wingmanButton) helmEls.wingmanButton.setAttribute("aria-pressed", hasCompanion);
}
window.toggleWingman = toggleWingman;

// The stick: where the finger is from the middle, as a share of the radius,
// held inside the unit circle
function moveStick(e) {
  const r = helmEls.stick.getBoundingClientRect(), R = r.width / 2;
  let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  stick.x = x; stick.y = y;
  helmEls.stickKnob.style.translate = `${x * R * 0.6}px ${y * R * 0.6}px`;
}
function dropStick(e) {
  if (e && e.pointerId !== stick.id) return;
  stick.id = null; stick.x = 0; stick.y = 0;
  helmEls.stickKnob.style.translate = "0px 0px";
}
helmEls.stick.addEventListener("pointerdown", e => {
  stick.id = e.pointerId;
  helmEls.stick.setPointerCapture(e.pointerId);
  moveStick(e);
});
helmEls.stick.addEventListener("pointermove", e => { if (e.pointerId === stick.id) moveStick(e); });
helmEls.stick.addEventListener("pointerup", dropStick);
helmEls.stick.addEventListener("pointercancel", dropStick);
for (const [el, dir] of [[helmEls.rollLeft, -1], [helmEls.rollRight, 1]]) {
  el.addEventListener("pointerdown", e => { el.setPointerCapture(e.pointerId); rollHeld = dir; });
  for (const type of ["pointerup", "pointercancel"])
    el.addEventListener(type, () => { if (rollHeld === dir) rollHeld = 0; });
}

// Once a frame, before the world steps: the keys and the stick, added up
// into the helm's three axes and the throttle lever's travel
function readHelm() {
  const axis = (plus, minus) => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
  const unit = v => Math.max(-1, Math.min(1, v));
  helm.pitch = unit((controls.invert ? -1 : 1) * (axis("KeyS", "KeyW") + stick.y));
  helm.yaw = unit(axis("KeyD", "KeyA") + stick.x);
  helm.roll = unit(axis("KeyE", "KeyQ") + rollHeld);
  helm.leverRate = unit(axis("KeyR", "KeyF") + axis("ArrowUp", "ArrowDown"));
}

// Once a frame, after it: the helm's panel. Shown while the player has the
// helm; the DOM is only touched when what it shows has changed.
const hudShown = {};
function setHud(key, value, apply) {
  if (hudShown[key] === value) return;
  hudShown[key] = value;
  apply(value);
}
function updateHud(ship) {
  setHud("hidden", !ship.helm, v => { helmHud.hidden = v; });
  if (!ship.helm) return;
  const mode = ship.warp.state === "on" ? "Warp" : ship.warp.state === "charge" ? "Charging" : "Impulse";
  setHud("mode", mode, v => { helmEls.helmMode.textContent = v; });
  setHud("speed", ship.speed.toFixed(1), v => { helmEls.helmSpeed.textContent = v; });
  setHud("lever", helm.lever.toFixed(2), v => { helmEls.throttle.value = v; });
  setHud("warp", ship.warp.state !== "off", v => { helmEls.warpButton.setAttribute("aria-pressed", v); });

  let escort = null;
  if (typeof world !== "undefined" && world.entities) {
    for (let i = 0; i < world.entities.length; i++) {
      const ent = world.entities[i];
      if (ent === world.player) continue;
      if (ent.role === "wingman") { escort = ent; break; }
      if (!escort) escort = ent;
    }
  }
  const hasWingman = escort !== null;
  if (helmEls.wingmanButton) {
    setHud("wingman", hasWingman, v => {
      helmEls.wingmanButton.setAttribute("aria-pressed", v);
    });
  }
  if (helmEls.helmTarget) {
    if (escort) {
      const dx = escort.pos[0] - ship.pos[0];
      const dy = escort.pos[1] - ship.pos[1];
      const dz = escort.pos[2] - ship.pos[2];
      const dist = Math.hypot(dx, dy, dz);
      const st = escort.rail ? "ORBIT" : (escort.warp && escort.warp.state === "on") ? "WARP" : (escort.warp && escort.warp.state === "charge") ? "CHARGE" : (dist < 6 ? "ESCORT" : "PURSUIT");
      setHud("tgtText", `TGT ${dist.toFixed(1)}U ${st}`, v => {
        helmEls.helmTarget.textContent = v;
        helmEls.helmTarget.hidden = false;
      });
    } else {
      setHud("tgtText", "", () => { helmEls.helmTarget.hidden = true; });
    }
  }
}

// The button is held back until the viewer has had a moment with the scene.
// It fades in (index.html) once any of these is met since the scene started:
//   after   seconds of scene time
//   clicks  presses anywhere on the page
//   holdMs  ms of the left button held down in total, across presses -- so
//           dragging to look around brings it up too
// A reset hides it again and starts every count over.
const REVEAL = { after: 10, clicks: 3, holdMs: 1500 };
const reveal = { shown: false, clicks: 0, heldMs: 0, holdStart: null };
function endHold() {
  if (reveal.holdStart === null) return;
  reveal.heldMs += performance.now() - reveal.holdStart;
  reveal.holdStart = null;
}
// The hold follows the left button's own bit in e.buttons. With another button
// already down, pressing or releasing the left one fires pointermove rather
// than pointerdown or pointerup, and the last pointerup names whichever button
// went up last, so e.button alone would lose track of it.
function trackHold(e) {
  if (!(e.buttons & 1)) endHold();
  else if (reveal.holdStart === null) reveal.holdStart = performance.now();
}
window.addEventListener("pointerdown", e => { reveal.clicks++; trackHold(e); });
window.addEventListener("pointermove", trackHold);
window.addEventListener("pointerup", trackHold);
window.addEventListener("pointercancel", endHold);
window.addEventListener("blur", endHold);

function resetReveal() {
  reveal.shown = false;
  reveal.clicks = 0;
  reveal.heldMs = 0;
  // A hold that spans the reset counts only from here on
  if (reveal.holdStart !== null) reveal.holdStart = performance.now();
  engageButton.classList.remove("revealed");
}
function updateReveal(t) {
  if (reveal.shown) return;
  const held = reveal.heldMs +
    (reveal.holdStart === null ? 0 : performance.now() - reveal.holdStart);
  if (t >= REVEAL.after || reveal.clicks >= REVEAL.clicks || held > REVEAL.holdMs) {
    reveal.shown = true;
    engageButton.classList.add("revealed");
  }
}

// The two washes over the canvas (index.html), set once a frame:
//   flash  white-blue, at the jump to warp: up in FLASH.rise, then dying away
//          over FLASH.decay -- it covers the instant the lens starts to open
//   fade   black, out over FADE.out before a reset and back in over FADE.in
//          after one (and on page load)
const FLASH = { peak: 0.9, rise: 0.05, decay: 0.16 };
const FADE = { out: 0.45, in: 0.7 };
const warpFlash = document.getElementById("warpFlash");
const fade = document.getElementById("fade");
function setWash(el, v) {
  const s = v.toFixed(3);
  if (el.style.opacity !== s) el.style.opacity = s;
}
function updateWashes(t, ship) {
  const w = ship.warp.state === "on" ? ship.warp.tau : null;
  setWash(warpFlash, w === null ? 0 : FLASH.peak *
    (w < FLASH.rise ? w / FLASH.rise : Math.exp(-(w - FLASH.rise) / FLASH.decay)));
  const out = world.resetAt === null ? 0 : smootherstep((t - (world.resetAt - FADE.out)) / FADE.out);
  setWash(fade, Math.max(out, 1 - smootherstep(t / FADE.in)));
}

// Everything back the way the page loaded: the ship on its circle, the free
// camera's controls, and a fresh scene clock starting at `time`. The chase
// camera lets go by itself once the ship is back in orbit (camera.js).
function resetScene(time) {
  dragRotX = 0.35; dragRotY = -0.5;
  camX = 0; camY = 0;
  resetFreeCamera();
  sceneStart = time;
  resetWorld();
  const toggleEl = document.getElementById("wingmanToggle");
  const wantsWingman = (toggleEl && toggleEl.checked) || presets.has("wingman") || Number(presets.get("ships")) > 1;
  const shipCount = Math.max(1, Math.min(MAX_INSTANCES - 2, Number(presets.get("ships") || (wantsWingman ? 2 : 1))));
  for (let s = 1; s < shipCount; s++) {
    addEntity({ model: "galaxy", rail: companionOrbitPose(s * 0.45), role: "wingman" });
  }
  if (toggleEl) toggleEl.checked = shipCount > 1;
  if (helmEls.wingmanButton) helmEls.wingmanButton.setAttribute("aria-pressed", shipCount > 1);
  for (const k in hudShown) delete hudShown[k];
  held.clear();
  dropStick();
  rollHeld = 0;
  resetReveal();
}
resetScene(0);

const lightPosBuf = new Float32Array(9);
const lightColBuf = new Float32Array(9);
const lightRngBuf = new Float32Array(6);

// Hand this frame's scene, lights, lens and controls to the shader
function uploadScene(view, t, ship) {
  const u = uniforms;
  gl.uniform2f(u.uResolution, canvas.width, canvas.height);
  gl.uniform1f(u.uProj00, projection[0]);
  gl.uniform1f(u.uProj11, projection[5]);
  gl.uniform1f(u.uFisheye, lensFisheye);
  gl.uniform1f(u.uFishHalfX, CHASE.fishHalfX);
  gl.uniform1f(u.uFishStretch, CHASE.fishStretch);
  gl.uniform1f(u.uFishPivot, CHASE.fishPivot);
  const pixel = pixelAngle();
  gl.uniform1f(u.uPixelAngle, pixel);

  for (let i = 0; i < scene.count; i++) {
    if (scene.matB[i * 4 + 1] > 0) {
      scene.matB[i * 4 + 2] = controls.ior;
    }
  }

  gl.uniform1i(u.uInstCount, scene.instCount);
  gl.uniform1i(u.uCount, scene.count);
  gl.uniform1i(u.uGroupCount, scene.groupCount);
  gl.bindBuffer(gl.UNIFORM_BUFFER, sceneBuffer);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, sceneBytes);

  // The fixed lights ride whatever the view is now; the nav light was placed
  // in eye space by the ship itself
  const sx = SUN.pos[0], sy = SUN.pos[1], sz = SUN.pos[2];
  const sw = view[3] * sx + view[7] * sy + view[11] * sz + view[15];
  lightPosBuf[0] = (view[0] * sx + view[4] * sy + view[8] * sz + view[12]) / sw;
  lightPosBuf[1] = (view[1] * sx + view[5] * sy + view[9] * sz + view[13]) / sw;
  lightPosBuf[2] = (view[2] * sx + view[6] * sy + view[10] * sz + view[14]) / sw;

  const fx = FILL.pos[0], fy = FILL.pos[1], fz = FILL.pos[2];
  const fw = view[3] * fx + view[7] * fy + view[11] * fz + view[15];
  lightPosBuf[3] = (view[0] * fx + view[4] * fy + view[8] * fz + view[12]) / fw;
  lightPosBuf[4] = (view[1] * fx + view[5] * fy + view[9] * fz + view[13]) / fw;
  lightPosBuf[5] = (view[2] * fx + view[6] * fy + view[10] * fz + view[14]) / fw;
  lightPosBuf[6] = scene.nav[0]; lightPosBuf[7] = scene.nav[1]; lightPosBuf[8] = scene.nav[2];
  gl.uniform3fv(u.uLightPos, lightPosBuf);

  lightColBuf[0] = SUN.color[0] * controls.sun; lightColBuf[1] = SUN.color[1] * controls.sun; lightColBuf[2] = SUN.color[2] * controls.sun;
  lightColBuf[3] = FILL.color[0] * controls.fill; lightColBuf[4] = FILL.color[1] * controls.fill; lightColBuf[5] = FILL.color[2] * controls.fill;
  lightColBuf[6] = NAV.color[0] * controls.nav; lightColBuf[7] = NAV.color[1] * controls.nav; lightColBuf[8] = NAV.color[2] * controls.nav;
  gl.uniform3fv(u.uLightColor, lightColBuf);

  lightRngBuf[0] = SUN.ref; lightRngBuf[1] = SUN.reach;
  lightRngBuf[2] = FILL.ref; lightRngBuf[3] = FILL.reach;
  lightRngBuf[4] = NAV.ref; lightRngBuf[5] = NAV.reach;
  gl.uniform2fv(u.uLightRange, lightRngBuf);

  gl.uniform1i(u.uBounces, controls.bounces);
  gl.uniform1i(u.uShadows, controls.shadows);
  gl.uniform1i(u.uAttenuation, controls.attenuation);
  gl.uniform1f(u.uShininessScale, controls.shininess);
  gl.uniform1f(u.uTime, t);

  gl.uniform3fv(u.uSkyCenter, scene.sky.center);
  gl.uniformMatrix3fv(u.uSkyRot, false, scene.sky.rot);
  gl.uniform3fv(u.uStreak, scene.sky.streak);
  gl.uniform1f(u.uShutter, STREAK.shutter);
  gl.uniform1f(u.uMaxStreak, STREAK.max * renderScale * pixel);
  gl.uniform1f(u.uStreakDim, STREAK.dim);
  gl.uniform1f(u.uStarScale, renderScale);
  const fade = ship.warpLevel;
  gl.uniform1f(u.uWarpStars, fade * fade * (3 - 2 * fade));
}

// A frame comes in two halves, so each can be run and timed alone (bench.js):
//
//   stepFrame    everything that moves: the world, the camera, the engines.
//                `now` is real time in seconds, dt the time since the last
//                step. Returns what the frame is of.
//   buildScene   walks the hierarchy for that state to collect the frame's
//                primitives and hands them, with the lights and the lens, to
//                the shader; one gl.drawArrays then traces it. `live` also
//                pulls the next frame of the plasma video.
const dragAngles = { x: 0, y: 0 };
const STEP_FRAME_RESULT = { t: 0, ship: null, view: null };
const FREE_ROT_Y = new Float32Array(16);
const FREE_ROT_X = new Float32Array(16);
const FREE_ROT_MAT = new Float32Array(16);
FREE_ROT_Y[15] = 1;
FREE_ROT_X[15] = 1;

function setRotateY(a, m) {
  const c = Math.cos(a), s = Math.sin(a);
  m[0] = c; m[1] = 0; m[2] = -s; m[3] = 0;
  m[4] = 0; m[5] = 1; m[6] = 0;  m[7] = 0;
  m[8] = s; m[9] = 0; m[10] = c; m[11] = 0;
  m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
  return m;
}
function setRotateX(a, m) {
  const c = Math.cos(a), s = Math.sin(a);
  m[0] = 1; m[1] = 0; m[2] = 0;  m[3] = 0;
  m[4] = 0; m[5] = c; m[6] = s;  m[7] = 0;
  m[8] = 0; m[9] = -s; m[10] = c; m[11] = 0;
  m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
  return m;
}

function stepFrame(now, dt) {
  if (resetDue(now - sceneStart)) resetScene(now);
  const t = sceneT = now - sceneStart;   // scene clock

  const rotation = multiplyInto(setRotateY(dragRotY, FREE_ROT_Y), setRotateX(dragRotX, FREE_ROT_X), FREE_ROT_MAT);

  // The world is advanced first, because the camera needs to know where the
  // ship is before anything is drawn.
  readHelm();
  const ship = advanceWorld(t, dt);
  const moon = moonCenter(t);
  dragAngles.x = dragRotX; dragAngles.y = dragRotY;
  const view = updateCamera(t, dt, ship, freeView(now, dt, ship, moon, rotation, camX, camY),
    dragAngles);
  lastView = view; lastShip = ship; lastMoon = moon;
  updateEngines(t, dt, ship);
  STEP_FRAME_RESULT.t = t;
  STEP_FRAME_RESULT.ship = ship;
  STEP_FRAME_RESULT.view = view;
  return STEP_FRAME_RESULT;
}

function buildScene({ t, ship, view }, live) {
  scene.instCount = 0;
  drawSystem(view, t, ship);
  if (live) {
    plasma.setRate(engines.plasmaRate);
    plasma.update();
  }
  bindTextures();
  uploadScene(view, t, ship);
}

// Render loop. With an FPS cap, display refreshes that come too soon after the
// last frame drawn are skipped. The schedule advances a whole interval per
// frame drawn, so a cap that doesn't divide the refresh rate still averages
// out to it, but never runs ahead of the clock or more than a frame behind.
let lastNow = 0, lastDrawTime = 0;
function render(time) {
  if (window.benchRunning) return;
  if (controls.fps) {
    const interval = 1000 / controls.fps, elapsed = time - lastDrawTime;
    if (elapsed < interval - 1) { requestAnimationFrame(render); return; }
    lastDrawTime = Math.min(time, Math.max(lastDrawTime + interval, time - interval));
  }
  const frameStart = performance.now();
  const frameDelta = lastRafTime ? Math.min(time - lastRafTime, 200) : 16.67;
  lastRafTime = time;

  pollGpuTimer();

  const now = time / 1000;
  const dt = Math.min(now - lastNow, 0.1);   // capped, so a stalled tab doesn't lurch
  lastNow = now;
  const frame = stepFrame(now, dt);
  const { t, ship } = frame;
  buildScene(frame, true);

  beginGpuTimer();
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  endGpuTimer();

  updateWashes(t, ship);
  updateReveal(t);
  engageButton.disabled = offOrbit();
  updateHud(ship);

  const cpuMs = performance.now() - frameStart;
  updateStats(time, frameDelta, cpuMs, ship);
  adaptResolution(now, frameDelta);

  requestAnimationFrame(render);
}

window.stepFrame = stepFrame;
window.buildScene = buildScene;
window.setDrawingSize = setDrawingSize;
window.setResolution = setResolution;
window.getRenderScale = () => renderScale;
window.assetsReady = assetsReady;
window.render = render;
window.benchRunning = false;

// ?bench runs the benchmark instead of the live loop (bench.js)
if (!presets.has("bench")) requestAnimationFrame(render);
