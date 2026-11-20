// The ray tracer: one full-screen pass whose fragment shader does all the work.
//
// The scene arrives as a list of primitives, each a unit shape (models.js's
// conventions from HW6: sphere of radius 1, cylinder and cone along y in
// [-1, 1], box [-1, 1]^3, torus of ring radius 1 in the xz plane, plus a
// flat-top hexagonal prism of apothem 1 in xy and |z| <= 1) plus the
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

const MAX_PRIMS = 33;      // the scene has 33: 31 ship parts, the planet, the moon
const MAX_GROUPS = 4;      // the ship uses 4: saucer, hull, and each pylon with its nacelle
const MAX_SEGMENTS = 12;   // ray segments traced per pixel, across all branches
const STACK_SIZE = 4;      // glass branches waiting their turn
const NUM_LIGHTS = 4;
const SPHERE = 0, CYLINDER = 1, CONE = 2, BOX = 3, TORUS = 4, HEX_PRISM = 5;
// The mapping modes, as in HW6
const BUMP_MAPPING = 0, NORMAL_MAPPING = 1, EMISSIVE = 2;
// Texture units in use (main.js binds them); the shader samples each by a
// constant index, since GLSL ES can't index a sampler array with a variable.
// 16 is all WebGL 2 promises.
const TEXTURE_UNITS = 16;

// Warp streaks, as in HW6's point sprites: each star is smeared over the path
// it covers in `shutter` seconds, at most `max` CSS pixels long, and dims as
// its light is spread along that path
const STREAK = { shutter: 0.3, max: 75, dim: 0.08 };

// The near star field (see the shader's Sky section): an endless grid of
// `cell`-unit cubes, each holding a star with chance `density` (up to three
// times that in the galaxy's disc, `disc` units thick either side of y = 0).
// None within `clear` of the system, so they stay behind everything the
// camera can frame; past `reach` from the eye they have faded into the
// distant layer. A star `ref` away shines at its base level.
const STAR_FIELD = { cell: 8, density: 0.06, disc: 30, clear: 36, reach: 160, ref: 60, steps: 40 };
// At warp the near field fills in: every cell's chance of a star rises to
// `density` times its usual (capped at `cap`) as the ship jumps, the new stars
// fading in over `fadeIn` seconds -- several times the streaks for no extra
// steps of the walk.
const WARP_STARS = { density: 5, cap: 0.75, fadeIn: 0.5 };
const glslFloat = x => Number.isInteger(x) ? x.toFixed(1) : String(x);

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

