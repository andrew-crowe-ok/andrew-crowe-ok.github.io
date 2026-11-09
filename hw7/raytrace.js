// The ray tracer: one full-screen pass whose fragment shader does all the work.
//
// The scene arrives as a list of primitives, each a unit shape (models.js's
// conventions from HW6: sphere of radius 1, cylinder and cone along y in
// [-1, 1], box [-1, 1]^3, torus of ring radius 1 in the xz plane) plus the
// inverse of the model-view matrix that placed it. Everything happens in eye
// space, the camera at the origin: a ray is carried into a primitive's own
// space by that inverse, intersected with the unit shape there, and the normal
// comes back by the inverse's transpose. The direction is not renormalized in
// object space, so the ray parameter t means the same distance in both.
//
// The ship's parts come in groups, each boxed (main.js fits the boxes as the
// parts are drawn): a ray tests a group's parts only if it passes through its
// box, so it pays for the few parts near it rather than the whole ship.
//
// GLSL has no recursion, so the bounce tree is walked by a loop that follows
// one path at a time, carrying its weight (how much of the pixel it still
// accounts for). At glass the path splits in two by Schlick's Fresnel term:
// the stronger branch (refraction, usually; reflection at grazing angles) is
// followed on, and the weaker one waits on a small stack until the current
// path ends.

const MAX_PRIMS = 32;      // the scene has 32: 30 ship parts, the planet, the moon
const MAX_GROUPS = 4;      // the ship uses 4: saucer, hull, and each pylon with its nacelle
const MAX_SEGMENTS = 12;   // ray segments traced per pixel, across all branches
const STACK_SIZE = 4;      // glass branches waiting their turn
const NUM_LIGHTS = 3;
const SPHERE = 0, CYLINDER = 1, CONE = 2, BOX = 3, TORUS = 4;
// The mapping modes, as in HW6
const BUMP_MAPPING = 0, NORMAL_MAPPING = 1, EMISSIVE = 2;
// Texture units in use (main.js binds them); the shader samples each by a
// constant index, since GLSL ES can't index a sampler array with a variable.
// 16 is all WebGL 2 promises.
const TEXTURE_UNITS = 16;

// Warp streaks, as in HW6's point sprites: each star is smeared over the path
// it covers in `shutter` seconds, at most `max` CSS pixels long, and dims as
// its light is spread along that path
const STREAK = { shutter: 0.45, max: 40, dim: 0.1 };

const RAYTRACE_VS = `#version 300 es
// One triangle that covers the screen: (-1,-1), (3,-1), (-1,3)
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// A switch over the texture units, so each sampler is indexed by a constant
const textureSwitch = (call) => Array.from({ length: TEXTURE_UNITS },
  (_, i) => `    case ${i}: return ${call(`uTex[${i}]`)};`).join("\n");

const RAYTRACE_FS = `#version 300 es
precision highp float;
precision highp int;

#define MAX_PRIMS ${MAX_PRIMS}
#define MAX_GROUPS ${MAX_GROUPS}
#define MAX_SEGMENTS ${MAX_SEGMENTS}
#define STACK_SIZE ${STACK_SIZE}
#define NUM_LIGHTS ${NUM_LIGHTS}
#define TEXTURE_UNITS ${TEXTURE_UNITS}
#define SPHERE ${SPHERE}
#define CYLINDER ${CYLINDER}
#define CONE ${CONE}
#define BOX ${BOX}
#define TORUS ${TORUS}
#define BUMP_MAPPING ${BUMP_MAPPING}
#define NORMAL_MAPPING ${NORMAL_MAPPING}
#define EMISSIVE ${EMISSIVE}

#define INF 1e20
#define EPS 2e-4        // how far a new ray starts off the surface it leaves
#define PI 3.14159265
#define TAU 6.28318531

// ---- camera ----------------------------------------------------------------
uniform vec2 uResolution;
uniform float uProj00, uProj11;   // the perspective matrix's x and y scales
uniform float uFisheye;           // 0 = rectilinear, 1 = the warp fisheye
uniform float uFishHalfX, uFishStretch, uFishPivot;
uniform float uPixelAngle;        // radians across one pixel, mid-frame

// ---- scene -----------------------------------------------------------------
// The primitives, in a uniform buffer (main.js fills it in this order, std140:
// every array element one vec4). Plain uniforms run out at a couple of dozen
// primitives on some GPUs; a block holds far more.
layout(std140) uniform Scene {
  vec4 uInv[3 * MAX_PRIMS];       // rows of each primitive's eye-to-object matrix
  ivec4 uInfo[MAX_PRIMS];         // shape, texture unit, normal map unit (-1 = none), mapping
  vec4 uMatA[MAX_PRIMS];          // ka, kd, ks, shininess
  vec4 uMatB[MAX_PRIMS];          // kr (mirror), kt (glass), index of refraction, bump scale
  vec4 uMatC[MAX_PRIMS];          // atmosphere color, torus tube radius
  vec4 uMatD[MAX_PRIMS];          // glass absorption per unit length, texture repeats around u
  vec4 uMatE[MAX_PRIMS];          // glow (emission's strength), group (-1 = none),
                                  //   an EMISSIVE part's power, and how far its texture slides along z
  vec4 uGroupInv[3 * MAX_GROUPS]; // rows of each group box's eye-to-box matrix
  vec4 uGroupHalf[MAX_GROUPS];    // each box's half-size
  ivec4 uGroupRange[MAX_GROUPS];  // start primitive index, end primitive index
};
uniform int uCount, uGroupCount;

