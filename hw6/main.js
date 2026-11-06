const VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
in vec3 aTangent;
in vec2 aTexCoord;

uniform mat4 uModelView;
uniform mat4 uProjection;
${LENS_GLSL}
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

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

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

out vec4 fragColor;

// Bump height: dark is high (1 - Rec. 601 luminance); a negative uBumpScale flips it
float height(vec2 uv) {
  vec3 c = texture(uTexture, uv).rgb;
  return 1.0 - dot(c, vec3(0.299, 0.587, 0.114));
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
  // Emissive: the surface gives off its own light, so skip lighting entirely
  if (uMapping == 2) {
    fragColor = vec4(texture(uTexture, vTexCoord).rgb, 1.0);
    return;
  }

  // Tangent frame (T, B, N)
  vec3 N = normalize(vNormal);
  vec3 T = normalize(vTangent - dot(vTangent, N) * N);
  vec3 B = cross(N, T);
  mat3 TBN = mat3(T, B, N);

  vec3 baseColor;
  vec3 n;

  if (uMapping == 0) {
    // Bump mapping: tilt the normal against the gradient of the height field
    vec2 du = vec2(1.0 / float(textureSize(uTexture, 0).x), 0.0);
    vec2 dv = vec2(0.0, 1.0 / float(textureSize(uTexture, 0).y));
    float dhdu = (height(vTexCoord + du) - height(vTexCoord - du)) * 0.5;
    float dhdv = (height(vTexCoord + dv) - height(vTexCoord - dv)) * 0.5;
    n = normalize(vec3(-uBumpScale * dhdu, -uBumpScale * dhdv, 1.0));
    baseColor = texture(uTexture, vTexCoord).rgb;
  } else {
    // Normal mapping: uNormalMap stores the tangent-space normal in [0, 1],
    // baked from the same height field as uTexture's paint (textures.js)
    n = normalize(texture(uNormalMap, vTexCoord).rgb * 2.0 - 1.0);
    baseColor = texture(uTexture, vTexCoord).rgb;
  }

  vec3 Ngeom = N;              // smooth surface normal, before bump/normal mapping
  N = normalize(TBN * n);
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

const program = createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
gl.useProgram(program);
const uModelView = gl.getUniformLocation(program, "uModelView");
const uProjection = gl.getUniformLocation(program, "uProjection");
const uLightPos = gl.getUniformLocation(program, "uLightPos");
const uLight2Pos = gl.getUniformLocation(program, "uLight2Pos");
const uMapping = gl.getUniformLocation(program, "uMapping");
const setLens = lensUniforms(program);
gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
gl.uniform1i(gl.getUniformLocation(program, "uNormalMap"), 1);

// Lights, fixed in the scene: a warm sun off to the side and outside the orbit,
// so the planet shows a terminator, and a dim cool fill opposite it to lift the
// night side. The sun's intensity is folded into its color (1.25x warm white).
// The colors are set once; the positions are carried into view space each frame.
const SUN = { pos: [12, 5, 3], color: [1.25, 1.19, 1.06] };
const FILL = { pos: [-12, -5, -3], color: [0.12, 0.17, 0.3] };
gl.uniform3fv(gl.getUniformLocation(program, "uLightColor"), SUN.color);
gl.uniform3fv(gl.getUniformLocation(program, "uLight2Color"), FILL.color);

const uMaterial = Object.fromEntries(["uKa", "uKd", "uKs", "uShininess", "uBumpScale", "uAtmosphere"]
  .map(name => [name, gl.getUniformLocation(program, name)]));

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
// image; the dome, hull and nacelles get a color map with a normal map baked
// from the same height field (NORMAL_MAPPING).
const hullPlating = createPlating({ cols: 8, rows: 12, seed: 11,
  stripe: { at: 0.5, width: 0.07, color: [0.34, 0.37, 0.44], relief: 0.08 } });
const nacellePlating = createPlating({ cols: 6, rows: 16, seed: 23,
  base: [0.62, 0.65, 0.71],
  grille: { at: 0.5, width: 0.22, slats: 18, color: [0.30, 0.42, 0.72] } });

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
// steer it around the ship instead of turning the scene (camera.js).
let dragRotX, dragRotY;      // mouse drag
let camX, camY, camZ;        // arrow keys, w, s
// The scene's own clock starts here, so a reset restarts the orbit and the
// planet's spin along with everything else
let sceneStart = 0;

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
    case "ArrowRight": camX -= step; break;
    case "w": camZ += step; break;
    case "s": camZ -= step; break;
    default: return;
  }
  e.preventDefault();
});

// Engage. The press is handled on the next frame, where the clock is known
// (scene.js), and the button stays down until the scene resets.
const engageButton = document.getElementById("engageButton");
engageButton.addEventListener("click", requestEngage);

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
  camX = 0; camY = 0; camZ = -14;
  sceneStart = time;
  resetFlight();
}
resetScene(0);

// Render loop
function render(time) {
  const now = time / 1000;
  if (engageExpired(now - sceneStart)) resetScene(now);
  const t = now - sceneStart;   // scene clock
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const rotation = multiply(rotateY(dragRotY), rotateX(dragRotX));

  // The flight path is advanced once, here, because the camera needs to know
  // where the ship is before anything is drawn.
  const ship = shipState(t);
  const view = updateCamera(t, ship, multiply(translate(camX, camY, camZ), rotation),
    { x: dragRotX, y: dragRotY });

  gl.uniformMatrix4fv(uProjection, false, projection);
  setLens();
  // The lights are fixed in the scene, so they ride whatever the view is now
  gl.uniform3fv(uLightPos, transformPoint(view, SUN.pos));
  gl.uniform3fv(uLight2Pos, transformPoint(view, FILL.pos));

  plasma.update();
  drawSystem(view, t, ship);
  updateWashes(t, ship);
  engageButton.disabled = offOrbit();
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