const RAYTRACE_FS_PREFIX = `#version 300 es
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
#define HEX_PRISM ${HEX_PRISM}
#define BUMP_MAPPING ${BUMP_MAPPING}
#define NORMAL_MAPPING ${NORMAL_MAPPING}
#define EMISSIVE ${EMISSIVE}

#define INF 1e20
#define EPS 2e-4        // how far a new ray starts off the surface it leaves
#define PI 3.14159265
#define TAU 6.28318531
#define HEX_S3 0.86602540378

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
uniform float uSpecularScale;

uniform sampler2D uTex[TEXTURE_UNITS];
uniform float uTime;

// ---- sky -------------------------------------------------------------------
uniform vec3 uSkyCenter;      // the system's center, eye space
uniform mat3 uSkyRot;         // the sky frame's axes in eye space
uniform vec3 uStreak;        // the stars' velocity past the eye, eye space
uniform float uShutter, uMaxStreak, uStreakDim;
uniform float uStarScale;     // pixels rendered per CSS pixel
uniform float uWarpStars;     // 0..1, how far the warp's extra stars have faded in
uniform float uSkySeed;       // fresh random seed per run for stars and backdrop

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
  float c = dot(o, o) - 1.0;
  float b = dot(o, d);
  if (b > 0.0 && c > 0.0) return false;
  float a = dot(d, d);
  float disc = b * b - a * c;
  if (disc < 0.0) return false;
  float s = sqrt(disc);
  float invA = 1.0 / a;
  float th = (-b - s) * invA;
  if (th <= tmin) th = (-b + s) * invA;     // starting inside: the far side
  if (th <= tmin || th >= t) return false;
  t = th;
  n = o + d * th;
  return true;
}

// Side: x^2 + z^2 = 1 for |y| <= 1 (part 0); caps at y = 1 (part 1), y = -1 (part 2)
bool hitCylinder(vec3 o, vec3 d, float tmin, inout float t, out vec3 n, out int part) {
  float c = dot(o.xz, o.xz) - 1.0;
  float b = dot(o.xz, d.xz);
  if (b > 0.0 && c > 0.0) return false;
  bool found = false;
  float a = dot(d.xz, d.xz);
  float disc = b * b - a * c;
  if (a > 1e-12 && disc >= 0.0) {
    float invA = 1.0 / a;
    float s = sqrt(disc);
    float th0 = (-b - s) * invA;
    if (th0 > tmin && th0 < t) {
      vec3 p = o + d * th0;
      if (abs(p.y) <= 1.0) {
        t = th0; n = vec3(p.x, 0.0, p.z); part = 0; found = true;
      }
    }
    if (!found) {
      float th1 = (-b + s) * invA;
      if (th1 > tmin && th1 < t) {
        vec3 p = o + d * th1;
        if (abs(p.y) <= 1.0) {
          t = th1; n = vec3(p.x, 0.0, p.z); part = 0; found = true;
        }
      }
    }
  }
  if (abs(d.y) > 1e-12) {
    float invDy = 1.0 / d.y;
    float thTop = (1.0 - o.y) * invDy;
    if (thTop > tmin && thTop < t) {
      vec3 p = o + d * thTop;
      if (dot(p.xz, p.xz) <= 1.0) {
        t = thTop; n = vec3(0.0, 1.0, 0.0); part = 1; found = true;
      }
    }
    float thBot = (-1.0 - o.y) * invDy;
    if (thBot > tmin && thBot < t) {
      vec3 p = o + d * thBot;
      if (dot(p.xz, p.xz) <= 1.0) {
        t = thBot; n = vec3(0.0, -1.0, 0.0); part = 2; found = true;
      }
    }
  }
  return found;
}

// Side: radius (1 - y) / 2, so x^2 + z^2 = k (1 - y)^2 with k = 1/4, for
// |y| <= 1 (part 0); base cap at y = -1 (part 1)
bool hitCone(vec3 o, vec3 d, float tmin, inout float t, out vec3 n, out int part) {
  if ((d.y > 0.0 && o.y > 1.0) || (d.y < 0.0 && o.y < -1.0)) return false;
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
      float invA = 1.0 / a;
      float s = sqrt(disc);
      t0 = (-b - s) * invA; t1 = (-b + s) * invA;
      if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }
    }
  }
  if (t0 > tmin && t0 < t) {
    vec3 p = o + d * t0;
    if (abs(p.y) <= 1.0) {
      vec3 cn = vec3(p.x, k * (1.0 - p.y), p.z);
      t = t0; n = dot(cn, cn) > 1e-12 ? cn : vec3(0.0, 1.0, 0.0); part = 0; found = true;
    }
  }
  if (!found && t1 > tmin && t1 < t) {
    vec3 p = o + d * t1;
    if (abs(p.y) <= 1.0) {
      vec3 cn = vec3(p.x, k * (1.0 - p.y), p.z);
      t = t1; n = dot(cn, cn) > 1e-12 ? cn : vec3(0.0, 1.0, 0.0); part = 0; found = true;
    }
  }
  if (abs(d.y) > 1e-12) {
    float th = (-1.0 - o.y) / d.y;
    if (th > tmin && th < t) {
      vec3 p = o + d * th;
      if (dot(p.xz, p.xz) <= 1.0) {
        t = th; n = vec3(0.0, -1.0, 0.0); part = 1; found = true;
      }
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

// Four-slab test for a flat-top regular hexagonal prism along z (apothem 1 in xy):
// |y| <= lim.x, |s3*x + 0.5*y| <= lim.y, |-s3*x + 0.5*y| <= lim.z, |z| <= lim.w
vec2 hexSpan(vec3 o, vec3 d, vec4 lim) {
  vec4 op = vec4(o.y, HEX_S3 * o.x + 0.5 * o.y, -HEX_S3 * o.x + 0.5 * o.y, o.z);
  vec4 dp = vec4(d.y, HEX_S3 * d.x + 0.5 * d.y, -HEX_S3 * d.x + 0.5 * d.y, d.z);
  vec4 inv = 1.0 / (dp + vec4(equal(dp, vec4(0.0))) * 1e-12);
  vec4 ta = (-lim - op) * inv, tb = (lim - op) * inv;
  vec4 tn = min(ta, tb), tf = max(ta, tb);
  return vec2(max(max(tn.x, tn.y), max(tn.z, tn.w)), min(min(tf.x, tf.y), min(tf.z, tf.w)));
}
float hexPrismEval(vec3 q) {
  float dY = abs(q.y);
  return max(max(dY, HEX_S3 * abs(q.x) + 0.5 * dY), abs(q.z)) - 1.0;
}
vec3 hexPrismNormal(vec3 q, out int part) {
  float dY = abs(q.y);
  float dH = HEX_S3 * abs(q.x) + 0.5 * dY;
  float dZ = abs(q.z);
  if (dZ >= dY && dZ >= dH) {
    part = q.z >= 0.0 ? 0 : 1;
    return vec3(0.0, 0.0, q.z >= 0.0 ? 1.0 : -1.0);
  }
  if (dY >= dH) {
    part = q.y >= 0.0 ? 2 : 3;
    return vec3(0.0, q.y >= 0.0 ? 1.0 : -1.0, 0.0);
  }
  float sx = q.x >= 0.0 ? 1.0 : -1.0;
  float sy = q.y >= 0.0 ? 1.0 : -1.0;
  part = q.x >= 0.0 ? (q.y >= 0.0 ? 4 : 5) : (q.y >= 0.0 ? 6 : 7);
  return vec3(HEX_S3 * sx, 0.5 * sy, 0.0);
}
bool hitHexPrism(vec3 o, vec3 d, float tmin, inout float t, out vec3 n, out int part) {
  vec2 span = hexSpan(o, d, vec4(1.0));
  if (span.x > span.y) return false;
  float th = span.x > tmin ? span.x : span.y;
  if (th <= tmin || th >= t) return false;
  t = th;
  n = hexPrismNormal(o + d * th, part);
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
  if (b > 0.0 && c > 0.0) return false;
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
  for (int i = 0; i < 32; i++) {
    vec3 p = o + u * x;
    float h = torusDistance(p, r);
    if (h < 1e-4) {
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

// ---- HW3 wavy ripple (glass hexagonal prism only) --------------------------
bool isWavyHex(int i) {
  return uMatE[i].y < -0.5 && uInfo[i].x == HEX_PRISM && uMatB[i].y > 0.0;
}
float wavyOffset(vec3 p) {
  return 0.12 * sin(uTime * 3.0 + p.x * 2.5 + p.z * 2.5);
}
float wavyHexEval(vec3 p) {
  return hexPrismEval(vec3(p.x, p.y - wavyOffset(p), p.z));
}
vec3 wavyHexNormal(vec3 p, out int part) {
  vec3 q = vec3(p.x, p.y - wavyOffset(p), p.z);
  vec3 g = hexPrismNormal(q, part);
  float dw = 0.12 * 2.5 * cos(uTime * 3.0 + p.x * 2.5 + p.z * 2.5);
  return vec3(g.x - g.y * dw, g.y, g.z - g.y * dw);
}

// Coarse scan + bisection/secant inside the displaced hex prism's tight bounding prism
bool hitWavyHex(vec3 o, vec3 d, float tmin, inout float t, out vec3 n, out int part) {
  vec2 span = hexSpan(o, d, vec4(1.122, 1.062, 1.062, 1.002));
  float t0 = max(span.x, tmin), t1 = min(span.y, t);
  if (t0 >= t1) return false;

  float prevT = t0, prevV = wavyHexEval(o + d * t0);
  bool startIn = prevV <= 0.0;
  float dt = (t1 - t0) / 32.0;

  for (int s = 1; s <= 32; s++) {
    float curT = t0 + dt * float(s);
    float curV = wavyHexEval(o + d * curT);
    if ((curV <= 0.0) != startIn) {
      float a = prevT, b = curT, va = prevV, vb = curV;
      for (int k = 0; k < 12; k++) {
        float denom = vb - va;
        float m = (k < 8 || abs(denom) < 1e-12)
          ? 0.5 * (a + b)
          : mix(a, b, clamp(-va / denom, 0.1, 0.9));
        float vm = wavyHexEval(o + d * m);
        if ((vm <= 0.0) == (va <= 0.0)) { a = m; va = vm; }
        else { b = m; vb = vm; }
      }
      float denom = vb - va;
      float th = abs(denom) > 1e-12 ? mix(a, b, clamp(-va / denom, 0.0, 1.0)) : 0.5 * (a + b);
      t = th;
      n = wavyHexNormal(o + d * th, part);
      return true;
    }
    prevT = curT; prevV = curV;
  }
  return false;
}

float wavyHexChord(vec3 o, vec3 d, float tmin, float tmax) {
  vec2 span = hexSpan(o, d, vec4(1.122, 1.062, 1.062, 1.002));
  float t0 = max(span.x, tmin), t1 = min(span.y, tmax);
  if (t0 >= t1) return 0.0;
  float dt = (t1 - t0) / 16.0;
  float prevV = wavyHexEval(o + d * t0);
  float chord = 0.0;
  for (int s = 1; s <= 16; s++) {
    float curV = wavyHexEval(o + d * (t0 + dt * float(s)));
    if (prevV <= 0.0 && curV <= 0.0) {
      chord += dt;
    } else if ((prevV <= 0.0) != (curV <= 0.0)) {
      float denom = curV - prevV;
      float frac = abs(denom) > 1e-12 ? clamp(-prevV / denom, 0.0, 1.0) : 0.5;
      chord += dt * (prevV <= 0.0 ? frac : 1.0 - frac);
    }
    prevV = curV;
  }
  return chord;
}

bool intersect(int i, vec3 o, vec3 d, float tmin, inout float t, out vec3 n, out int part) {
  vec3 oo = toObject(i, o, 1.0), dd = toObject(i, d, 0.0);
  part = 0;
  if (isWavyHex(i))      return hitWavyHex(oo, dd, tmin, t, n, part);
  int shape = uInfo[i].x;
  if (shape == SPHERE)   return hitSphere(oo, dd, tmin, t, n);
  if (shape == CYLINDER) return hitCylinder(oo, dd, tmin, t, n, part);
  if (shape == CONE)     return hitCone(oo, dd, tmin, t, n, part);
  if (shape == BOX)      return hitBox(oo, dd, tmin, t, n, part);
  if (shape == HEX_PRISM) return hitHexPrism(oo, dd, tmin, t, n, part);
  return hitTorus(oo, dd, uMatC[i].w, tmin, t, n);
}

// Fast boolean shadow occlusion tests without computing normals or face parts
bool shadowSphere(vec3 o, vec3 d, float tmin, float tmax) {
  float c = dot(o, o) - 1.0;
  float b = dot(o, d);
  if (b > 0.0 && c > 0.0) return false;
  float a = dot(d, d);
  float disc = b * b - a * c;
  if (disc < 0.0) return false;
  float s = sqrt(disc);
  float invA = 1.0 / a;
  float th = (-b - s) * invA;
  if (th <= tmin) th = (-b + s) * invA;
  return th > tmin && th < tmax;
}

bool shadowCylinder(vec3 o, vec3 d, float tmin, float tmax) {
  float c = dot(o.xz, o.xz) - 1.0;
  float b = dot(o.xz, d.xz);
  if (b > 0.0 && c > 0.0) return false;
  float a = dot(d.xz, d.xz);
  float disc = b * b - a * c;
  if (a > 1e-12 && disc >= 0.0) {
    float invA = 1.0 / a;
    float s = sqrt(disc);
    float th0 = (-b - s) * invA;
    if (th0 > tmin && th0 < tmax && abs(o.y + d.y * th0) <= 1.0) return true;
    float th1 = (-b + s) * invA;
    if (th1 > tmin && th1 < tmax && abs(o.y + d.y * th1) <= 1.0) return true;
  }
  if (abs(d.y) > 1e-12) {
    float invDy = 1.0 / d.y;
    float thTop = (1.0 - o.y) * invDy;
    if (thTop > tmin && thTop < tmax) {
      vec2 p = o.xz + d.xz * thTop;
      if (dot(p, p) <= 1.0) return true;
    }
    float thBot = (-1.0 - o.y) * invDy;
    if (thBot > tmin && thBot < tmax) {
      vec2 p = o.xz + d.xz * thBot;
      if (dot(p, p) <= 1.0) return true;
    }
  }
  return false;
}

bool shadowCone(vec3 o, vec3 d, float tmin, float tmax) {
  if ((d.y > 0.0 && o.y > 1.0) || (d.y < 0.0 && o.y < -1.0)) return false;
  const float k = 0.25;
  float h = 1.0 - o.y;
  float a = dot(d.xz, d.xz) - k * d.y * d.y;
  float b = dot(o.xz, d.xz) + k * h * d.y;
  float c = dot(o.xz, o.xz) - k * h * h;
  if (abs(a) < 1e-9) {
    if (abs(b) > 1e-12) {
      float th = -c / (2.0 * b);
      if (th > tmin && th < tmax && abs(o.y + d.y * th) <= 1.0) return true;
    }
  } else {
    float disc = b * b - a * c;
    if (disc >= 0.0) {
      float invA = 1.0 / a;
      float s = sqrt(disc);
      float th0 = (-b - s) * invA;
      if (th0 > tmin && th0 < tmax && abs(o.y + d.y * th0) <= 1.0) return true;
      float th1 = (-b + s) * invA;
      if (th1 > tmin && th1 < tmax && abs(o.y + d.y * th1) <= 1.0) return true;
    }
  }
  if (abs(d.y) > 1e-12) {
    float th = (-1.0 - o.y) / d.y;
    if (th > tmin && th < tmax) {
      vec2 p = o.xz + d.xz * th;
      if (dot(p, p) <= 1.0) return true;
    }
  }
  return false;
}

bool shadowBox(vec3 o, vec3 d, float tmin, float tmax) {
  vec2 span = boxSpan(o, d, vec3(1.0));
  if (span.x > span.y) return false;
  float th = span.x > tmin ? span.x : span.y;
  return th > tmin && th < tmax;
}

bool shadowHexPrism(vec3 o, vec3 d, float tmin, float tmax) {
  vec2 span = hexSpan(o, d, vec4(1.0));
  if (span.x > span.y) return false;
  float th = span.x > tmin ? span.x : span.y;
  return th > tmin && th < tmax;
}

bool shadowTorus(vec3 o, vec3 d, float r, float tmin, float tmax) {
  float len = length(d);
  vec3 u = d / len;
  float b = dot(o, u), c = dot(o, o) - (1.0 + r) * (1.0 + r);
  if (b > 0.0 && c > 0.0) return false;
  float disc = b * b - c;
  if (disc < 0.0) return false;
  float s = sqrt(disc);
  float x0 = -b - s, x1 = -b + s;
  if (abs(u.y) > 1e-6) {
    float ya = (-r - o.y) / u.y, yb = (r - o.y) / u.y;
    x0 = max(x0, min(ya, yb)); x1 = min(x1, max(ya, yb));
  } else if (abs(o.y) > r) return false;
  x0 = max(x0, tmin * len); x1 = min(x1, tmax * len);
  if (x0 >= x1) return false;
  float x = x0;
  for (int k = 0; k < 20; k++) {
    float h = torusDistance(o + u * x, r);
    if (h < 1.5e-4) return true;
    x += h;
    if (x > x1) return false;
  }
  return false;
}

bool shadowHit(int i, vec3 o, vec3 d, float tmin, float tmax) {
  vec3 oo = toObject(i, o, 1.0), dd = toObject(i, d, 0.0);
  int shape = uInfo[i].x;
  if (shape == BOX)       return shadowBox(oo, dd, tmin, tmax);
  if (shape == HEX_PRISM) return shadowHexPrism(oo, dd, tmin, tmax);
  if (shape == SPHERE)    return shadowSphere(oo, dd, tmin, tmax);
  if (shape == CYLINDER)  return shadowCylinder(oo, dd, tmin, tmax);
  if (shape == CONE)      return shadowCone(oo, dd, tmin, tmax);
  return shadowTorus(oo, dd, uMatC[i].w, tmin, tmax);
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
  float c = dot(o, o) - 1.0;
  float b = dot(o, d);
  if (b > 0.0 && c > 0.0) return 0.0;
  float a = dot(d, d);
  float disc = b * b - a * c;
  if (disc < 0.0) return 0.0;
  float invA = 1.0 / a;
  float s = sqrt(disc);
  return max(min((-b + s) * invA, tmax) - max((-b - s) * invA, tmin), 0.0);
}

// How much of (tmin, tmax) the ray spends inside primitive i (glass hex prism, box, or sphere)
float glassChord(int i, vec3 o, vec3 d, float tmin, float tmax) {
  vec3 oo = toObject(i, o, 1.0), dd = toObject(i, d, 0.0);
  if (isWavyHex(i)) return wavyHexChord(oo, dd, tmin, tmax);
  if (uInfo[i].x == HEX_PRISM) {
    vec2 span = hexSpan(oo, dd, vec4(1.0));
    return max(min(span.y, tmax) - max(span.x, tmin), 0.0);
  }
  if (uInfo[i].x == BOX) {
    vec2 span = boxSpan(oo, dd, vec3(1.0));
    return max(min(span.y, tmax) - max(span.x, tmin), 0.0);
  }
  return sphereChord(oo, dd, tmin, tmax);
}

// Shadow ray: how much light gets from o to dist along d. An opaque part
// blocks it; glass lets through its transmittance, less what it absorbs over
// the chord the ray cuts through it (Beer-Lambert), so glass casts a pale
// colored shadow instead of a black one. Glowing parts are light sources
// themselves and cast none.
vec3 transmittance(vec3 o, vec3 d, float dist) {
  vec3 tr = vec3(1.0);
  int ungrouped = uGroupCount > 0 ? uGroupRange[0].x : uCount;
  for (int i = 0; i < ungrouped; i++) {
    if (uInfo[i].w == EMISSIVE) continue;
    float kt = uMatB[i].y;
    if (kt <= 0.0) {
      if (shadowHit(i, o, d, EPS, dist)) return vec3(0.0);
    } else {
      float chord = glassChord(i, o, d, EPS, dist);
      if (chord > 0.0) tr *= kt * exp(-uMatD[i].rgb * chord);
    }
  }
  for (int g = 0; g < MAX_GROUPS; g++) {
    if (g >= uGroupCount) break;
    if (!groupVisible(g, o, d, EPS, dist)) continue;
    for (int i = uGroupRange[g].x; i < uGroupRange[g].y; i++) {
      if (uInfo[i].w == EMISSIVE) continue;
      float kt = uMatB[i].y;
      if (kt <= 0.0) {
        if (shadowHit(i, o, d, EPS, dist)) return vec3(0.0);
      } else {
        float chord = glassChord(i, o, d, EPS, dist);
        if (chord > 0.0) tr *= kt * exp(-uMatD[i].rgb * chord);
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
  if (shape == HEX_PRISM) {
    if (part < 2) return vec2(part == 0 ? p.x : -p.x, p.y) * 0.5 + 0.5;
    float ang = atan(p.y, p.x);
    if (ang < 0.0) ang += TAU;
    return vec2(repeats * ang / TAU, (p.z + 1.0) * 0.5);
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
  if (shape == HEX_PRISM) {
    if (part < 2) return vec3(part == 0 ? 1.0 : -1.0, 0.0, 0.0);
    vec3 t = vec3(-p.y, p.x, 0.0);
    return dot(t, t) > 1e-12 ? t : vec3(1.0, 0.0, 0.0);
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
  // The inverse's transpose takes normals out
  mat3 normalToEye = mat3(uInv[3 * i].xyz, uInv[3 * i + 1].xyz, uInv[3 * i + 2].xyz);
  s.ng = normalize(normalToEye * h.n);
  s.n = s.ng;
  s.base = vec3(1.0);
  s.emit = 0.0;
  s.emissive = info.w == EMISSIVE;
  if (info.y < 0) {
    if (s.emissive && uMatC[i].rgb != vec3(0.0)) s.base = uMatC[i].rgb;
    return s;
  }

  vec3 po = toObject(i, s.p, 1.0);
  // A scrolling glow (the warp grilles) slides its texture along the part's
  // z axis, the same way on every face, so the flow runs aft on both sides
  vec3 slide = vec3(0.0, 0.0, uMatE[i].w);
  vec2 uv = uvAt(info.x, h.part, po - slide, repeats);
  // Footprint across the ray, and along it, stretched by how obliquely it lands
  vec3 e1 = cross(d, s.ng);
  e1 = dot(e1, e1) > 1e-8 ? normalize(e1) : (abs(s.ng.y) < 0.99 ? normalize(cross(s.ng, vec3(0.0, 1.0, 0.0))) : vec3(1.0, 0.0, 0.0));
  vec3 e2 = cross(s.ng, e1) / max(abs(dot(d, s.ng)), 0.15);
  vec2 d1 = uvAt(info.x, h.part, toObject(i, s.p + e1 * footprint, 1.0) - slide, repeats) - uv;
  vec2 d2 = uvAt(info.x, h.part, toObject(i, s.p + e2 * footprint, 1.0) - slide, repeats) - uv;
  d1 -= round(d1); d2 -= round(d2);     // across a seam, the short way round

  vec4 tex = sampleTex(info.y, uv, d1, d2);
  s.base = tex.rgb;
  s.emit = tex.a;
  if (s.emissive) return s;

  if (info.w == BUMP_MAPPING) {
    float bump = uMatB[i].w;
    if (bump != 0.0) {
      vec3 T = inverse(transpose(normalToEye)) * tangentAt(info.x, h.part, po);
      T = normalize(T - dot(T, s.ng) * s.ng);
      vec3 B = cross(s.ng, T);
      vec2 size = texSize(info.y);
      float lod = max(log2(max(length(d1 * size), length(d2 * size))), 0.0);
      float scaleExp = exp2(lod);
      vec2 texel = scaleExp / size;
      vec2 du = vec2(texel.x, 0.0), dv = vec2(0.0, texel.y);
      float invScale = 0.5 / scaleExp;
      float dhdu = (height(info.y, uv + du, d1, d2) - height(info.y, uv - du, d1, d2)) * invScale;
      float dhdv = (height(info.y, uv + dv, d1, d2) - height(info.y, uv - dv, d1, d2)) * invScale;
      vec3 nt = normalize(vec3(-bump * dhdu, -bump * dhdv, 1.0));
      s.n = normalize(mat3(T, B, s.ng) * nt);
    }
  } else if (info.z >= 0) {
    vec3 T = inverse(transpose(normalToEye)) * tangentAt(info.x, h.part, po);
    T = normalize(T - dot(T, s.ng) * s.ng);
    vec3 B = cross(s.ng, T);
    vec3 nt = normalize(sampleTex(info.z, uv, d1, d2).rgb * 2.0 - 1.0);
    s.n = normalize(mat3(T, B, s.ng) * nt);
  }
  return s;
}

// ============================================================================
// Sky, in three layers, all in the sky's own frame: fixed to the system,
// centered on it, its y axis the galaxy's pole.
//
//   backdrop      at infinity: the galaxy's band of unresolved stars with dark
//                 dust lanes along it, its core glowing warmer, and two
//                 nebulae -- all from one three-channel fractal noise
//   distant stars at infinity too, hashed by direction (HW6's distribution:
//                 crowded into the band, a few bright and many faint, blue-
//                 white through orange). They hold still even at warp, as
//                 anything that far away would.
//   near stars    at real points in space: an endless grid of cells, each
//                 holding at most one star, walked cell by cell along the ray.
//                 There is no edge to fly out of -- the ship can head off in
//                 any direction for as long as it likes. They brighten as it
//                 closes on them, and at warp each streaks by its own
//                 parallax: the near ones long, the far ones barely.
// ============================================================================
#define STAR_GRID 64.0
#define STAR_CELL ${glslFloat(STAR_FIELD.cell)}
#define STAR_DENSITY ${glslFloat(STAR_FIELD.density)}
#define STAR_DISC ${glslFloat(STAR_FIELD.disc)}
#define STAR_CLEAR ${glslFloat(STAR_FIELD.clear)}
#define STAR_REACH ${glslFloat(STAR_FIELD.reach)}
#define STAR_REF ${glslFloat(STAR_FIELD.ref)}
#define STAR_STEPS ${STAR_FIELD.steps}
#define WARP_STAR_DENSITY ${glslFloat(WARP_STARS.density)}
#define WARP_STAR_CAP ${glslFloat(WARP_STARS.cap)}
// Cell coordinates are offset before hashing, so negative ones don't lean on
// how int converts to uint
#define CELL_BIAS 32768

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 random3(uvec3 v) {
  uint s = uint(uSkySeed);
  return vec3(pcg3d(v ^ uvec3(s * 2654435761u, s * 2246822519u, s * 3266489917u))) * (1.0 / 4294967296.0);
}

// ---- backdrop --------------------------------------------------------------

// The sky glow (Milky Way, warm starlight, nebula clouds) is pre-baked on the
// CPU into unit 15 in sqrt space so 8-bit quantization holds down to deep
// blacks; squaring recovers linear light.
vec3 backdrop(vec3 s) {
  float phi = atan(s.z, s.x);
  float theta = acos(clamp(s.y, -1.0, 1.0));
  vec3 c = textureLod(uTex[15], vec2(phi / TAU, theta / PI), 0.0).rgb;
  return c * c;
}

// ---- stars -----------------------------------------------------------------

vec3 starColor(float temp) {
  // Subtle per-seed spectral skew so some skies lean young OB-blue and others warm K/M-gold
  float skew = mix(0.75, 1.35, fract(uSkySeed * 0.61803398875));
  float t = pow(clamp(temp, 1e-4, 1.0), skew);
  vec3 hot  = vec3(0.58, 0.78, 1.18);
  vec3 mid  = vec3(1.00, 0.98, 0.95);
  vec3 warm = vec3(1.14, 0.78, 0.42);
  vec3 cool = vec3(1.10, 0.44, 0.24);
  if (t < 0.36) return mix(hot, mid, t / 0.36);
  if (t < 0.72) return mix(mid, warm, (t - 0.36) / 0.36);
  return mix(warm, cool, (t - 0.72) / 0.28);
}

// Pixels from direction d to the streak running from s0 back to s1 (a round
// dot when they are the same)
float pixelsFrom(vec3 d, vec3 s0, vec3 s1) {
  vec3 ab = s1 - s0;
  float d2 = dot(ab, ab);
  float k = d2 > 0.0 ? clamp(dot(d - s0, ab) / d2, 0.0, 1.0) : 0.0;
  return length(d - (s0 + ab * k)) / uPixelAngle;
}

// The light a star size pixels across gives a pixel dist pixels from it,
// once smeared along a streak streakPx long
vec3 starDot(vec3 color, float size, float dist, float streakPx, float phase) {
  // A star smaller than a pixel would flicker in and out as the view moves,
  // so it is drawn a pixel and a half across, dimmed by the extra area
  float radius = max(0.5 * size, 0.75);
  float a = 1.0 - smoothstep(0.35, 1.0, dist / radius);
  float twinkle = 0.78 + 0.22 * sin(uTime * 1.7 + phase * TAU);
  float spread = size / (size + uStreakDim * streakPx);
  float area = min(1.0, 0.25 * size * size / (radius * radius));
  return color * twinkle * spread * area * a;
}

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

// The distant star, if any, in the cell under direction s. The sphere of
// directions is cut into the six faces of a cube and each face into a grid.
vec3 distantStar(vec3 s) {
  vec2 uv;
  int face = cubeFace(s, uv);
  vec2 cell = floor((uv * 0.5 + 0.5) * STAR_GRID);
  vec3 r1 = random3(uvec3(uvec2(cell), uint(face) + 7u));
  if (r1.x > 0.328) return vec3(0.0);
  vec2 mid = (cell + 0.5) / STAR_GRID * 2.0 - 1.0;
  // Cells near a face's corners cover less of the sky, so they hold a star
  // less often, keeping the density even; the band packs more in near the
  // sky's equator. About 2000 stars.
  vec3 centerDir = normalize(cubeDir(face, mid));
  float m2 = 1.0 + dot(mid, mid);
  float area = inversesqrt(m2 * m2 * m2);
  float band = 1.0 + 2.28 * exp(-centerDir.y * centerDir.y / (2.0 * 0.175 * 0.175));
  if (r1.x > 0.1 * area * band) return vec3(0.0);

  vec3 star = normalize(cubeDir(face, (cell + 0.15 + 0.7 * r1.yz) / STAR_GRID * 2.0 - 1.0));
  vec3 diff = s - star;
  float maxAng = max(1.4 * uStarScale, 0.75) * uPixelAngle;
  float dist2 = dot(diff, diff);
  if (dist2 >= maxAng * maxAng) return vec3(0.0);

  vec3 r2 = random3(uvec3(uvec2(cell), uint(face) + 101u));
  float mag = r2.x * r2.x * r2.x;
  vec3 color = (0.35 + 0.5 * mag) * starColor(r2.y);
  float size = (1.0 + 1.8 * mag) * uStarScale;
  return starDot(color, size, sqrt(dist2) / uPixelAngle, 0.0, r2.z);
}

// The near star in cell c, if it has one, seen along ray o + t d; v is how
// far the stars move past the eye over the shutter
vec3 nearStar(ivec3 c, vec3 o, vec3 d, vec3 v, float maxChance, float maxRadiusPx,
              float maxRadiusAngle2, float cosMaxStreak, float cosLimit, float reachDist) {
  uvec3 key = uvec3(c + CELL_BIAS);
  vec3 r1 = random3(key);
  if (r1.x >= maxChance) return vec3(0.0);

  vec3 r2 = random3(key + uvec3(0, 0, 7919));
  // Kept off the cell's walls, so a star's glow never spills into a cell the
  // walk doesn't look in
  vec3 pos = (vec3(c) + 0.15 + 0.7 * vec3(r1.yz, r2.x)) * STAR_CELL;
  if (dot(pos, pos) < STAR_CLEAR * STAR_CLEAR) return vec3(0.0);
  vec3 q = pos - o;
  float dist2 = dot(q, q);
  if (dist2 > reachDist * reachDist || dist2 < 0.25) return vec3(0.0);
  float qDotD = dot(q, d);
  if (qDotD <= 0.0) return vec3(0.0);

  float invDist = inversesqrt(dist2);
  vec3 s0 = q * invDist, s1 = s0;
  float px = 0.0, streakPx = 0.0;
  if (v == vec3(0.0)) {
    float d2 = max(2.0 - 2.0 * qDotD * invDist, 0.0);
    if (d2 >= maxRadiusAngle2) return vec3(0.0);
    px = sqrt(d2) / uPixelAngle;
  } else {
    // Where it was a shutter ago, its streak no longer than uMaxStreak
    s1 = normalize(q - v);
    float cosAng = dot(s0, s1);
    if (cosAng < cosMaxStreak) {
      if (dot(d, s0) <= cosLimit) return vec3(0.0);
      float angle = acos(clamp(cosAng, -1.0, 1.0));
      s1 = normalize(mix(s0, s1, uMaxStreak / angle));
      streakPx = uMaxStreak / uPixelAngle;
      px = pixelsFrom(d, s0, s1);
      if (px >= maxRadiusPx) return vec3(0.0);
    } else {
      vec3 ab = s1 - s0;
      float ab2 = dot(ab, ab);
      float k = ab2 > 0.0 ? clamp(dot(d - s0, ab) / ab2, 0.0, 1.0) : 0.0;
      vec3 diff = d - (s0 + ab * k);
      float diff2 = dot(diff, diff);
      if (diff2 >= maxRadiusAngle2) return vec3(0.0);
      px = sqrt(diff2) / uPixelAngle;
      streakPx = acos(clamp(cosAng, -1.0, 1.0)) / uPixelAngle;
    }
  }

  float midY = (float(c.y) + 0.5) * STAR_CELL;
  float base = STAR_DENSITY * (1.0 + 2.0 * exp(-midY * midY / (STAR_DISC * STAR_DISC)));
  float chance = mix(base, min(base * WARP_STAR_DENSITY, WARP_STAR_CAP), uWarpStars);
  if (r1.x >= chance) return vec3(0.0);
  // A star only the warp brings fades in with it
  float fade = r1.x < base ? 1.0 : uWarpStars;

  float dist = dist2 * invDist;
  float mag = r2.y * r2.y * r2.y;
  // Brighter and a little larger as the ship closes on it, fading toward the
  // far edge of the field, where the distant layer carries on
  float near = STAR_REF / dist;
  float level = (0.45 + 0.55 * mag) * min(near * near, 4.0) * smoothstep(reachDist, 0.6 * reachDist, dist);
  float size = (1.0 + 2.2 * mag) * clamp(sqrt(near), 0.7, 2.0) * uStarScale;

  // The chance test above leaves r1.x uniform in [0, chance): the twinkle's phase
  return starDot(fade * level * starColor(r2.z), size, px, streakPx, r1.x / chance);
}

// The near stars along ray o + t d: an Amanatides-Woo walk through the cells
// it crosses, out to STAR_REACH. A streaking star leaves its own cell during
// the shutter, moving back along -v, so each cell the ray crosses also asks
// the neighbors toward +v -- along each axis v moves far enough to carry a
// star over a wall -- whether their star passed through it. The brightest
// wins, so a star found twice isn't counted twice.
vec3 nearStars(vec3 o, vec3 d, vec3 v) {
  // A cell wholly inside the clear sphere holds no star, so from inside it
  // the walk starts where the ray leaves the part of it no cell (or a
  // neighbor) reaching past it could cover
  float inner = max(STAR_CLEAR - 2.0 * 1.7321 * STAR_CELL, 0.0);
  float b = dot(o, d), c = dot(o, o) - inner * inner;
  float t = c < 0.0 ? -b + sqrt(b * b - c) : 0.0;

  vec3 p = o + d * t;
  ivec3 cell = ivec3(floor(p / STAR_CELL));
  ivec3 stepDir = ivec3(greaterThanEqual(d, vec3(0.0))) * 2 - 1;
  vec3 invAbs = 1.0 / max(abs(d), vec3(1e-8));
  vec3 tDelta = STAR_CELL * invAbs;
  vec3 wall = (vec3(cell) + step(0.0, d)) * STAR_CELL;
  vec3 tMax = t + abs(wall - p) * invAbs;
  ivec3 reach = ivec3(greaterThan(abs(v), vec3(0.075 * STAR_CELL))) * ivec3(sign(v));
  ivec3 absReach = abs(reach);
  bool hasReach = any(notEqual(reach, ivec3(0)));
  ivec3 needVal = ivec3(equal(stepDir, reach));
  ivec3 skipMask = ivec3(0);

  float maxChance = mix(STAR_DENSITY * 3.0, min(STAR_DENSITY * 3.0 * WARP_STAR_DENSITY, WARP_STAR_CAP), uWarpStars);
  float maxRadiusPx = max(3.2 * uStarScale, 0.75);
  float maxRadiusAngle = maxRadiusPx * uPixelAngle;
  float maxRadiusAngle2 = maxRadiusAngle * maxRadiusAngle;
  float cosMaxStreak = cos(uMaxStreak);
  float cosLimit = cos(min(uMaxStreak + maxRadiusAngle * 1.05, PI));

  float reachDist = mix(STAR_REACH, 112.0, uWarpStars);
  vec3 light = vec3(0.0);
  for (int i = 0; i < STAR_STEPS; i++) {
    if (t > reachDist) break;
    if (!hasReach) {
      light = max(light, nearStar(cell, o, d, v, maxChance, maxRadiusPx, maxRadiusAngle2, cosMaxStreak, cosLimit, reachDist));
    } else {
      for (int k = 0; k < 8; k++) {
        ivec3 off = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
        if (any(greaterThan(off, absReach)) || any(notEqual((off - needVal) * skipMask, ivec3(0)))) continue;
        light = max(light, nearStar(cell + off * reach, o, d, v, maxChance, maxRadiusPx, maxRadiusAngle2, cosMaxStreak, cosLimit, reachDist));
      }
    }
    if (tMax.x < tMax.y && tMax.x < tMax.z) {
      cell.x += stepDir.x; t = tMax.x; tMax.x += tDelta.x; skipMask = ivec3(absReach.x, 0, 0);
    } else if (tMax.y < tMax.z) {
      cell.y += stepDir.y; t = tMax.y; tMax.y += tDelta.y; skipMask = ivec3(0, absReach.y, 0);
    } else {
      cell.z += stepDir.z; t = tMax.z; tMax.z += tDelta.z; skipMask = ivec3(0, 0, absReach.z);
    }
  }
  return light;
}

// Periodic shooting stars on the celestial sphere (visible both directly in the
// background and reflected on the mirror planet / glass prism)
vec3 shootingStars(vec3 s, bool primary) {
  const vec4 periods = vec4(4.4, 5.9, 7.3, 8.9);
  const vec4 offsets = vec4(3.4, 1.8, 5.1, 0.9);
  // Reflected rays on the convex mirror planet span ~15x more sky angle per
  // pixel than primary rays, so widen their anti-aliased core/halo when !primary.
  float coreW = primary ? max(0.0022, 1.5 * uPixelAngle) : 0.0095;
  float haloW = primary ? 0.009 : 0.025;
  vec3 total = vec3(0.0);

  for (int k = 0; k < 4; k++) {
    float period = periods[k];
    float phase = uTime + offsets[k];
    float cycle = floor(phase / period);
    float age = phase - cycle * period;

    vec3 r1 = random3(uvec3(uint(cycle) + 17u, uint(k) * 97u + 13u, 53u));
    float dur = 1.05 + 0.35 * r1.x;
    if (age > dur) continue;

    vec3 r2 = random3(uvec3(uint(cycle) + 41u, uint(k) * 131u + 29u, 89u));
    float z0 = r1.y * 2.0 - 1.0;
    float phi0 = r1.z * TAU;
    float rr = sqrt(max(1.0 - z0 * z0, 0.0));
    vec3 p0 = vec3(rr * cos(phi0), z0, rr * sin(phi0));

    vec3 up = abs(p0.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 bx = normalize(cross(up, p0));
    vec3 by = cross(p0, bx);
    float ang = r2.x * TAU;
    vec3 tDir = bx * cos(ang) + by * sin(ang);

    float u = age / dur;
    float arc = 0.55 + 0.35 * r2.y;
    float tailLen = 0.20 + 0.14 * r2.z;
    float headA = u * arc;
    float tailA = max(0.0, headA - tailLen * smoothstep(0.0, 0.18, u));

    float theta = atan(dot(s, tDir), dot(s, p0));
    float clamped = clamp(theta, tailA, headA);
    vec3 closest = p0 * cos(clamped) + tDir * sin(clamped);
    if (dot(s, closest) < 0.985) continue;

    float dist = length(s - closest);
    float f = (clamped - tailA) / max(headA - tailA, 1e-4);
    float taper = mix(0.32, 1.0, f);
    float wCore = coreW * taper;
    float wHalo = haloW * taper;

    float env = smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.65, 1.0, u));
    float along = f * f;
    float core = exp(-(dist * dist) / (wCore * wCore));
    float halo = 0.38 * exp(-(dist * dist) / (wHalo * wHalo));

    vec3 headPos = p0 * cos(headA) + tDir * sin(headA);
    float dHead = length(s - headPos);
    float headGlow = 1.4 * exp(-(dHead * dHead) / (coreW * coreW * 2.8));

    vec3 tailTint = mix(vec3(0.55, 0.82, 1.25), vec3(1.20, 0.86, 0.48), r2.z);
    vec3 col = mix(tailTint, vec3(1.0, 0.98, 0.95), along);
    total += col * env * ((core + halo) * along * 2.4 + headGlow);
  }
  return total;
}

// Everything a ray that leaves the scene sees. Only rays straight from the eye
// look for near stars: a reflected or refracted one would cost the whole walk
// again for a star the curved surface has smeared out of shape anyway.
vec3 sky(vec3 o, vec3 d, bool primary) {
  vec3 s = d * uSkyRot;                                  // into the sky's own frame
  vec3 color = backdrop(s) + distantStar(s) + shootingStars(s, primary);
  if (primary)
    color += nearStars((o - uSkyCenter) * uSkyRot, s, (uStreak * uShutter) * uSkyRot);
  return color;
}

// ============================================================================
// Shading
// ============================================================================

// Phong from every light, each through a shadow ray. The surface's own share
// -- what isn't mirror or glass -- takes the ambient and diffuse terms; the
// highlight is added in full, so glass still glints.
`;