uniform vec3 uLightPos[NUM_LIGHTS];     // eye space
uniform vec3 uLightColor[NUM_LIGHTS];   // intensity folded in
uniform vec2 uLightRange[NUM_LIGHTS];   // distance at which attenuation is 1, and past which it stops

// ---- controls --------------------------------------------------------------
uniform int uBounces;
uniform bool uShadows, uAttenuation;
uniform float uShininessScale;

uniform sampler2D uTex[TEXTURE_UNITS];
uniform float uTime;

// ---- sky -------------------------------------------------------------------
uniform vec3 uSkyCenter;      // eye space
uniform mat3 uSkyRot;         // the sky frame's axes in eye space
uniform float uSkyRadius;
uniform vec3 uStreak;         // the stars' velocity past the eye, eye space
uniform float uShutter, uMaxStreak, uStreakDim;
uniform float uStarScale;     // pixels rendered per CSS pixel

out vec4 fragColor;

// ============================================================================
// Textures, filtered by the footprint's two axes -- gx and gy, how far uv
// moves across one pixel's cone of rays each way -- so the GPU's anisotropic
// filtering keeps a surface seen at a slant sharp, as it would rasterized
// ============================================================================
vec4 sampleTex(int unit, vec2 uv, vec2 gx, vec2 gy) {
  switch (unit) {
${textureSwitch(s => `textureGrad(${s}, uv, gx, gy)`)}
  }
  return vec4(1.0);
}
vec2 texSize(int unit) {
  switch (unit) {
${textureSwitch(s => `vec2(textureSize(${s}, 0))`)}
  }
  return vec2(1.0);
}

// ============================================================================
// Intersections, in a primitive's own space. Each takes the best t so far and
// replaces it only with a nearer hit beyond tmin. n is the outward normal
// (unnormalized), part says which face was hit, for texturing.
// ============================================================================
vec3 toObject(int i, vec3 p, float w) {
  vec4 q = vec4(p, w);
  return vec3(dot(uInv[3 * i], q), dot(uInv[3 * i + 1], q), dot(uInv[3 * i + 2], q));
}

bool hitSphere(vec3 o, vec3 d, float tmin, inout float t, out vec3 n) {
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1.0;
  float disc = b * b - a * c;
  if (disc < 0.0) return false;
  float s = sqrt(disc);
  float th = (-b - s) / a;
  if (th <= tmin) th = (-b + s) / a;     // starting inside: the far side
  if (th <= tmin || th >= t) return false;
  t = th;
  n = o + d * th;
  return true;
}

// Side: x^2 + z^2 = 1 for |y| <= 1 (part 0); caps at y = 1 (part 1), y = -1 (part 2)
bool hitCylinder(vec3 o, vec3 d, float tmin, inout float t, out vec3 n, out int part) {
  bool found = false;
  float a = dot(d.xz, d.xz), b = dot(o.xz, d.xz), c = dot(o.xz, o.xz) - 1.0;
  float disc = b * b - a * c;
  if (a > 1e-12 && disc >= 0.0) {
    float s = sqrt(disc);
    for (int k = 0; k < 2; k++) {
      float th = (-b + (k == 0 ? -s : s)) / a;
      vec3 p = o + d * th;
      if (th > tmin && th < t && abs(p.y) <= 1.0) {
        t = th; n = vec3(p.x, 0.0, p.z); part = 0; found = true;
        break;
      }
    }
  }
  if (abs(d.y) > 1e-12) {
    for (int k = 0; k < 2; k++) {
      float y = k == 0 ? 1.0 : -1.0;
      float th = (y - o.y) / d.y;
      vec3 p = o + d * th;
      if (th > tmin && th < t && dot(p.xz, p.xz) <= 1.0) {
        t = th; n = vec3(0.0, y, 0.0); part = 1 + k; found = true;
      }
    }
  }
  return found;
}

