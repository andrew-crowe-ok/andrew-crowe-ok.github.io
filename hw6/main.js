// The scene's two shaders, as they appear in the live GLSL editor (#shaderBox).
// "#version 300 es" and, for the vertex shader, the lens code from camera.js
// (LENS_GLSL) are prepended when the program is linked (useSceneProgram).
const VERTEX_SHADER = `in vec3 aPosition;
in vec3 aNormal;
in vec3 aTangent;
in vec2 aTexCoord;

uniform mat4 uModelView;
uniform mat4 uProjection;
// project() and the lens uniforms uFisheye, uFishHalfX, uFishStretch and
// uFishPivot are prepended from camera.js

out vec3 vPosition;
out vec3 vNormal;
out vec3 vTangent;
out vec2 vTexCoord;

void main() {
  vec4 p = uModelView * vec4(aPosition, 1.0);
  vPosition = p.xyz;

  // Normals take the inverse transpose, since parts are scaled non-uniformly;
  // tangents lie in the surface and take the matrix itself
  mat3 mv = mat3(uModelView);
  vNormal = transpose(inverse(mv)) * aNormal;
  vTangent = mv * aTangent;
  vTexCoord = aTexCoord;
  // The lens is rectilinear until the chase camera opens it out (camera.js)
  gl_Position = project(uProjection, p);
}
`;