const DEFAULT_SHADE_LOCAL_GLSL = `// Direct lighting at hit s (ray dir d, primitive i).
// uMatA[i]: ka, kd, ks, shininess | uMatB[i]: kr, kt, ior, bump
vec3 shadeLocal(Surface s, vec3 d, int i) {
  vec4 A = uMatA[i], B = uMatB[i];
  // Fraction of surface not claimed by mirror (B.x) or glass (B.y)
  float body = max(1.0 - B.x - B.y, 0.0);
  vec3 V = -d;
  // Flip shading & geometric normals to face the incoming ray
  vec3 n  = faceforward(s.n, d, s.ng);
  vec3 ng = faceforward(s.ng, d, s.ng);

  // 1. Ambient term
  vec3 color = A.x * body * s.base;

  // 2. Direct Phong lighting + shadow rays across all scene lights
  if (A.y * body > 0.0 || A.z * uSpecularScale > 0.0) {
    for (int j = 0; j < NUM_LIGHTS; j++) {
      if (uLightColor[j] == vec3(0.0)) continue;
      vec3 toLight = uLightPos[j] - s.p;
      float dist = length(toLight);
      vec3 L = toLight / dist;
      float diff = dot(n, L);
      if (diff <= 0.0 || dot(ng, L) <= 0.0) continue;

      // Shadow ray: transmittance() attenuates through glass & blocks opaque hits
      vec3 vis = uShadows ? transmittance(s.p + ng * EPS, L, dist) : vec3(1.0);
      if (vis == vec3(0.0)) continue;

      // Inverse-square attenuation normalized to 1 at light ref distance,
      // clamped beyond reach so the ship stays lit during warp
      float ref2 = uLightRange[j].x * uLightRange[j].x;
      float dAtt = min(dist, uLightRange[j].y);
      float att  = uAttenuation ? 2.0 * ref2 / (ref2 + dAtt * dAtt) : 1.0;

      // Specular highlight is added in full so glass still glints
      float rdotv = max(dot(V, reflect(-L, n)), 0.0);
      float spec  = rdotv > 0.0 ? pow(rdotv, A.w) : 0.0;
      color += uLightColor[j] * vis * att * (A.y * body * s.base * diff + A.z * uSpecularScale * spec);
    }
  }

  // 3. Self-lit windows/lights stay bright on the night side
  color += uMatE[i].x * s.emit * s.base;

  // 4. Atmospheric limb glow on the sunlit side of the planet
  vec3 glow = uMatC[i].rgb;
  if (glow != vec3(0.0)) {
    float rim = pow(1.0 - max(dot(ng, V), 0.0), 3.0);
    float day = smoothstep(-0.25, 0.5, dot(ng, normalize(uLightPos[0] - s.p)));
    color += glow * rim * day;
  }
  return color;
}`;