// Side: radius (1 - y) / 2, so x^2 + z^2 = k (1 - y)^2 with k = 1/4, for
// |y| <= 1 (part 0); base cap at y = -1 (part 1)
bool hitCone(vec3 o, vec3 d, float tmin, inout float t, out vec3 n, out int part) {
  const float k = 0.25;
  bool found = false;
  float h = 1.0 - o.y;
  float a = dot(d.xz, d.xz) - k * d.y * d.y;
  float b = dot(o.xz, d.xz) + k * h * d.y;
  float c = dot(o.xz, o.xz) - k * h * h;
  float t0 = INF, t1 = INF;
  if (abs(a) < 1e-9) {
    if (abs(b) > 1e-12) t0 = -c / (2.0 * b);
  } else {
    float disc = b * b - a * c;
    if (disc >= 0.0) {
      float s = sqrt(disc);
      t0 = (-b - s) / a; t1 = (-b + s) / a;
      if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }
    }
  }
  for (int i = 0; i < 2; i++) {
    float th = i == 0 ? t0 : t1;
    vec3 p = o + d * th;
    if (th > tmin && th < t && abs(p.y) <= 1.0) {
      t = th; n = vec3(p.x, k * (1.0 - p.y), p.z); part = 0; found = true;
      break;
    }
  }
  if (abs(d.y) > 1e-12) {
    float th = (-1.0 - o.y) / d.y;
    vec3 p = o + d * th;
    if (th > tmin && th < t && dot(p.xz, p.xz) <= 1.0) {
      t = th; n = vec3(0.0, -1.0, 0.0); part = 1; found = true;
    }
  }
  return found;
}

// The slab test: the span of t the ray spends inside |p_i| <= extent_i
vec2 boxSpan(vec3 o, vec3 d, vec3 extent) {
  vec3 inv = 1.0 / (d + vec3(equal(d, vec3(0.0))) * 1e-12);
  vec3 ta = (-extent - o) * inv, tb = (extent - o) * inv;
  vec3 tn = min(ta, tb), tf = max(ta, tb);
  return vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}

// Faces as in models.js: 0 front (+z), 1 back, 2 top (+y), 3 bottom, 4 right (+x), 5 left
bool hitBox(vec3 o, vec3 d, float tmin, inout float t, out vec3 n, out int part) {
  vec2 span = boxSpan(o, d, vec3(1.0));
  if (span.x > span.y) return false;
  float th = span.x > tmin ? span.x : span.y;
  if (th <= tmin || th >= t) return false;
  t = th;
  vec3 p = o + d * th, ap = abs(p);
  if (ap.x >= ap.y && ap.x >= ap.z) { n = vec3(sign(p.x), 0.0, 0.0); part = p.x > 0.0 ? 4 : 5; }
  else if (ap.y >= ap.z)            { n = vec3(0.0, sign(p.y), 0.0); part = p.y > 0.0 ? 2 : 3; }
  else                              { n = vec3(0.0, 0.0, sign(p.z)); part = p.z > 0.0 ? 0 : 1; }
  return true;
}

// Torus, ring radius 1 and tube radius r. The tube is thin (r = 0.04), and the
// quartic for it loses most of its digits in single precision, so this one is
// sphere traced instead -- marched along the ray by the distance to the
// surface -- over only the stretch where the ray is inside both the slab
// |y| <= r and the bounding sphere of radius 1 + r.
float torusDistance(vec3 p, float r) {
  return length(vec2(length(p.xz) - 1.0, p.y)) - r;
}
bool hitTorus(vec3 o, vec3 d, float r, float tmin, inout float t, out vec3 n) {
  float len = length(d);
  vec3 u = d / len;                       // march in object-space units
  float b = dot(o, u), c = dot(o, o) - (1.0 + r) * (1.0 + r);
  float disc = b * b - c;
  if (disc < 0.0) return false;
  float s = sqrt(disc);
  float x0 = -b - s, x1 = -b + s;
  if (abs(u.y) > 1e-6) {
    float ya = (-r - o.y) / u.y, yb = (r - o.y) / u.y;
    x0 = max(x0, min(ya, yb)); x1 = min(x1, max(ya, yb));
  } else if (abs(o.y) > r) return false;
  x0 = max(x0, tmin * len); x1 = min(x1, t * len);
  if (x0 >= x1) return false;
  float x = x0;
  for (int i = 0; i < 64; i++) {
    float h = torusDistance(o + u * x, r);
    if (h < 2e-5) {
      vec3 p = o + u * x;
      vec2 q = normalize(p.xz);
      n = p - vec3(q.x, 0.0, q.y);        // from the tube's center line
      t = x / len;
      return true;
    }
    x += h;
    if (x > x1) return false;
  }
  return false;
}

bool intersect(int i, vec3 o, vec3 d, float tmin, inout float t, out vec3 n, out int part) {
  vec3 oo = toObject(i, o, 1.0), dd = toObject(i, d, 0.0);
  part = 0;
  int shape = uInfo[i].x;
  if (shape == SPHERE)   return hitSphere(oo, dd, tmin, t, n);
  if (shape == CYLINDER) return hitCylinder(oo, dd, tmin, t, n, part);
  if (shape == CONE)     return hitCone(oo, dd, tmin, t, n, part);
  if (shape == BOX)      return hitBox(oo, dd, tmin, t, n, part);
  return hitTorus(oo, dd, uMatC[i].w, tmin, t, n);
}