const FRAGMENT_SHADER = `precision mediump float;

in vec3 vPosition;
in vec3 vNormal;
in vec3 vTangent;
in vec2 vTexCoord;

// Two lights, as in HW 5: a warm sun and a dim cool fill from the opposite side
uniform vec3 uLightPos;     // view space
uniform vec3 uLight2Pos;
uniform vec3 uLightColor;
uniform vec3 uLight2Color;

// Per-object material, set by drawPrimitive
uniform float uKa, uKd, uKs, uShininess;
uniform float uBumpScale;
uniform vec3 uAtmosphere;   // rim glow color; black = off

uniform sampler2D uTexture;
uniform sampler2D uNormalMap;
// 0 = bump mapping: color from uTexture, relief from its luminance
// 1 = normal mapping: color from uTexture, tangent-space normals from uNormalMap
// 2 = emissive: uTexture's color, unlit
uniform int uMapping;

// Texture-mapping panel (top left), uploaded every frame by main.js
uniform float uTiling;       // UV repeats
uniform vec2 uUVOffset;      // UV scroll, advanced each frame
uniform float uUVWarp;       // amplitude of a sine ripple in the UVs
uniform int uView;           // 0 shaded, 1 texture only, 2 UVs, 3 height, 4 normals
uniform int uRelief;         // 0 as designed, 1 bump map everything, 2 flat
uniform float uBumpGain;     // multiplies each material's uBumpScale
uniform float uBumpWidth;    // bump finite-difference step, in texels
uniform bool uInvertHeight;  // bright is high instead of dark
uniform float uNormalGain;   // tilt of the normal-map normals
uniform bool uFlipGreen;     // DirectX (-Y) normal-map convention

out vec4 fragColor;

// Bump height: dark is high (1 - Rec. 601 luminance); a negative uBumpScale flips it
float height(vec2 uv) {
  float luma = dot(texture(uTexture, uv).rgb, vec3(0.299, 0.587, 0.114));
  return uInvertHeight ? luma : 1.0 - luma;
}

// Phong diffuse + specular from one light; ambient is added once in main()
vec3 phong(vec3 N, vec3 V, vec3 lightPos, vec3 lightColor, vec3 baseColor) {
  vec3 L = normalize(lightPos - vPosition);
  vec3 R = reflect(-L, N);
  float diff = max(dot(N, L), 0.0);
  float spec = diff > 0.0 ? pow(max(dot(V, R), 0.0), uShininess) : 0.0;
  return lightColor * (uKd * baseColor * diff + uKs * spec);
}

void main() {
  // The texture coordinates, tiled, scrolled and rippled by the panel
  vec2 uv = vTexCoord * uTiling + uUVOffset + uUVWarp * sin(vTexCoord.yx * 40.0);
  if (uView == 2) {
    fragColor = vec4(fract(uv), 0.0, 1.0);
    return;
  }
  vec3 baseColor = texture(uTexture, uv).rgb;

  // Emissive: the surface gives off its own light, so skip lighting entirely
  if (uMapping == 2 || uView == 1) {
    fragColor = vec4(baseColor, 1.0);
    return;
  }
  if (uView == 3) {
    fragColor = vec4(vec3(height(uv)), 1.0);
    return;
  }

  // Tangent frame (T, B, N)
  vec3 N = normalize(vNormal);
  vec3 T = normalize(vTangent - dot(vTangent, N) * N);
  vec3 B = cross(N, T);
  mat3 TBN = mat3(T, B, N);

  // Which relief: the part's own, bump mapping for all, or none
  int relief = uRelief == 1 ? 0 : uRelief == 2 ? -1 : uMapping;
  vec3 n = vec3(0.0, 0.0, 1.0);

  if (relief == 0) {
    // Bump mapping: tilt the normal against the gradient of the height field.
    // A wider step averages the slope over more texels; dividing by it keeps
    // the slope per texel, so width softens the relief without deepening it.
    vec2 texel = 1.0 / vec2(textureSize(uTexture, 0));
    vec2 du = vec2(uBumpWidth * texel.x, 0.0);
    vec2 dv = vec2(0.0, uBumpWidth * texel.y);
    float dhdu = (height(uv + du) - height(uv - du)) * 0.5 / uBumpWidth;
    float dhdv = (height(uv + dv) - height(uv - dv)) * 0.5 / uBumpWidth;
    float k = uBumpScale * uBumpGain;
    n = normalize(vec3(-k * dhdu, -k * dhdv, 1.0));
  } else if (relief == 1) {
    // Normal mapping: uNormalMap stores the tangent-space normal in [0, 1],
    // baked from the same height field as uTexture's paint (textures.js)
    n = texture(uNormalMap, uv).rgb * 2.0 - 1.0;
    if (uFlipGreen) n.y = -n.y;
    n = normalize(vec3(n.xy * uNormalGain, n.z));
  }

  vec3 Ngeom = N;              // smooth surface normal, before bump/normal mapping
  N = normalize(TBN * n);
  if (uView == 4) {
    fragColor = vec4(N * 0.5 + 0.5, 1.0);
    return;
  }
  vec3 V = normalize(-vPosition);

  vec3 color = uKa * baseColor
             + phong(N, V, uLightPos, uLightColor, baseColor)
             + phong(N, V, uLight2Pos, uLight2Color, baseColor);

  // Atmosphere: brightens where the surface turns away from the viewer (the
  // limb), using the smooth normal so the halo isn't speckled by the bumps,
  // and only on the sun-facing side
  float rim = pow(1.0 - max(dot(Ngeom, V), 0.0), 3.0);
  float day = smoothstep(-0.25, 0.5, dot(Ngeom, normalize(uLightPos - vPosition)));
  color += uAtmosphere * rim * day;

  fragColor = vec4(color, 1.0);
}
`;

// WebGL setup
const canvas = document.getElementById("glcanvas");
const gl = canvas.getContext("webgl2");

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

const ATTRIBUTES = { aPosition: 0, aNormal: 1, aTexCoord: 2, aTangent: 3 };