const RAYTRACE_FS_MIDDLE = `
// The ray through this pixel. The warp lens (camera.js) is HW6's projection
// run backwards: a rectilinear direction, and an equisolid fisheye one with
// its vertical stretch undone, blended as the lens opens. Outside the
// fisheye's image circle there is nothing to see.
bool primaryRay(out vec3 d) {
  vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
  d = normalize(vec3(ndc.x / uProj00, ndc.y / uProj11, -1.0));
  if (uFisheye <= 0.0) return true;
  float aspect = uProj11 / uProj00;
  vec2 q = vec2(ndc.x * min(aspect, 1.0), (uFishPivot + (ndc.y - uFishPivot) / uFishStretch) / max(aspect, 1.0));
  float k = length(q) * sin(0.5 * uFishHalfX);
  if (k >= 1.0) {
    if (uFisheye >= 1.0) return false;
    k = 1.0;
  }
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
`;

const DEFAULT_STEP_BOUNCE_GLSL = `// Advance ray path p after hitting surface s (primitive id).
// Returns true to keep tracing p; sets pushed/hasPushed for glass splits.
// uMatB[id]: kr (mirror), kt (glass), ior | uMatD[id].rgb: Beer-Lambert absorb
bool stepBounce(inout Path p, Surface s, int id, out Path pushed, out bool hasPushed) {
  pushed = p;
  hasPushed = false;
  vec4 B = uMatB[id];

  // 1. Stop at bounce limit or on purely diffuse surfaces
  if (p.depth >= uBounces || (B.x <= 0.0 && B.y <= 0.0)) return false;
  p.depth++;

  if (B.y > 0.0) {
    // 2. Transmissive glass: orient normals toward incoming ray
    bool entering = dot(p.d, s.ng) < 0.0;
    vec3 n  = entering ? s.n : -s.n;
    vec3 ng = entering ? s.ng : -s.ng;
    float eta = entering ? 1.0 / B.z : B.z;   // n1 / n2 for Snell's law
    vec3 rdir = reflect(p.d, n);
    vec3 tdir = refract(p.d, n, eta);
    vec3 outside = s.p + ng * EPS, inside = s.p - ng * EPS;

    if (tdir == vec3(0.0)) {
      // Total internal reflection: stay inside without spending a bounce
      p.depth--;
      p.o = outside; p.d = rdir; p.weight *= B.y;
    } else {
      // Schlick Fresnel approximation using the vacuum-side cosine
      float c  = clamp(entering ? -dot(p.d, n) : -dot(tdir, n), 0.0, 1.0);
      float r0 = (B.z - 1.0) / (B.z + 1.0);
      r0 *= r0;
      float omc = 1.0 - c;
      float F = r0 + (1.0 - r0) * omc * omc * omc * omc * omc;

      // Split into reflected (same medium) and refracted (enters/exits glass)
      Path reflected = Path(outside, rdir, p.weight * B.y * F, p.absorb, p.travelled, p.depth);
      Path refracted = Path(inside, tdir, p.weight * B.y * (1.0 - F),
                            entering ? uMatD[id].rgb : vec3(0.0), p.travelled, p.depth);

      // Follow the stronger branch now; queue the weaker branch on the stack
      Path weaker;
      if (F <= 0.5) { p = refracted; weaker = reflected; }
      else          { p = reflected; weaker = refracted; }
      if (maxComponent(weaker.weight) > 0.01) { pushed = weaker; hasPushed = true; }
    }
  } else {
    // 3. Mirror reflection (polished hull, mirror planet)
    p.o = s.p + faceforward(s.ng, p.d, s.ng) * EPS;
    p.d = reflect(p.d, faceforward(s.n, p.d, s.ng));
    p.weight *= B.x;
  }

  // 4. Prune rays whose remaining contribution is negligible
  return maxComponent(p.weight) >= 0.01;
}`;