// Does the ray come within group g's box anywhere in (tmin, tmax)?
bool groupVisible(int g, vec3 o, vec3 d, float tmin, float tmax) {
  vec4 q = vec4(o, 1.0), v = vec4(d, 0.0);
  vec3 go = vec3(dot(uGroupInv[3 * g], q), dot(uGroupInv[3 * g + 1], q), dot(uGroupInv[3 * g + 2], q));
  vec3 gd = vec3(dot(uGroupInv[3 * g], v), dot(uGroupInv[3 * g + 1], v), dot(uGroupInv[3 * g + 2], v));
  vec2 span = boxSpan(go, gd, uGroupHalf[g].xyz);
  return span.x <= span.y && span.y > tmin && span.x < tmax;
}

struct Hit { float t; int id; int part; vec3 n; };

// The nearest hit along o + t d, t in (EPS, tmax)
Hit trace(vec3 o, vec3 d, float tmax) {
  Hit h;
  h.t = tmax; h.id = -1; h.part = 0; h.n = vec3(0.0, 1.0, 0.0);
  int ungrouped = uGroupCount > 0 ? uGroupRange[0].x : uCount;
  for (int i = 0; i < ungrouped; i++) {
    vec3 n; int part;
    if (intersect(i, o, d, EPS, h.t, n, part)) { h.id = i; h.n = n; h.part = part; }
  }
  for (int g = 0; g < MAX_GROUPS; g++) {
    if (g >= uGroupCount) break;
    if (!groupVisible(g, o, d, EPS, h.t)) continue;
    for (int i = uGroupRange[g].x; i < uGroupRange[g].y; i++) {
      vec3 n; int part;
      if (intersect(i, o, d, EPS, h.t, n, part)) { h.id = i; h.n = n; h.part = part; }
    }
  }
  return h;
}

// How much of (tmin, tmax) the ray spends inside the unit sphere
float sphereChord(vec3 o, vec3 d, float tmin, float tmax) {
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1.0;
  float disc = b * b - a * c;
  if (disc < 0.0) return 0.0;
  float s = sqrt(disc);
  return max(min((-b + s) / a, tmax) - max((-b - s) / a, tmin), 0.0);
}

// Shadow ray: how much light gets from o to dist along d. An opaque part
// blocks it; glass lets through its transmittance, less what it absorbs over
// the chord the ray cuts through it (Beer-Lambert), so glass casts a pale
// colored shadow instead of a black one. Glowing parts are light sources
// themselves and cast none. (The glass parts are all spheres.)
vec3 transmittance(vec3 o, vec3 d, float dist) {
  vec3 tr = vec3(1.0);
  int ungrouped = uGroupCount > 0 ? uGroupRange[0].x : uCount;
  for (int i = 0; i < ungrouped; i++) {
    if (uInfo[i].w == EMISSIVE) continue;
    float t = dist; vec3 n; int part;
    if (intersect(i, o, d, EPS, t, n, part)) {
      float kt = uMatB[i].y;
      if (kt <= 0.0) return vec3(0.0);
      float chord = uInfo[i].x == SPHERE
        ? sphereChord(toObject(i, o, 1.0), toObject(i, d, 0.0), EPS, dist) : 0.0;
      tr *= kt * exp(-uMatD[i].rgb * chord);
    }
  }
  for (int g = 0; g < MAX_GROUPS; g++) {
    if (g >= uGroupCount) break;
    if (!groupVisible(g, o, d, EPS, dist)) continue;
    for (int i = uGroupRange[g].x; i < uGroupRange[g].y; i++) {
      if (uInfo[i].w == EMISSIVE) continue;
      float t = dist; vec3 n; int part;
      if (intersect(i, o, d, EPS, t, n, part)) {
        float kt = uMatB[i].y;
        if (kt <= 0.0) return vec3(0.0);
        float chord = uInfo[i].x == SPHERE
          ? sphereChord(toObject(i, o, 1.0), toObject(i, d, 0.0), EPS, dist) : 0.0;
        tr *= kt * exp(-uMatD[i].rgb * chord);
      }
    }
  }
  return tr;
}