function createProgram(vsSource, fsSource) {
  const prog = gl.createProgram();
  let vs = null, fs = null;
  try {
    vs = compile(gl.VERTEX_SHADER, vsSource);
    fs = compile(gl.FRAGMENT_SHADER, fsSource);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    for (const name in ATTRIBUTES) gl.bindAttribLocation(prog, ATTRIBUTES[name], name);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
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

// Lights, fixed in the scene: a warm sun off to the side and outside the orbit,
// so the planet shows a terminator, and a dim cool fill opposite it to lift the
// night side. The sun's intensity is folded into its color (1.25x warm white).
// The colors are set at link time; the positions are carried into view space
// each frame.
const SUN = { pos: [12, 5, 3], color: [1.25, 1.19, 1.06] };
const FILL = { pos: [-12, -5, -3], color: [0.12, 0.17, 0.3] };

// The scene's program, relinked from the GLSL editor on Apply. A source that
// fails to compile throws before anything is touched, so the last good program
// keeps drawing. The attribute locations are bound by name (ATTRIBUTES), so the
// meshes' vertex arrays work with any program.
const VS_PREFIX = `#version 300 es\n${LENS_GLSL}\n`;
const FS_PREFIX = `#version 300 es\n`;
let program = null;
let uModelView, uProjection, uLightPos, uLight2Pos, uMapping, uMaterial, uTexPanel, setLens;
function useSceneProgram(vsBody, fsBody) {
  const next = createProgram(VS_PREFIX + vsBody, FS_PREFIX + fsBody);
  if (program) gl.deleteProgram(program);
  program = next;
  gl.useProgram(program);
  const loc = name => gl.getUniformLocation(program, name);
  uModelView = loc("uModelView");
  uProjection = loc("uProjection");
  uLightPos = loc("uLightPos");
  uLight2Pos = loc("uLight2Pos");
  uMapping = loc("uMapping");
  uMaterial = Object.fromEntries(["uKa", "uKd", "uKs", "uShininess", "uBumpScale", "uAtmosphere"]
    .map(name => [name, loc(name)]));
  uTexPanel = Object.fromEntries(["uTiling", "uUVOffset", "uUVWarp", "uView", "uRelief", "uBumpGain",
    "uBumpWidth", "uInvertHeight", "uNormalGain", "uFlipGreen"].map(name => [name, loc(name)]));
  setLens = lensUniforms(program);
  gl.uniform1i(loc("uTexture"), 0);
  gl.uniform1i(loc("uNormalMap"), 1);
  gl.uniform3fv(loc("uLightColor"), SUN.color);
  gl.uniform3fv(loc("uLight2Color"), FILL.color);
}
useSceneProgram(VERTEX_SHADER, FRAGMENT_SHADER);

// Shiny painted metal, for parts that don't name a material of their own
const DEFAULT_MATERIAL = { ka: 0.2, kd: 0.8, ks: 0.5, shininess: 32, bumpScale: 3.0, atmosphere: [0, 0, 0] };
function setMaterial({ ka, kd, ks, shininess, bumpScale, atmosphere }) {
  gl.uniform1f(uMaterial.uKa, ka);
  gl.uniform1f(uMaterial.uKd, kd);
  gl.uniform1f(uMaterial.uKs, ks);
  gl.uniform1f(uMaterial.uShininess, shininess);
  gl.uniform1f(uMaterial.uBumpScale, bumpScale);
  gl.uniform3fv(uMaterial.uAtmosphere, atmosphere);
}

// The shader's uMapping modes
const BUMP_MAPPING = 0, NORMAL_MAPPING = 1, EMISSIVE = 2;

// The one draw call every part goes through. normalMap is only for
// NORMAL_MAPPING, where it is sampled on unit 1.
function drawPrimitive(mesh, texture, mapping, modelView, material = DEFAULT_MATERIAL, normalMap = null) {
  setMaterial(material);
  gl.uniformMatrix4fv(uModelView, false, modelView);
  gl.uniform1i(uMapping, mapping);
  if (normalMap) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, normalMap);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
}

function bindAttribute(name, data, size) {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.vertexAttribPointer(ATTRIBUTES[name], size, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(ATTRIBUTES[name]);
}

function createMesh({ positions, normals, tangents, texCoords, indices }) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  bindAttribute("aPosition", positions, 3);
  bindAttribute("aNormal", normals, 3);
  bindAttribute("aTangent", tangents, 3);
  bindAttribute("aTexCoord", texCoords, 2);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  return { vao, count: indices.length };
}

const cubeMesh = createMesh(createCube());
const cylinderMesh = createMesh(createCylinder());
const coneMesh = createMesh(createCone(48));
const torusMesh = createMesh(createTorus(0.04, 96, 16, 24));  // saucer rim: thin tube, 24 texture repeats
const sphereMesh = createMesh(createSphere(28, 28));
const planetMesh = createMesh(createSphere(64, 64));  // finer than sphereMesh: it fills the view

// The texture-mapping panel's settings (#texPanel), read from its inputs by
// syncTexPanel below. These are the defaults, which leave the scene as designed.
const texPanel = {
  view: 0, relief: 0, tiling: 1, scroll: 0, warp: 0,
  bumpGain: 1, bumpWidth: 1, invertHeight: false, normalGain: 1, flipGreen: false,
  filter: 2, aniso: 1
};
let uvScroll = 0;   // u offset, advanced by texPanel.scroll repeats a second

// Filtering for every mipmapped texture: 0 nearest, 1 bilinear (no mipmaps),
// 2 trilinear; anisotropy where the extension is offered. The video texture
// has no mipmaps and keeps its own LINEAR filter.
const anisoExt = gl.getExtension("EXT_texture_filter_anisotropic");
const MAX_ANISO = anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
const mipmappedTextures = [];
function applyFiltering(texture) {
  // Unit 0 is rebound by every draw, so borrowing it here is harmless
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const f = texPanel.filter;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, [gl.NEAREST, gl.LINEAR, gl.LINEAR_MIPMAP_LINEAR][f]);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f === 0 ? gl.NEAREST : gl.LINEAR);
  if (anisoExt) gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, texPanel.aniso);
}
function addMipmapped(texture) {
  mipmappedTextures.push(texture);
  applyFiltering(texture);
}

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
    addMipmapped(texture);
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
  addMipmapped(texture);
  return texture;
}