const RAYTRACE_FS_SUFFIX = `
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
  vec3 initAbsorb = vec3(0.0);
  int ungrouped = uGroupCount > 0 ? uGroupRange[0].x : uCount;
  for (int i = 0; i < ungrouped; i++) {
    if (uMatB[i].y <= 0.0) continue;
    vec3 po = toObject(i, vec3(0.0), 1.0);
    bool inside = isWavyHex(i) ? wavyHexEval(po) < 0.0
      : (uInfo[i].x == HEX_PRISM ? hexPrismEval(po) < 0.0
      : (uInfo[i].x == BOX ? max(abs(po.x), max(abs(po.y), abs(po.z))) < 1.0 : dot(po, po) < 1.0));
    if (inside) { initAbsorb = uMatD[i].rgb; break; }
  }
  Path p = Path(vec3(0.0), d0, vec3(1.0), initAbsorb, 0.0, 0);
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
      color += p.weight * sky(p.o, p.d, segment == 0);
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

    Path pushed;
    bool hasPushed;
    live = stepBounce(p, s, h.id, pushed, hasPushed);
    if (hasPushed && top < STACK_SIZE) stack[top++] = pushed;
  }
  fragColor = vec4(color, 1.0);
}
`;

function buildRaytraceFS(shadeLocalGlsl = DEFAULT_SHADE_LOCAL_GLSL, stepBounceGlsl = DEFAULT_STEP_BOUNCE_GLSL) {
  return `${RAYTRACE_FS_PREFIX}${shadeLocalGlsl}\n${RAYTRACE_FS_MIDDLE}${stepBounceGlsl}\n${RAYTRACE_FS_SUFFIX}`;
}
const RAYTRACE_FS = buildRaytraceFS();