// ============================================================================
// Surfaces: texture coordinates and tangents worked out from the hit point
// the same way models.js laid them on its meshes in HW6
// ============================================================================
vec2 uvAt(int shape, int part, vec3 p, float repeats) {
  if (shape == SPHERE) {
    float phi = atan(p.z, p.x);
    if (phi < 0.0) phi += TAU;
    float theta = acos(clamp(p.y / length(p), -1.0, 1.0));
    return vec2(1.0 - phi / TAU, 1.0 - theta / PI);
  }
  if (shape == BOX) {
    if (part == 0) return vec2(p.x + 1.0, p.y + 1.0) * 0.5;
    if (part == 1) return vec2(1.0 - p.x, p.y + 1.0) * 0.5;
    if (part == 2) return vec2(p.x + 1.0, 1.0 - p.z) * 0.5;
    if (part == 3) return vec2(p.x + 1.0, p.z + 1.0) * 0.5;
    if (part == 4) return vec2(1.0 - p.z, p.y + 1.0) * 0.5;
    return vec2(p.z + 1.0, p.y + 1.0) * 0.5;
  }
  // Caps: planar mapping of x and z
  if (shape == CYLINDER && part > 0) return vec2(0.5 + 0.5 * p.x, 0.5 - 0.5 * (part == 1 ? p.z : -p.z));
  if (shape == CONE && part > 0) return vec2(0.5 + 0.5 * p.x, 0.5 + 0.5 * p.z);
  // Around the y axis: theta = 0 on +z, growing toward +x
  float theta = atan(p.x, p.z);
  if (theta < 0.0) theta += TAU;
  if (shape == TORUS) {
    float phi = atan(p.y, length(p.xz) - 1.0);
    if (phi < 0.0) phi += TAU;
    return vec2(repeats * theta / TAU, phi / TAU);
  }
  return vec2(repeats * theta / TAU, (p.y + 1.0) * 0.5);   // cylinder and cone sides
}

// The direction u grows in, as each mesh's tangent attribute had it
vec3 tangentAt(int shape, int part, vec3 p) {
  if (shape == BOX) {
    if (part == 1) return vec3(-1.0, 0.0, 0.0);
    if (part == 4) return vec3(0.0, 0.0, -1.0);
    if (part == 5) return vec3(0.0, 0.0, 1.0);
    return vec3(1.0, 0.0, 0.0);
  }
  if ((shape == CYLINDER || shape == CONE) && part > 0) return vec3(1.0, 0.0, 0.0);
  // Around the y axis; the sphere's u runs the other way, but so does its
  // azimuth's sense, and both work out to (z, 0, -x)
  vec3 t = vec3(p.z, 0.0, -p.x);
  return dot(t, t) > 1e-12 ? t : vec3(1.0, 0.0, 0.0);
}

struct Surface {
  vec3 p;          // eye space
  vec3 ng;         // geometric normal, outward
  vec3 n;          // shading normal (bumped), outward
  vec3 base;       // texture color
  float emit;      // texture's emission (generated skins keep it in alpha)
  bool emissive;
};

// Bump height, as in HW6: dark is high (1 - Rec. 601 luminance)
float height(int unit, vec2 uv, vec2 gx, vec2 gy) {
  return 1.0 - dot(sampleTex(unit, uv, gx, gy).rgb, vec3(0.299, 0.587, 0.114));
}

// footprint: how wide a pixel's cone of rays is at the hit, in eye units. It
// stands in for the screen derivatives the GPU filters by, which don't exist
// inside the bounce loop: two points one footprint apart on the surface, how
// far apart they land in the texture.
Surface surfaceAt(vec3 o, vec3 d, Hit h, float footprint) {
  int i = h.id;
  ivec4 info = uInfo[i];
  float repeats = uMatD[i].w;
  Surface s;
  s.p = o + d * h.t;
  vec3 po = toObject(i, s.p, 1.0);
  // The inverse's transpose takes normals out; its inverse takes tangents
  mat3 normalToEye = mat3(uInv[3 * i].xyz, uInv[3 * i + 1].xyz, uInv[3 * i + 2].xyz);
  s.ng = normalize(normalToEye * h.n);
  vec3 T = inverse(transpose(normalToEye)) * tangentAt(info.x, h.part, po);
  T = normalize(T - dot(T, s.ng) * s.ng);
  vec3 B = cross(s.ng, T);
  s.n = s.ng;
  s.base = vec3(1.0);
  s.emit = 0.0;
  s.emissive = info.w == EMISSIVE;
  if (info.y < 0) return s;

  // A scrolling glow (the warp grilles) slides its texture along the part's
  // z axis, the same way on every face, so the flow runs aft on both sides
  vec3 slide = vec3(0.0, 0.0, uMatE[i].w);
  vec2 uv = uvAt(info.x, h.part, po - slide, repeats);
  // Footprint across the ray, and along it, stretched by how obliquely it lands
  vec3 e1 = cross(d, s.ng);
  e1 = dot(e1, e1) > 1e-8 ? normalize(e1) : T;
  vec3 e2 = cross(s.ng, e1) / max(abs(dot(d, s.ng)), 0.15);
  vec2 d1 = uvAt(info.x, h.part, toObject(i, s.p + e1 * footprint, 1.0) - slide, repeats) - uv;
  vec2 d2 = uvAt(info.x, h.part, toObject(i, s.p + e2 * footprint, 1.0) - slide, repeats) - uv;
  d1 -= round(d1); d2 -= round(d2);     // across a seam, the short way round

  vec4 tex = sampleTex(info.y, uv, d1, d2);
  s.base = tex.rgb;
  s.emit = tex.a;
  if (s.emissive) return s;

  vec3 nt = vec3(0.0, 0.0, 1.0);        // tangent space
  if (info.w == BUMP_MAPPING) {
    // Tilt the normal against the height field's slope, one texel either side
    // at the level being read, so a far surface's bumps soften with its color
    float bump = uMatB[i].w;
    if (bump != 0.0) {
      // The level is the one the footprint's longer axis reads
      vec2 size = texSize(info.y);
      float lod = max(log2(max(length(d1 * size), length(d2 * size))), 0.0);
      vec2 texel = exp2(lod) / size;
      vec2 du = vec2(texel.x, 0.0), dv = vec2(0.0, texel.y);
      float dhdu = (height(info.y, uv + du, d1, d2) - height(info.y, uv - du, d1, d2)) * 0.5 / exp2(lod);
      float dhdv = (height(info.y, uv + dv, d1, d2) - height(info.y, uv - dv, d1, d2)) * 0.5 / exp2(lod);
      nt = normalize(vec3(-bump * dhdu, -bump * dhdv, 1.0));
    }
  } else if (info.z >= 0) {
    nt = normalize(sampleTex(info.z, uv, d1, d2).rgb * 2.0 - 1.0);
  }
  s.n = normalize(mat3(T, B, s.ng) * nt);
  return s;
}