// Procedural ship skin. The saucer is bump mapped straight from its panel-line
// image; the dome, hull and nacelles get a color map with a normal map baked
// from the same height field (NORMAL_MAPPING).
const hullPlating = createPlating({ cols: 8, rows: 12, seed: 11,
  stripe: { at: 0.5, width: 0.07, color: [0.20, 0.23, 0.30], relief: 0.08 } });
const nacellePlating = createPlating({ cols: 6, rows: 16, seed: 23,
  base: [0.34, 0.37, 0.43],
  grille: { at: 0.5, width: 0.22, slats: 18, color: [0.13, 0.21, 0.42] } });

const domePlating = createDomeTexture();

const saucerTexture = createDataTexture(createSaucerTexture());
const domeTexture = createDataTexture(domePlating);
const domeNormalMap = createDataTexture(normalMap(domePlating, 6));
const hullTexture = createDataTexture(hullPlating);
const hullNormalMap = createDataTexture(normalMap(hullPlating, 7));
const nacelleTexture = createDataTexture(nacellePlating);
const nacelleNormalMap = createDataTexture(normalMap(nacellePlating, 8));

// Sky: 3000 point sprites in a single draw call (stars.js)
const starPoints = createStarPoints({ radius: SKY_RADIUS });

// Keep a complete texture on unit 1 even while drawing the modes that ignore it:
// a sampler with nothing bound counts as incomplete when the draw call is checked
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, hullNormalMap);
gl.activeTexture(gl.TEXTURE0);

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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }
  return { texture, update };
}

const plasma = loadVideoTexture(["textures/plasma.webm", "textures/plasma.mp4"]);

gl.enable(gl.DEPTH_TEST);
gl.clearColor(0, 0, 0, 1);

