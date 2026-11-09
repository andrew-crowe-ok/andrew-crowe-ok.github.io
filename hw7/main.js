// WebGL setup
const canvas = document.getElementById("glcanvas");

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
const NAV = { color: [0.35, 0.62, 1.0], ref: 0.5, reach: 1e6 };

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
const coneMesh = { shape: CONE, repeats: 1 };
const torusMesh = { shape: TORUS, repeats: 24, tube: 0.04 };   // saucer rim
const sphereMesh = { shape: SPHERE, repeats: 1 };
const planetMesh = sphereMesh;

// Shiny painted metal, for parts that don't name a material of their own.
//   kr      share of light mirrored (reflection rays)
//   kt      share let through (glass: refraction rays)
//   ior     index of refraction, for glass
//   absorb  glass's absorption per unit length (Beer-Lambert), per channel
const DEFAULT_MATERIAL = { ka: 0.2, kd: 0.8, ks: 0.5, shininess: 32, bumpScale: 3.0, atmosphere: [0, 0, 0] };

const scene = {
  count: 0,
  inv: new Float32Array(MAX_PRIMS * 12),
  info: new Int32Array(MAX_PRIMS * 4),
  matA: new Float32Array(MAX_PRIMS * 4),
  matB: new Float32Array(MAX_PRIMS * 4),
  matC: new Float32Array(MAX_PRIMS * 4),
  matD: new Float32Array(MAX_PRIMS * 4),
  group: { start: 0, end: 0, inv: new Float32Array(12), half: [0, 0, 0] },
  nav: [0, 0, 0],
  sky: { center: [0, 0, 0], rot: new Float32Array(9), streak: [0, 0, 0] }
};

// The three rows of an affine matrix, which is all the shader needs of it
function affineRows(m, out, at) {
  for (let i = 0; i < 3; i++) out.set([m[i], m[4 + i], m[8 + i], m[12 + i]], at + 4 * i);
}

const unitOf = texture => texture ? TEXTURES.indexOf(texture) : -1;

function drawPrimitive(mesh, texture, mapping, modelView, material = DEFAULT_MATERIAL, normalMap = null) {
  if (scene.count >= MAX_PRIMS) throw new Error(`more than ${MAX_PRIMS} primitives`);
  const i = scene.count++;
  const { ka, kd, ks, shininess, bumpScale, atmosphere, kr = 0, kt = 0, absorb = [0, 0, 0] } = material;
  // Every glass part takes its index of refraction from the slider
  const ior = kt > 0 ? controls.ior : 1;
  affineRows(invertAffine(modelView), scene.inv, i * 12);
  scene.info.set([mesh.shape, unitOf(texture), unitOf(normalMap), mapping], i * 4);
  scene.matA.set([ka, kd, ks, shininess], i * 4);
  scene.matB.set([kr, kt, ior, bumpScale], i * 4);
  scene.matC.set([...atmosphere, mesh.tube ?? 0], i * 4);
  scene.matD.set([...absorb, mesh.repeats], i * 4);
}

// The parts drawn between these two calls fit in the box |p| <= half in
// `frame`'s space, so the shader can skip them all for a ray that misses it
function beginGroup(frame, half) {
  scene.group.start = scene.count;
  affineRows(invertAffine(frame), scene.group.inv, 0);
  scene.group.half = half;
}
function endGroup() { scene.group.end = scene.count; }

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
  };
  image.src = url;
  return texture;
}

const planetTexture = loadTexture("textures/antelope.jpg");
const copperTexture = loadTexture("textures/mars2.jpg");   // deflector dish

// Upload a procedurally generated image (RGBA bytes from textures.js). No flip:
// the generators already work in texture coordinates, with v = 0 at the bottom.
function createDataTexture({ color, size }) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, color);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  return texture;
}

// Procedural ship skin. The saucer is bump mapped straight from its panel-line
// image; the hull and nacelles get a color map with a normal map baked from
// the same height field (NORMAL_MAPPING).
const hullPlating = createPlating({ cols: 8, rows: 12, seed: 11,
  stripe: { at: 0.5, width: 0.07, color: [0.20, 0.23, 0.30], relief: 0.08 } });
const nacellePlating = createPlating({ cols: 6, rows: 16, seed: 23,
  base: [0.34, 0.37, 0.43],
  grille: { at: 0.5, width: 0.22, slats: 18, color: [0.13, 0.21, 0.42] } });

const saucerTexture = createDataTexture(createSaucerTexture());
const hullTexture = createDataTexture(hullPlating);
const hullNormalMap = createDataTexture(normalMap(hullPlating, 7));
const nacelleTexture = createDataTexture(nacellePlating);
const nacelleNormalMap = createDataTexture(normalMap(nacellePlating, 8));
// The nav light's bulb: one flat color, drawn glowing
const beaconTexture = createDataTexture({ color: new Uint8Array([150, 205, 255, 255]), size: 1 });

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
  return { texture, update };
}