// ============================================================================
// Sky: a procedural star field on a sphere around the system, hashed by
// direction. The sphere is cut into the six faces of a cube and each face into
// a grid; each cell holds at most one star, with HW6's distribution -- a third
// of them crowded into a galactic band, a few bright and many faint, blue-white
// through orange, each twinkling on its own phase.
// ============================================================================
#define STAR_GRID 64.0

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 random3(uvec3 v) { return vec3(pcg3d(v)) * (1.0 / 4294967296.0); }

int cubeFace(vec3 s, out vec2 uv) {
  vec3 a = abs(s);
  if (a.x >= a.y && a.x >= a.z) { uv = s.yz / a.x; return s.x > 0.0 ? 0 : 1; }
  if (a.y >= a.z)               { uv = s.xz / a.y; return s.y > 0.0 ? 2 : 3; }
  uv = s.xy / a.z; return s.z > 0.0 ? 4 : 5;
}
vec3 cubeDir(int face, vec2 uv) {
  if (face < 2) return vec3(face == 0 ? 1.0 : -1.0, uv);
  if (face < 4) return vec3(uv.x, face == 2 ? 1.0 : -1.0, uv.y);
  return vec3(uv, face == 4 ? 1.0 : -1.0);
}

// The star in the cell under direction s (sky frame), lit for a pixel whose
// streak runs from s0 back to s1: 0 if the cell is empty or the star is off
// the streak
vec3 starLight(vec3 s, vec3 s0, vec3 s1, float streakPx) {
  vec2 uv;
  int face = cubeFace(s, uv);
  vec2 cell = floor((uv * 0.5 + 0.5) * STAR_GRID);
  vec2 mid = (cell + 0.5) / STAR_GRID * 2.0 - 1.0;
  vec3 r1 = random3(uvec3(uvec2(cell), uint(face) + 7u));
  vec3 r2 = random3(uvec3(uvec2(cell), uint(face) + 101u));
  // Cells near a face's corners cover less of the sky, so they hold a star
  // less often, keeping the density even; the band packs more in near the
  // sky's equator. Together: about 3000 stars, as in HW6.
  vec3 centerDir = normalize(cubeDir(face, mid));
  float area = pow(1.0 + dot(mid, mid), -1.5);
  float band = 1.0 + 2.28 * exp(-centerDir.y * centerDir.y / (2.0 * 0.175 * 0.175));
  if (r1.x > 0.155 * area * band) return vec3(0.0);

  vec3 star = normalize(cubeDir(face, (cell + 0.15 + 0.7 * r1.yz) / STAR_GRID * 2.0 - 1.0));
  float mag = r2.x * r2.x * r2.x;
  float temp = r2.y;
  float level = 0.45 + 0.55 * mag;
  vec3 color = level * vec3(0.80 + 0.30 * temp, 0.88 + 0.08 * abs(temp - 0.5), 1.10 - 0.35 * temp);
  float size = (1.1 + 2.3 * mag) * uStarScale;      // pixels across

  // Distance from the star to the streak, in pixels: a round dot when there
  // is no streak, a capsule when there is
  vec3 ab = s1 - s0;
  float k = dot(ab, ab) > 0.0 ? clamp(dot(star - s0, ab) / dot(ab, ab), 0.0, 1.0) : 0.0;
  float dist = length(star - (s0 + ab * k)) / uPixelAngle;
  // A star smaller than a pixel would flicker in and out as the view moves,
  // so it is drawn a pixel and a half across, dimmed by the extra area
  float radius = max(0.5 * size, 0.75);
  float a = 1.0 - smoothstep(0.35, 1.0, dist / radius);
  float twinkle = 0.78 + 0.22 * sin(uTime * 1.7 + r2.z * TAU);
  float spread = size / (size + uStreakDim * streakPx);
  float area2 = min(1.0, 0.25 * size * size / (radius * radius));
  return color * twinkle * spread * area2 * a;
}