// Full-window canvas: match the drawing buffer to the displayed size and keep the
// scene framed. Vertical FOV is 45 deg; on windows narrower than 16:10 it widens so
// the horizontal FOV never drops below the 16:10 value and the whole orbit stays in frame.
const BASE_FOVY = Math.PI / 4, MIN_ASPECT = 1.6;
let projection;
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  const aspect = canvas.width / canvas.height;
  const fovy = aspect >= MIN_ASPECT ? BASE_FOVY
    : 2 * Math.atan(Math.tan(BASE_FOVY / 2) * MIN_ASPECT / aspect);
  projection = perspective(fovy, aspect, 0.1, 150);  // 150 keeps the sky sphere inside the far plane
}
window.addEventListener("resize", resize);
resize();

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
  if (!CONTROL_KEYS.includes(e.key) || e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
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

// Clicking the ship or the planet centers the view on it. Picking reads the
// view and ship of the last frame drawn, which is what was clicked on.
let lastView = null, lastShip = null;
canvas.addEventListener("click", e => {
  if (!lastView || offOrbit() || dragged) return;
  const r = canvas.getBoundingClientRect();
  const hit = pickObject(2 * (e.clientX - r.left) / r.width - 1,
    1 - 2 * (e.clientY - r.top) / r.height, lastView, lastShip);
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

// Render loop
let lastNow = 0;
function render(time) {
  const now = time / 1000;
  const dt = Math.min(now - lastNow, 0.1);   // capped, so a stalled tab doesn't lurch
  lastNow = now;
  if (engageExpired(now - sceneStart)) resetScene(now);
  const t = now - sceneStart;   // scene clock
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const rotation = multiply(rotateY(dragRotY), rotateX(dragRotX));

  // The flight path is advanced once, here, because the camera needs to know
  // where the ship is before anything is drawn.
  const ship = shipState(t);
  const view = updateCamera(t, ship, freeView(now, dt, ship, rotation, [camX, camY]),
    { x: dragRotX, y: dragRotY });
  lastView = view; lastShip = ship;

  gl.uniformMatrix4fv(uProjection, false, projection);
  setLens();
  uploadTexPanel(dt);
  // The lights are fixed in the scene, so they ride whatever the view is now
  gl.uniform3fv(uLightPos, transformPoint(view, SUN.pos));
  gl.uniform3fv(uLight2Pos, transformPoint(view, FILL.pos));

  plasma.update();
  drawSystem(view, t, ship);
  updateWashes(t, ship);
  updateReveal(t);
  engageButton.disabled = offOrbit();
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// ---------------------------------------------------------------------------
// Texture-mapping panel (#texPanel in index.html)
// ---------------------------------------------------------------------------

// Sent every frame rather than on change, so a program relinked from the
// GLSL editor picks the settings up without being told
function uploadTexPanel(dt) {
  const u = uTexPanel, p = texPanel;
  uvScroll = (uvScroll + p.scroll * dt) % 1;
  gl.uniform1f(u.uTiling, p.tiling);
  gl.uniform2f(u.uUVOffset, uvScroll, 0);
  gl.uniform1f(u.uUVWarp, p.warp);
  gl.uniform1i(u.uView, p.view);
  gl.uniform1i(u.uRelief, p.relief);
  gl.uniform1f(u.uBumpGain, p.bumpGain);
  gl.uniform1f(u.uBumpWidth, p.bumpWidth);
  gl.uniform1i(u.uInvertHeight, p.invertHeight);
  gl.uniform1f(u.uNormalGain, p.normalGain);
  gl.uniform1i(u.uFlipGreen, p.flipGreen);
}

{
  const form = document.getElementById("texForm");
  const fmt = {
    tiling: v => v.toFixed(2) + "×",
    scroll: v => (v > 0 ? "+" : "") + v.toFixed(2) + " /s",
    warp: v => v.toFixed(3),
    bumpGain: v => v.toFixed(2) + "×",
    bumpWidth: v => v + (v === 1 ? " texel" : " texels"),
    normalGain: v => v.toFixed(2) + "×",
    aniso: v => v + "×"
  };
  const anisoInput = form.elements.aniso;
  anisoInput.max = MAX_ANISO;
  if (!anisoExt) anisoInput.closest(".row").hidden = true;

  // Read every input into texPanel and its readout; refilter on a change
  function syncTexPanel() {
    const before = texPanel.filter + "/" + texPanel.aniso;
    for (const el of form.elements) {
      if (!(el.name in texPanel)) continue;
      const v = el.type === "checkbox" ? el.checked : Number(el.value);
      texPanel[el.name] = v;
      const out = form.querySelector(`output[for="${el.id}"]`);
      if (out && fmt[el.name]) out.textContent = fmt[el.name](v);
    }
    // Anisotropy only matters on top of mipmapped (trilinear) filtering
    anisoInput.disabled = texPanel.filter !== 2;
    if (texPanel.filter !== 2) texPanel.aniso = 1;
    if (texPanel.filter + "/" + texPanel.aniso !== before) mipmappedTextures.forEach(applyFiltering);
  }

  form.addEventListener("input", syncTexPanel);
  form.addEventListener("change", syncTexPanel);
  document.getElementById("texReset").addEventListener("click", () => {
    form.reset();       // back to each input's value in the HTML
    uvScroll = 0;
    syncTexPanel();
  });
  syncTexPanel();
}

// ---------------------------------------------------------------------------
// Floating live-code GLSL editor (#shaderBox in index.html)
// ---------------------------------------------------------------------------
{
  // Compile errors report lines of the whole source; map them back to the
  // editor's, past the prepended #version and lens code
  const PREFIX_LINES = { vertex: VS_PREFIX.split("\n").length - 1, fragment: FS_PREFIX.split("\n").length - 1 };
  const TAB_NAMES = { vertex: "Vertex", fragment: "Fragment" };
  function formatCompileError(message, stage) {
    return String(message || "Shader compilation failed").trim()
      .replace(/ERROR:\s*\d+:(\d+):/g, (match, raw) => {
        const line = parseInt(raw, 10) - PREFIX_LINES[stage];
        return line >= 1 ? `${TAB_NAMES[stage]} (line ${line}):` : match;
      });
  }
  // Each stage is compiled alone first, so a failure is known to be its own
  let lastCompiled = null;
  function checkStage(stage, src) {
    lastCompiled = stage;
    const type = stage === "vertex" ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER;
    const prefix = stage === "vertex" ? VS_PREFIX : FS_PREFIX;
    gl.deleteShader(compile(type, prefix + src));
  }

  const escapeHtml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const GLSL_KW = new Set(["if", "else", "for", "while", "do", "return", "continue", "break", "discard",
    "struct", "in", "out", "inout", "uniform", "const", "true", "false", "precision", "lowp", "mediump", "highp"]);
  const GLSL_TY = new Set(["void", "bool", "int", "uint", "float", "vec2", "vec3", "vec4",
    "bvec2", "bvec3", "bvec4", "ivec2", "ivec3", "ivec4", "mat2", "mat3", "mat4", "sampler2D"]);
  const GLSL_BI = new Set(["dot", "cross", "normalize", "length", "distance", "reflect", "refract",
    "faceforward", "clamp", "max", "min", "mix", "pow", "exp", "sqrt", "abs", "smoothstep", "step",
    "sin", "cos", "acos", "fract", "floor", "texture", "textureSize", "transpose", "inverse",
    "gl_Position", "project", "phong", "height",
    "uModelView", "uProjection", "uLightPos", "uLight2Pos", "uLightColor", "uLight2Color",
    "uKa", "uKd", "uKs", "uShininess", "uBumpScale", "uAtmosphere", "uTexture", "uNormalMap", "uMapping",
    "uTiling", "uUVOffset", "uUVWarp", "uView", "uRelief", "uBumpGain", "uBumpWidth", "uInvertHeight",
    "uNormalGain", "uFlipGreen"]);
  const GLSL_TOKEN = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|^[ \t]*#[^\n]*|(?:\b\d+\.\d*(?:[eE][+-]?\d+)?[fF]?|\B\.\d+(?:[eE][+-]?\d+)?[fF]?|\b\d+(?:[eE][+-]?\d+)?[uUfF]?\b)|\b[A-Za-z_]\w*\b)/gm;

  function highlightGLSL(src) {
    let out = "", pos = 0;
    GLSL_TOKEN.lastIndex = 0;
    for (let m; (m = GLSL_TOKEN.exec(src)); ) {
      if (m.index > pos) out += escapeHtml(src.slice(pos, m.index));
      const tok = m[0];
      let cls = "";
      if (tok[0] === "/") cls = "tok-com";
      else if (tok.trimStart()[0] === "#") cls = "tok-pp";
      else if (tok[0] <= "9" && tok[0] >= "0" || tok[0] === ".") cls = "tok-num";
      else if (GLSL_KW.has(tok)) cls = "tok-kw";
      else if (GLSL_TY.has(tok)) cls = "tok-ty";
      else if (GLSL_BI.has(tok)) cls = "tok-bi";
      out += cls ? `<span class="${cls}">${escapeHtml(tok)}</span>` : escapeHtml(tok);
      pos = m.index + tok.length;
    }
    if (pos < src.length) out += escapeHtml(src.slice(pos));
    return out;
  }

  const TAB_HINTS = {
    vertex: "Model-view transform, inverse-transpose normals, tangents &amp; the lens. <code>#version</code> and <code>project()</code> are prepended. Uniforms: <code>uModelView</code> <code>uProjection</code>",
    fragment: "Bump/normal mapping, two-light Phong &amp; the planet's rim glow. Uniforms: <code>uMapping</code> (0 bump, 1 normal, 2 emissive) <code>uKa..uShininess</code> <code>uBumpScale</code> <code>uAtmosphere</code>, plus the Texture mapping panel's <code>uTiling</code> <code>uView</code> <code>uRelief</code> &hellip;"
  };

  const editor = document.getElementById("shaderEditor");
  const highlightEl = document.getElementById("shaderHighlight");
  const gutterEl = document.getElementById("shaderGutter");
  const hintEl = document.getElementById("shaderHint");
  const applyBtn = document.getElementById("shaderApply");
  const resetBtn = document.getElementById("shaderReset");
  const statusEl = document.getElementById("shaderStatus");
  const errorEl = document.getElementById("shaderError");
  const tabBtns = [...document.querySelectorAll("#shaderBox .tab")];

  const blocks = { vertex: VERTEX_SHADER, fragment: FRAGMENT_SHADER };
  let applied = { ...blocks };
  let activeTab = "fragment";

  function syncScroll() {
    highlightEl.scrollTop = editor.scrollTop;
    highlightEl.scrollLeft = editor.scrollLeft;
    gutterEl.scrollTop = editor.scrollTop;
  }
  function renderCodeOverlay() {
    const code = editor.value;
    highlightEl.innerHTML = highlightGLSL(code) + "\n";
    const lines = code.split("\n").length;
    gutterEl.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n") + "\n";
    syncScroll();
  }
  function setStatus(text, cls = "") {
    statusEl.textContent = text;
    statusEl.className = cls;
  }
  function updateModifiedStatus() {
    blocks[activeTab] = editor.value;
    renderCodeOverlay();
    const dirty = blocks.vertex !== applied.vertex || blocks.fragment !== applied.fragment;
    applyBtn.classList.toggle("pending", dirty);
    setStatus(dirty ? "Modified" : "Applied", dirty ? "modified" : "");
  }
  function selectTab(tab) {
    blocks[activeTab] = editor.value;
    activeTab = tab;
    editor.value = blocks[tab];
    hintEl.innerHTML = TAB_HINTS[tab];
    for (const btn of tabBtns) btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
    renderCodeOverlay();
  }
  function applyShaders() {
    blocks[activeTab] = editor.value;
    try {
      checkStage("vertex", blocks.vertex);
      checkStage("fragment", blocks.fragment);
      lastCompiled = null;   // both compiled: anything left is a link error
      useSceneProgram(blocks.vertex, blocks.fragment);
      applied = { ...blocks };
      applyBtn.classList.remove("pending");
      errorEl.hidden = true;
      errorEl.textContent = "";
      setStatus("Applied");
    } catch (e) {
      errorEl.textContent = lastCompiled ? formatCompileError(e.message, lastCompiled) : String(e.message).trim();
      errorEl.hidden = false;
      setStatus("Error", "error");
    }
  }
  function resetShaders() {
    blocks.vertex = VERTEX_SHADER;
    blocks.fragment = FRAGMENT_SHADER;
    editor.value = blocks[activeTab];
    renderCodeOverlay();
    applyShaders();
  }

  editor.value = blocks[activeTab];   // selectTab saves the editor's text first
  selectTab(activeTab);
  tabBtns.forEach(btn => btn.addEventListener("click", () => selectTab(btn.dataset.tab)));
  editor.addEventListener("input", updateModifiedStatus);
  editor.addEventListener("scroll", syncScroll);
  editor.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      applyShaders();
    } else if (e.key === "Tab") {
      e.preventDefault();
      editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
      updateModifiedStatus();
    }
  });
  applyBtn.addEventListener("click", applyShaders);
  resetBtn.addEventListener("click", resetShaders);
}
