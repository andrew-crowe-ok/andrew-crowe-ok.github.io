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
window.addEventListener("error", e => showError(`The ray tracer stopped: ${e.message}`));
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
const SCENE_BLOCK = { inv: 3 * MAX_PRIMS, info: MAX_PRIMS, matA: MAX_PRIMS, matB: MAX_PRIMS,
  matC: MAX_PRIMS, matD: MAX_PRIMS, matE: MAX_PRIMS, groupInv: 3 * MAX_GROUPS, groupHalf: MAX_GROUPS, groupRange: MAX_GROUPS };
const sceneBytes = new ArrayBuffer(16 * Object.values(SCENE_BLOCK).reduce((a, n) => a + n, 0));

const scene = {
  count: 0,
  groupCount: 0,
  nav: [0, 0, 0],
  sky: { center: [0, 0, 0], rot: new Float32Array(9), streak: [0, 0, 0] }
};
let blockAt = 0;
for (const [name, vec4s] of Object.entries(SCENE_BLOCK)) {
  scene[name] = new (name === "info" || name === "groupRange" ? Int32Array : Float32Array)(sceneBytes, 16 * blockAt, 4 * vec4s);
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

// The three rows of an affine matrix, which is all the shader needs of it
function affineRows(m, out, at) {
  for (let i = 0; i < 3; i++) out.set([m[i], m[4 + i], m[8 + i], m[12 + i]], at + 4 * i);
}

const unitOf = texture => texture ? TEXTURES.indexOf(texture) : -1;

function drawPrimitive(mesh, texture, mapping, modelView, material = DEFAULT_MATERIAL, normalMap = null) {
  if (scene.count >= MAX_PRIMS) throw new Error(`more than ${MAX_PRIMS} primitives`);
  const i = scene.count++;
  const { ka, kd, ks, shininess, bumpScale, atmosphere, kr = 0, kt = 0, absorb = [0, 0, 0], glow = 0,
    power = 1, scroll = 0 } = material;
  // Every glass part takes its index of refraction from the slider
  const ior = kt > 0 ? controls.ior : 1;
  affineRows(invertAffine(modelView), scene.inv, i * 12);
  scene.info.set([mesh.shape, unitOf(texture), unitOf(normalMap), mapping], i * 4);
  scene.matA.set([ka, kd, ks, shininess], i * 4);
  scene.matB.set([kr, kt, ior, bumpScale], i * 4);
  scene.matC.set([...atmosphere, mesh.tube ?? 0], i * 4);
  scene.matD.set([...absorb, mesh.repeats], i * 4);
  scene.matE.set([glow, group ? group.index : -1, power, scroll], i * 4);
  if (group) fitGroup(mesh, modelView);
}

// The parts drawn between beginGroup(frame) and endGroup() are boxed together,
// so the shader can skip them all for a ray that misses the box. The box is
// aligned with frame and fitted as they're drawn: each part's unit shape fits
// in a box of its own (|p| <= 1, or the torus's ring plus tube), and that
// box's corners, carried into frame's space, bound the part there.
let group = null;
function beginGroup(frame) {
  if (group) throw new Error("groups don't nest");
  if (scene.groupCount >= MAX_GROUPS) throw new Error(`more than ${MAX_GROUPS} groups`);
  group = { index: scene.groupCount++, toFrame: invertAffine(frame),
    min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
    start: scene.count };
}
function fitGroup(mesh, modelView) {
  const toFrame = multiply(group.toFrame, modelView);
  const r = mesh.shape === TORUS ? 1 + mesh.tube : 1, h = mesh.shape === TORUS ? mesh.tube : 1;
  for (const x of [-r, r]) for (const y of [-h, h]) for (const z of [-r, r]) {
    const p = transformPoint(toFrame, [x, y, z]);
    group.min = group.min.map((m, k) => Math.min(m, p[k]));
    group.max = group.max.map((m, k) => Math.max(m, p[k]));
  }
}
// The box's matrix takes eye space to the box's own, centered on it
function endGroup() {
  const center = vmul(vadd(group.min, group.max), 0.5);
  affineRows(multiply(translate(...vmul(center, -1)), group.toFrame), scene.groupInv, 12 * group.index);
  scene.groupHalf.set([...vmul(vsub(group.max, group.min), 0.5), 0], 4 * group.index);
  scene.groupRange.set([group.start, scene.count, 0, 0], 4 * group.index);
  group = null;
}

// The ship's own light, in eye space (ship.js)
function setNavLight(pos) { scene.nav = pos; }

// The sky's frame (scene.js): where its center is and how it is turned, in
// eye space, and the stars' velocity past the eye at warp
function setSky(frame, streak) {
  scene.sky.center = transformPoint(frame, [0, 0, 0]);
  scene.sky.rot.set([frame[0], frame[1], frame[2], frame[4], frame[5], frame[6], frame[8], frame[9], frame[10]]);
  scene.sky.streak = streak;
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

// Anisotropic filtering keeps textures sharp on surfaces seen at a slant
// (raytrace.js filters by the footprint's two axes, which brings it into play)
const ANISO = gl.getExtension("EXT_texture_filter_anisotropic");
const MAX_ANISO = ANISO ? gl.getParameter(ANISO.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;

// An image file: a 1x1 gray placeholder until it decodes, then the image with mipmaps
function loadTexture(url) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
  // A mipmap filter on a texture with no mipmaps is incomplete and samples as black
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

  const image = new Image();
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
  Object.assign(video, { muted: true, loop: true, playsInline: true, autoplay: true, crossOrigin: "anonymous" });
  video.src = sources.find(src => video.canPlayType(src.endsWith(".webm") ? "video/webm" : "video/mp4")) ?? sources[0];
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

// ---------------------------------------------------------------------------
// Canvas and lens
// ---------------------------------------------------------------------------

// Full-window canvas, kept framed as in HW6: vertical FOV 45 deg, widened on
// windows narrower than 16:10 so the whole orbit stays in frame. Every pixel is
// a ray tree, so the drawing buffer is capped at about 1080p's pixel count
// (a quarter of that on phones) and the browser scales it up past that.
//
// On phones the cap also adapts: every ADAPT.window seconds the mean frame time
// is checked, and the pixel budget shrinks by ADAPT.step while frames run slower
// than ADAPT.slow, or grows back toward the cap while they run faster than
// ADAPT.fast, never below ADAPT.floor of it.
const BASE_FOVY = Math.PI / 4, MIN_ASPECT = 1.6;
const MAX_PIXELS = MOBILE ? 960 * 540 : 1920 * 1080;
const ADAPT = { window: 1.0, slow: 45, fast: 24, step: 0.8, floor: 0.25 };
let pixelBudget = 1;   // share of MAX_PIXELS in use
let projection, renderScale = 1;
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const css = canvas.clientWidth * canvas.clientHeight;
  renderScale = Math.min(dpr, Math.sqrt(MAX_PIXELS * pixelBudget / Math.max(css, 1)));
  canvas.width = Math.round(canvas.clientWidth * renderScale);
  canvas.height = Math.round(canvas.clientHeight * renderScale);
  gl.viewport(0, 0, canvas.width, canvas.height);
  const aspect = canvas.width / canvas.height;
  const fovy = aspect >= MIN_ASPECT ? BASE_FOVY
    : 2 * Math.atan(Math.tan(BASE_FOVY / 2) * MIN_ASPECT / aspect);
  projection = perspective(fovy, aspect, 0.1, 150);   // only its x and y scales matter now
}
window.addEventListener("resize", resize);
resize();

const adapt = { t0: null, frames: 0, ms: 0 };
function adaptResolution(now, frameMs) {
  if (!MOBILE) return;
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
      statEls.prims.textContent = `${scene.count} (${scene.groupCount} grp)`;
    }
    if (statEls.bounces) {
      const sh = controls.shadows ? "+shd" : "";
      const at = controls.attenuation ? "+atn" : "";
      statEls.bounces.textContent = `${controls.bounces} ${sh} ${at}`.trim();
    }
    if (statEls.phase) {
      const phase = ship.warpTau !== null ? "WARP" : offOrbit() ? "DEPART" : "ORBIT";
      statEls.phase.textContent = phase;
      statEls.phase.classList.toggle("warp", phase === "WARP");
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
  stats:       { read: el => el.checked }
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

// Engage. The press is handled on the next frame, where the clock is known
// (scene.js), and the button stays down until the scene resets.
const engageButton = document.getElementById("engageButton");
engageButton.addEventListener("click", requestEngage);

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
  const w = ship.warpTau;
  setWash(warpFlash, w === null ? 0 : FLASH.peak *
    (w < FLASH.rise ? w / FLASH.rise : Math.exp(-(w - FLASH.rise) / FLASH.decay)));
  const e = engageElapsed(t);
  const out = e === null ? 0 : smootherstep((e - (ENGAGE.reset - FADE.out)) / FADE.out);
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
  resetFlight();
  resetReveal();
}
resetScene(0);

// Hand this frame's scene, lights, lens and controls to the shader
function uploadScene(view, t) {
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

  gl.uniform1i(u.uCount, scene.count);
  gl.uniform1i(u.uGroupCount, scene.groupCount);
  gl.bindBuffer(gl.UNIFORM_BUFFER, sceneBuffer);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, sceneBytes);

  // The fixed lights ride whatever the view is now; the nav light was placed
  // in eye space by the ship itself
  gl.uniform3fv(u.uLightPos, [...transformPoint(view, SUN.pos), ...transformPoint(view, FILL.pos), ...scene.nav]);
  gl.uniform3fv(u.uLightColor, [...vmul(SUN.color, controls.sun), ...vmul(FILL.color, controls.fill),
    ...vmul(NAV.color, controls.nav)]);
  gl.uniform2fv(u.uLightRange, [SUN, FILL, NAV].flatMap(l => [l.ref, l.reach]));

  gl.uniform1i(u.uBounces, controls.bounces);
  gl.uniform1i(u.uShadows, controls.shadows);
  gl.uniform1i(u.uAttenuation, controls.attenuation);
  gl.uniform1f(u.uShininessScale, controls.shininess);
  gl.uniform1f(u.uTime, t);

  gl.uniform3fv(u.uSkyCenter, scene.sky.center);
  gl.uniformMatrix3fv(u.uSkyRot, false, scene.sky.rot);
  gl.uniform1f(u.uSkyRadius, SKY_RADIUS);
  gl.uniform3fv(u.uStreak, scene.sky.streak);
  gl.uniform1f(u.uShutter, STREAK.shutter);
  gl.uniform1f(u.uMaxStreak, STREAK.max * renderScale * pixel);
  gl.uniform1f(u.uStreakDim, STREAK.dim);
  gl.uniform1f(u.uStarScale, renderScale);
}

// Render loop
let lastNow = 0;
function render(time) {
  const frameStart = performance.now();
  const frameDelta = lastRafTime ? Math.min(time - lastRafTime, 200) : 16.67;
  lastRafTime = time;

  pollGpuTimer();

  const now = time / 1000;
  const dt = Math.min(now - lastNow, 0.1);   // capped, so a stalled tab doesn't lurch
  lastNow = now;
  if (engageExpired(now - sceneStart)) resetScene(now);
  const t = now - sceneStart;   // scene clock

  const rotation = multiply(rotateY(dragRotY), rotateX(dragRotX));

  // The flight path is advanced once, here, because the camera needs to know
  // where the ship is before anything is drawn.
  const ship = shipState(t);
  const moon = moonCenter(t);
  const view = updateCamera(t, ship, freeView(now, dt, ship, moon, rotation, [camX, camY]),
    { x: dragRotX, y: dragRotY });
  lastView = view; lastShip = ship; lastMoon = moon;

  // Walk the hierarchy to collect this frame's primitives, then trace them all
  scene.count = 0;
  scene.groupCount = 0;
  updateEngines(t, dt);
  drawSystem(view, t, ship);
  plasma.setRate(engines.plasmaRate);
  plasma.update();
  bindTextures();
  uploadScene(view, t);

  beginGpuTimer();
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  endGpuTimer();

  updateWashes(t, ship);
  updateReveal(t);
  engageButton.disabled = offOrbit();

  const cpuMs = performance.now() - frameStart;
  updateStats(time, frameDelta, cpuMs, ship);
  adaptResolution(now, frameDelta);

  requestAnimationFrame(render);
}
requestAnimationFrame(render);