vec3 sky(vec3 o, vec3 d) {
  // Where the ray leaves the sky's sphere: the stars sit at a real distance,
  // so they shift a little as the ship flies through them at warp
  vec3 oc = o - uSkyCenter;
  float b = dot(oc, d), c = dot(oc, oc) - uSkyRadius * uSkyRadius;
  float disc = b * b - c;
  float t = disc > 0.0 ? -b + sqrt(disc) : -1.0;
  vec3 p = t > 0.0 ? oc + d * t : d;
  vec3 s0 = normalize(p * uSkyRot);           // into the sky's own frame
  if (dot(uStreak, uStreak) == 0.0) return starLight(s0, s0, s0, 0.0);

  // At warp a pixel sees every star that passed through it during the
  // shutter: the ones that were, shutter seconds ago, back along the streak
  vec3 s1 = normalize((p - uStreak * uShutter) * uSkyRot);
  float angle = acos(clamp(dot(s0, s1), -1.0, 1.0));
  if (angle > uMaxStreak) {
    s1 = normalize(mix(s0, s1, uMaxStreak / angle));
    angle = uMaxStreak;
  }
  float streakPx = angle / uPixelAngle;
  // Look in every cell the streak crosses, a half cell apart, for the
  // brightest star on it
  int taps = int(clamp(ceil(angle * STAR_GRID * 4.0 / PI) + 1.0, 1.0, 16.0));
  vec3 best = vec3(0.0);
  for (int k = 0; k < 16; k++) {
    if (k >= taps) break;
    vec3 s = normalize(mix(s0, s1, taps == 1 ? 0.0 : float(k) / float(taps - 1)));
    best = max(best, starLight(s, s0, s1, streakPx));
  }
  return best;
}

// ============================================================================
// Shading
// ============================================================================

// Phong from every light, each through a shadow ray. The surface's own share
// -- what isn't mirror or glass -- takes the ambient and diffuse terms; the
// highlight is added in full, so glass still glints.
vec3 shadeLocal(Surface s, vec3 d, int i) {
  vec4 A = uMatA[i], B = uMatB[i];
  float body = max(1.0 - B.x - B.y, 0.0);
  vec3 V = -d;
  vec3 n = faceforward(s.n, d, s.ng);
  vec3 ng = faceforward(s.ng, d, s.ng);
  vec3 color = A.x * body * s.base;
  for (int j = 0; j < NUM_LIGHTS; j++) {
    vec3 toLight = uLightPos[j] - s.p;
    float dist = length(toLight);
    vec3 L = toLight / dist;
    float diff = dot(n, L);
    if (diff <= 0.0 || dot(ng, L) <= 0.0) continue;
    vec3 vis = uShadows ? transmittance(s.p + ng * EPS, L, dist) : vec3(1.0);
    if (vis == vec3(0.0)) continue;
    // Attenuation 1 / (a + c d^2), scaled to 1 at the light's reference
    // distance: the planet keeps its brightness, but the near side of
    // everything is lit harder than the far. Past the light's reach it stops
    // falling off, so the ship stays lit as it warps out of the system.
    float ref2 = uLightRange[j].x * uLightRange[j].x;
    float d = min(dist, uLightRange[j].y);
    float att = uAttenuation ? 2.0 * ref2 / (ref2 + d * d) : 1.0;
    float spec = pow(max(dot(V, reflect(-L, n)), 0.0), A.w * uShininessScale);
    color += uLightColor[j] * vis * att * (A.y * body * s.base * diff + A.z * spec);
  }
  // Lit windows and lights in the skin shine whatever the lighting, so they
  // stay bright on the night side
  color += uMatE[i].x * s.emit * s.base;
  // The planet's atmosphere, as in HW6: a glow at the limb, on the sunlit side
  vec3 glow = uMatC[i].rgb;
  if (glow != vec3(0.0)) {
    float rim = pow(1.0 - max(dot(ng, V), 0.0), 3.0);
    float day = smoothstep(-0.25, 0.5, dot(ng, normalize(uLightPos[0] - s.p)));
    color += glow * rim * day;
  }
  return color;
}