const plasma = loadVideoTexture(["textures/plasma.webm", "textures/plasma.mp4"]);

// Unit i holds TEXTURES[i] (raytrace.js samples them by unit)
const TEXTURES = [planetTexture, copperTexture, saucerTexture, hullTexture, hullNormalMap,
  nacelleTexture, nacelleNormalMap, plasma.texture, beaconTexture];
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
// a ray tree, so the drawing buffer is capped at about 1080p's pixel count and
// the browser scales it up past that.
const BASE_FOVY = Math.PI / 4, MIN_ASPECT = 1.6;
const MAX_PIXELS = 1920 * 1080;
let projection, renderScale = 1;
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const css = canvas.clientWidth * canvas.clientHeight;
  renderScale = Math.min(dpr, Math.sqrt(MAX_PIXELS / Math.max(css, 1)));
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

// The angle one pixel spans mid-frame, which sizes the stars and picks
// mipmap levels: the plain lens's, blended toward the fisheye's as it opens
function pixelAngle() {
  const rect = 2 / (projection[5] * canvas.height);
  const fish = 4 * Math.sin(CHASE.fishHalfX / 2) / canvas.width;
  return rect + (fish - rect) * lensFisheye;
}

// ---------------------------------------------------------------------------
// Ray tracer controls (index.html)
// ---------------------------------------------------------------------------
const controls = {};
const CONTROL_INPUTS = {
  bounces:     { read: el => parseInt(el.value), show: v => `${v}` },
  sun:         { read: el => parseFloat(el.value), show: v => v.toFixed(2) },
  fill:        { read: el => parseFloat(el.value), show: v => v.toFixed(2) },
  nav:         { read: el => parseFloat(el.value), show: v => v.toFixed(2) },
  shininess:   { read: el => 2 ** parseFloat(el.value), show: v => `×${v.toFixed(2)}` },
  ior:         { read: el => parseFloat(el.value), show: v => v.toFixed(2) },
  shadows:     { read: el => el.checked },
  attenuation: { read: el => el.checked }
};
// The page's query string can preset any of them, e.g. ?bounces=0&shadows=0
const presets = new URLSearchParams(location.search);
for (const [id, { read, show }] of Object.entries(CONTROL_INPUTS)) {
  const input = document.getElementById(id);
  const output = document.querySelector(`output[for="${id}"]`);
  if (presets.has(id)) {
    if (input.type === "checkbox") input.checked = presets.get(id) !== "0";
    else input.value = presets.get(id);
  }
  const update = () => {
    controls[id] = read(input);
    if (output && show) output.textContent = show(controls[id]);
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

// A press that strays more than CLICK_SLOP pixels from where it started is a
// drag, even if it comes back, and its release is not a click
const CLICK_SLOP = 5;
let mouseDown = false, dragged = false, lastX, lastY, pressX, pressY;
canvas.addEventListener("mousedown", e => {
  mouseDown = true; dragged = false;
  lastX = pressX = e.clientX; lastY = pressY = e.clientY;
});
window.addEventListener("mouseup", () => mouseDown = false);
window.addEventListener("mousemove", e => {
  if (!mouseDown) return;
  dragRotY += (e.clientX - lastX) * 0.01;
  dragRotX += (e.clientY - lastY) * 0.01;
  lastX = e.clientX; lastY = e.clientY;
  if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > CLICK_SLOP) dragged = true;
});

const CONTROL_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "s"];
document.addEventListener("keydown", e => {
  if (!CONTROL_KEYS.includes(e.key)) return;
  // Arrows on a focused slider move the slider, not the camera
  if (e.target instanceof HTMLInputElement) return;
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
  gl.uniform4fv(u.uInv, scene.inv);
  gl.uniform4iv(u.uInfo, scene.info);
  gl.uniform4fv(u.uMatA, scene.matA);
  gl.uniform4fv(u.uMatB, scene.matB);
  gl.uniform4fv(u.uMatC, scene.matC);
  gl.uniform4fv(u.uMatD, scene.matD);
  gl.uniform1i(u.uGroupStart, scene.group.start);
  gl.uniform1i(u.uGroupEnd, scene.group.end);
  gl.uniform4fv(u.uGroupInv, scene.group.inv);
  gl.uniform3fv(u.uGroupHalf, scene.group.half);

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
  drawSystem(view, t, ship);
  plasma.update();
  bindTextures();
  uploadScene(view, t);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  updateWashes(t, ship);
  updateReveal(t);
  engageButton.disabled = offOrbit();
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