// The ray through this pixel. The warp lens (camera.js) is HW6's projection
// run backwards: a rectilinear direction, and an equisolid fisheye one with
// its vertical stretch undone, blended as the lens opens. Outside the
// fisheye's image circle there is nothing to see.
bool primaryRay(out vec3 d) {
  vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
  d = normalize(vec3(ndc.x / uProj00, ndc.y / uProj11, -1.0));
  if (uFisheye <= 0.0) return true;
  float aspect = uProj11 / uProj00;
  vec2 q = vec2(ndc.x, (uFishPivot + (ndc.y - uFishPivot) / uFishStretch) / aspect);
  float k = length(q) * sin(0.5 * uFishHalfX);
  if (k >= 1.0) return uFisheye < 1.0;
  float theta = 2.0 * asin(k);
  vec2 dir = length(q) > 1e-6 ? normalize(q) : vec2(0.0);
  vec3 fish = vec3(sin(theta) * dir, -cos(theta));
  d = normalize(mix(d, fish, uFisheye));
  return true;
}

// One ray of the tree still to be followed
struct Path {
  vec3 o, d;
  vec3 weight;       // how much of the pixel it accounts for
  vec3 absorb;       // per unit length, while it travels inside glass
  float travelled;   // distance from the eye, for texture filtering
  int depth;         // bounces so far
};

float maxComponent(vec3 v) { return max(v.r, max(v.g, v.b)); }

// The recursion, as a loop. Each pass follows the current path one segment:
// it adds that hit's local shading, then turns into the reflected or
// refracted ray. Glass splits the path in two: the stronger branch carries
// on here and the weaker waits on a small stack, picked up once the current
// path ends. Every function that traces, shades or samples the sky is called
// from exactly one place below: GLSL inlines every call, and a ray tracer
// with several call sites grows past what some GPU compilers will take.
void main() {
  vec3 d0;
  if (!primaryRay(d0)) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  Path stack[STACK_SIZE];
  int top = 0;
  Path p = Path(vec3(0.0), d0, vec3(1.0), vec3(0.0), 0.0, 0);
  bool live = true;
  vec3 color = vec3(0.0);

  for (int segment = 0; segment < MAX_SEGMENTS; segment++) {
    if (!live) {
      if (top == 0) break;
      p = stack[--top];
      live = true;
    }
    Hit h = trace(p.o, p.d, INF);
    if (h.id < 0) {
      color += p.weight * sky(p.o, p.d);
      live = false;
      continue;
    }
    // Beer-Lambert: glass soaks up light over the distance through it
    p.weight *= exp(-p.absorb * h.t);
    p.travelled += h.t;
    Surface s = surfaceAt(p.o, p.d, h, p.travelled * uPixelAngle);
    if (s.emissive) {
      color += p.weight * s.base * uMatE[h.id].z;   // its power (the engines' levels, ship.js)
      live = false;
      continue;
    }
    color += p.weight * shadeLocal(s, p.d, h.id);

    vec4 B = uMatB[h.id];
    if (p.depth >= uBounces || (B.x <= 0.0 && B.y <= 0.0)) {
      live = false;
      continue;
    }
    p.depth++;

    if (B.y > 0.0) {
      // Glass. n faces the incoming ray; entering means going from vacuum in.
      bool entering = dot(p.d, s.ng) < 0.0;
      vec3 n = entering ? s.n : -s.n;
      vec3 ng = entering ? s.ng : -s.ng;
      float eta = entering ? 1.0 / B.z : B.z;
      vec3 rdir = reflect(p.d, n);
      vec3 tdir = refract(p.d, n, eta);
      vec3 outside = s.p + ng * EPS, inside = s.p - ng * EPS;
      if (tdir == vec3(0.0)) {
        // Total internal reflection: all of it stays in the glass
        p.o = outside; p.d = rdir; p.weight *= B.y;
      } else {
        // Schlick, with the angle on the vacuum side
        float c = entering ? -dot(p.d, n) : -dot(tdir, n);
        float r0 = (B.z - 1.0) / (B.z + 1.0);
        r0 *= r0;
        float F = r0 + (1.0 - r0) * pow(1.0 - c, 5.0);
        // The reflected ray stays in the medium it came from; the refracted
        // one crosses into glass, or back out of it
        Path reflected = Path(outside, rdir, p.weight * B.y * F, p.absorb, p.travelled, p.depth);
        Path refracted = Path(inside, tdir, p.weight * B.y * (1.0 - F),
                              entering ? uMatD[h.id].rgb : vec3(0.0), p.travelled, p.depth);
        Path weaker;
        if (F <= 0.5) { p = refracted; weaker = reflected; }
        else          { p = reflected; weaker = refracted; }
        if (top < STACK_SIZE && maxComponent(weaker.weight) > 0.01) stack[top++] = weaker;
      }
    } else {
      // Mirror: polished hull, copper dish
      p.o = s.p + faceforward(s.ng, p.d, s.ng) * EPS;
      p.d = reflect(p.d, faceforward(s.n, p.d, s.ng));
      p.weight *= B.x;
    }
    if (maxComponent(p.weight) < 0.01) live = false;
  }
  fragColor = vec4(color, 1.0);
}
`;
