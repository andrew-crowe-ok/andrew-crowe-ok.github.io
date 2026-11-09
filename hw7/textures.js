// Procedural ship skin, generated on the GPU at load time: each texture is a
// fragment shader drawn once into a framebuffer, with no image files.
//
// A skin is two textures over the same texels:
//   color   rgb = albedo, a = emission (lit windows, navigation lights). The
//           ship shader adds the emission back in (its glow term), so windows
//           shine on the night side and fade with distance as the mipmaps
//           average them.
//   normal  tangent-space normal in [0, 1]: T along u, B along v, N out
// It is drawn in two passes. The first evaluates the pattern once per texel
// and writes the color plus the surface height, packed into 16 bits; the
// second takes central differences of that height into the normal map.
//
// Patterns are laid out in ship units, not texels: a plate is about 0.2 units
// wide and a seam 0.007 whatever the texture's size, and every edge is
// filtered against the texel's footprint. A skin can be generated at any
// resolution -- the size only decides how sharp it is -- and the normals are
// true slopes (height over distance in ship units), so relief doesn't change
// with it either. Everything wraps around u, so there is no seam.
//
// Uses createProgram from main.js.

// ---------------------------------------------------------------------------
// GLSL shared by every pattern: hashing, noise, filtered shapes, and the
// plated skin that the saucer, rim and hull patterns all build on
// ---------------------------------------------------------------------------
const SKIN_COMMON = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uSize;     // target size, texels
uniform float uSeed;    // a different seed lays out a different skin

const float PI = 3.14159265, TAU = 6.28318531;
const float HMAX = 0.02;              // heights pack from [-HMAX, HMAX] ship units
const vec2 NOWRAP = vec2(65536.0);    // a noise period too long to repeat

struct Surface { vec3 albedo; float emit; float height; };

// --- Hashing and noise ------------------------------------------------------

// 3D integer hash (Jarzynski & Olano, "Hash Functions for GPU Rendering", 2020)
uvec3 pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

// A lattice cell and a stream number -> [0, 1). Streams give unrelated values
// for the same cell, so one cell can make several independent choices.
float hash(vec2 cell, float stream) {
  ivec3 c = ivec3(floor(cell), floor(stream + 977.0 * uSeed));
  return float(pcg3(uvec3(c)).x) * (1.0 / 4294967296.0);
}

vec2 gradient(vec2 cell, float stream) {
  float a = TAU * hash(cell, stream);
  return vec2(cos(a), sin(a));
}

// Gradient noise, about [-0.7, 0.7], on a lattice that wraps every period cells
float gnoise(vec2 p, vec2 period, float stream) {
  vec2 i = floor(p), f = p - i;
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic fade
  vec2 a = mod(i, period), b = mod(i + 1.0, period);
  float n00 = dot(gradient(a, stream), f);
  float n10 = dot(gradient(vec2(b.x, a.y), stream), f - vec2(1.0, 0.0));
  float n01 = dot(gradient(vec2(a.x, b.y), stream), f - vec2(0.0, 1.0));
  float n11 = dot(gradient(b, stream), f - 1.0);
  return mix(mix(n00, n10, w.x), mix(n01, n11, w.x), w.y);
}

// Fractal sum: each octave halves the cell and doubles the period, so it wraps too
float fbm(vec2 p, vec2 period, int octaves, float stream) {
  float sum = 0.0, amp = 0.5;
  for (int o = 0; o < 6; o++) {
    if (o >= octaves) break;
    sum += amp * gnoise(p, period, stream + 17.0 * float(o));
    p *= 2.0; period *= 2.0; amp *= 0.5;
  }
  return sum;
}

// --- Filtered shapes ----------------------------------------------------------
// fw is the texel's footprint, in the same units as the shape. Edges blend over
// one texel, and a shape thinner than a texel is widened to one and dimmed to
// match, so fine lines fade out with resolution instead of breaking up.

// Coverage of the band |d| < hw
float band(float d, float hw, float fw) {
  fw = max(fw, 1e-6);
  float w = max(hw, 0.5 * fw);
  return clamp((w - abs(d)) / fw + 0.5, 0.0, 1.0) * (hw / w);
}

// Signed distance to a box of half-size hw with corners rounded to rad
float sdRoundBox(vec2 d, vec2 hw, float rad) {
  vec2 q = abs(d) - hw + rad;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
float fill(float sd, float fw) { return clamp(0.5 - sd / max(fw, 1e-6), 0.0, 1.0); }
float rect(vec2 d, vec2 hw, vec2 fw) { return band(d.x, hw.x, fw.x) * band(d.y, hw.y, fw.y); }
float roundRect(vec2 d, vec2 hw, float rad, float fw) { return fill(sdRoundBox(d, hw, rad), fw); }
float disc(vec2 d, float r, float fw) { return fill(length(d) - r, fw); }

// --- Plated skin ------------------------------------------------------------

const float SEAM = 0.0035;      // half-width of the groove between plates
const float SUBSEAM = 0.0017;   // and of the finer lines between panels

// Patchwork paint, the pattern of interlocking lighter and darker panels on
// the reference ship's hull. Tone blocks at three scales -- whole plates,
// quarters, sixteenths -- aligned to the plate grid, are summed and cut into
// three tones: the finer blocks bite steps and notches out of the coarser
// ones, so the patches come out as stair-stepped, interlocking shapes rather
// than noise. Returns -1, 0 or +1.
float patchwork(vec2 grid, float stream) {
  float t = 0.6 * (hash(grid, stream) - 0.5)
          + 0.35 * (hash(grid * 2.0, stream + 1.0) - 0.5)
          + 0.2 * (hash(grid * 4.0, stream + 2.0) - 0.5);
  return step(0.12, t) - step(t, -0.12);
}

// The skin around one plate.
//   grid      continuous plate coordinates, whole numbers on the seams
//   local     position from the plate's center, ship units
//   size      the plate's size, ship units
//   fw        the texel's footprint, ship units
//   id        the plate's cell, for its random choices
//   features  how often plates carry a hatch or a vent (1 = the usual)
//   pods      whether plates may carry escape pod hatches
Surface plating(vec2 grid, vec2 local, vec2 size, vec2 fw, vec2 id, vec3 paint,
                float contrast, float features, bool pods, float stream) {
  Surface s = Surface(paint, 0.0, 0.0);
  float fwm = max(fw.x, fw.y);

  // Plates crown slightly away from their edges and meet in a groove
  vec2 edge = 0.5 * size - abs(local);
  float seam = max(band(edge.x, SEAM, fw.x), band(edge.y, SEAM, fw.y));
  s.height += 0.0006 * smoothstep(0.0, 0.025, min(edge.x, edge.y));

  // Most plates are split into two, three or four panels by finer lines
  float split = hash(id, stream + 3.0);
  vec2 div = split < 0.3 ? vec2(1.0) : split < 0.55 ? vec2(2.0, 1.0)
           : split < 0.75 ? vec2(1.0, 2.0) : split < 0.9 ? vec2(2.0) : vec2(3.0, 1.0);
  vec2 q = (local / size + 0.5) * div;
  vec2 qe = (0.5 - abs(fract(q) - 0.5)) * size / div;   // to the nearest panel line
  float sub = max(div.x > 1.0 ? band(qe.x, SUBSEAM, fw.x) : 0.0,
                  div.y > 1.0 ? band(qe.y, SUBSEAM, fw.y) : 0.0);

  // Patchwork tones, a faint shade of its own for every plate, and a hint of
  // blue in the light patches and green in the dark
  float tone = patchwork(grid, stream + 10.0);
  vec3 col = paint * (1.0 + contrast * tone) * (1.0 + 0.04 * (hash(id, stream + 4.0) - 0.5));
  col += contrast * (tone > 0.0 ? vec3(-0.05, 0.0, 0.12) : tone < 0.0 ? vec3(-0.05, 0.1, 0.0) : vec3(0.0));

  // The odd fixture, centered in its plate
  float pick = hash(id, stream + 5.0) / max(features, 1e-3);
  vec2 jitter = vec2(hash(id, stream + 6.0), hash(id, stream + 7.0));
  if (pick < 0.07) {
    // Hatch: a recessed panel inside a raised lip
    vec2 hw = min(size * mix(vec2(0.24, 0.22), vec2(0.34, 0.32), jitter), vec2(0.07, 0.05));
    float outer = roundRect(local, hw + 0.004, 0.006, fwm);
    float inner = roundRect(local, hw, 0.004, fwm);
    s.height += 0.0007 * (outer - inner) - 0.0016 * inner;
    col *= 1.0 + 0.05 * (outer - inner) - 0.1 * inner;
  } else if (pick < 0.11) {
    // Vent: a dark recess crossed by slats
    vec2 hw = min(size * vec2(0.3, 0.18), vec2(0.05, 0.022));
    float box = rect(local, hw, fw);
    float pitch = 0.008, t = local.x / pitch;
    float slat = band(t - round(t), 0.22, fw.x / pitch);
    s.height += box * (-0.002 + 0.0014 * slat);
    col = mix(col, col * mix(0.32, 0.7, slat), box);
  } else if (pods && hash(id, stream + 8.0) < 0.14) {
    // Escape pods: a pair of small square hatches, outlined dark
    for (int i = 0; i < 2; i++) {
      vec2 d = local - vec2((float(i) - 0.5) * 0.06, 0.0);
      float sd = sdRoundBox(d, vec2(0.018), 0.004);
      float outline = band(sd, 0.0016, fwm);
      col = mix(col * (1.0 + 0.05 * fill(sd, fwm)), col * 0.45, outline);
      s.height -= 0.0012 * outline;
    }
  }

  // Grime settles in the grooves
  s.albedo = col * (1.0 - 0.3 * seam - 0.12 * sub);
  s.height -= 0.003 * seam + 0.0012 * sub;
  return s;
}

// One viewport, d from its center, size its pane. Windows come in rooms of
// four, lit or dark together with a little variation pane to pane; a few rooms
// are lit a cool white, and one in fifteen is a gap where a frame member runs.
void windowPane(inout Surface s, vec2 d, vec2 id, vec2 fw, vec2 size) {
  float room = hash(vec2(floor(id.x / 4.0), id.y), 21.0);
  if (room > 0.93) return;
  float fwm = max(fw.x, fw.y);
  float frame = roundRect(d, 0.5 * size + 0.0025, 0.002, fwm);
  float pane = roundRect(d, 0.5 * size, 0.0012, fwm);
  float lit = room < 0.68 ? 0.7 + 0.3 * hash(id, 22.0) : 0.0;
  vec3 light = room < 0.12 ? vec3(0.92, 0.96, 1.0) : vec3(1.0, 0.87, 0.64);
  vec3 glass = lit > 0.0 ? light * lit : vec3(0.05, 0.06, 0.08);
  s.albedo = mix(s.albedo, s.albedo * 0.72, frame - pane);
  s.albedo = mix(s.albedo, glass, pane);
  s.height += 0.0005 * (frame - pane) - 0.0012 * pane;
  s.emit = max(s.emit, pane * lit);
}

// Reaction-control thrusters: a raised housing with four dark nozzles
void rcsQuad(inout Surface s, vec2 d, vec2 fw) {
  float fwm = max(fw.x, fw.y);
  float housing = roundRect(d, vec2(0.026), 0.006, fwm);
  float nozzle = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 c = vec2(float(i & 1), float(i >> 1)) * 0.026 - 0.013;
    nozzle = max(nozzle, disc(d - c, 0.0065, fwm));
  }
  s.albedo = mix(mix(s.albedo, s.albedo * 0.8, housing), vec3(0.06, 0.06, 0.07), nozzle);
  s.height += 0.0012 * housing - 0.0015 * nozzle;
}

// Fine orange-peel ripple in the paint, to break up highlights; f is its
// frequency (cycles per ship unit) and it fades out where it would be finer
// than the texels can carry
float peel(vec2 p, vec2 period, float f, float fwm) {
  return gnoise(p, period, 50.0) * clamp(2.0 - 4.0 * f * fwm, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// The patterns. Each defines texelPhys(uv), the size of one texel in ship
// units along u and v (the normal pass divides height differences by it), and
// surface(uv). Comments give each one's mapping.
// ---------------------------------------------------------------------------
const SKIN_KINDS = {
  // A sphere squashed into a lens: the saucer's layers, the keyhole's head and
  // the domes. u runs around (0 = starboard, 0.25 = aft); v goes from the
  // bottom pole (0) to the top (1). The layout follows rho, the distance out
  // from the axis as a fraction of the radius, so plates come in evenly spaced
  // rings, and each ring gets as many plates as its circumference holds: the
  // plates stay the same size from the hub out to the rim.
  saucer: { normal: true, glsl: `
uniform float uRadius;     // mean radius, ship units
uniform float uThick;      // vertical half-thickness
uniform vec2 uPlate;       // plate size: around, radial
uniform vec3 uPaint;
uniform float uContrast;   // patchwork contrast
uniform float uFeatures;   // hatch and vent rate
uniform bool uPods;        // escape pods on the outer rings
uniform vec4 uRows[4];     // window rows: (rho, face: +1 top, -1 bottom)
uniform int uRowCount;
uniform vec3 uWindow;      // pane width, pane height, spacing
uniform vec2 uRcs;         // thruster quads: rho (0 = none), how many around

// Along v this is distance over the surface, which near the rim is mostly
// down its thin edge
vec2 texelPhys(vec2 uv) {
  float th = PI * (1.0 - uv.y);
  return max(vec2(TAU * uRadius * sin(th) / uSize.x,
                  PI * length(vec2(uRadius * cos(th), uThick * sin(th))) / uSize.y), 1e-5);
}

Surface surface(vec2 uv) {
  float th = PI * (1.0 - uv.y), rho = sin(th), r = uRadius * rho;
  bool top = uv.y > 0.5;
  float stream = top ? 0.0 : 100.0;
  // The texel's footprint around the circle, and radially: the layout is in
  // rho, so this is how far rho moves, not distance over the surface
  vec2 fw = max(vec2(TAU * r / uSize.x, PI * uRadius * abs(cos(th)) / uSize.y), 1e-6);

  // Rings of plates, staggered half a plate ring to ring; plate counts are a
  // multiple of four, so the layout keeps the ship's symmetry
  float nRings = max(2.0, round(uRadius / uPlate.y));
  float ringT = rho * nRings, k = min(floor(ringT), nRings - 1.0);
  float n = 4.0 * max(1.0, round(TAU * uRadius * (k + 0.5) / nRings / uPlate.x / 4.0));
  float s = uv.x * n + 0.5 * mod(k, 2.0);
  vec2 grid = vec2(s, ringT);
  vec2 size = vec2(TAU * r / n, uRadius / nRings);
  Surface o = plating(grid, (fract(grid) - 0.5) * size, size, fw, vec2(mod(floor(s), n), k),
                      uPaint, uContrast, uFeatures, uPods && rho > 0.45, stream);

  // Weathering: broad grime, and streaks that run outward to the rim
  vec2 cart = r * vec2(cos(TAU * uv.x), sin(TAU * uv.x)) + stream;
  float nS = round(TAU * uRadius / 0.05);
  float grime = fbm(cart * 1.2, NOWRAP, 4, 30.0);
  float streak = fbm(vec2(uv.x * nS, r * 1.2), vec2(nS, NOWRAP.y), 3, 31.0 + stream);
  o.albedo *= (1.0 + 0.08 * grime) * (1.0 - 0.06 * max(streak, 0.0));
  o.height += 0.00015 * peel(cart * 70.0, NOWRAP, 70.0, max(fw.x, fw.y));

  // Window rows, spaced evenly around their circle
  for (int i = 0; i < 4; i++) {
    if (i >= uRowCount) break;
    vec4 row = uRows[i];
    float dy = (rho - row.x) * uRadius;
    if (row.y != (top ? 1.0 : -1.0) || abs(dy) > uWindow.y) continue;
    float nW = round(TAU * uRadius * row.x / uWindow.z);
    float cell = uv.x * nW;
    windowPane(o, vec2((fract(cell) - 0.5) * TAU * r / nW, dy), vec2(floor(cell), float(i)), fw, uWindow.xy);
  }

  // Thruster quads, centered between the axes
  if (uRcs.x > 0.0) {
    float cell = uv.x * uRcs.y;
    rcsQuad(o, vec2((fract(cell) - 0.5) * TAU * r / uRcs.y, (rho - uRcs.x) * uRadius), fw);
  }
  return o;
}
` },

  // The saucer's rim, a torus: u runs around the ring from the bow (0) to
  // starboard (0.25), v around the tube from its outer equator (0) over the
  // top (0.25). Plates in four bands around the tube; the outer band carries
  // two rows of windows, and the navigation lights sit on it at the beam,
  // green to starboard and red to port.
  rim: { normal: true, glsl: `
uniform float uRadius;     // ring radius, ship units
uniform float uTube;       // tube radius
uniform vec2 uPlate;
uniform vec3 uPaint;
uniform float uContrast;
uniform vec3 uWindow;      // pane width, pane height, spacing
uniform vec2 uRowY;        // the window rows, ship units above the outer equator

vec2 texelPhys(vec2 uv) { return vec2(TAU * uRadius / uSize.x, TAU * uTube / uSize.y); }

Surface surface(vec2 uv) {
  vec2 fw = texelPhys(uv);
  float C = TAU * uRadius, c = TAU * uTube;
  float y = (fract(uv.y + 0.5) - 0.5) * c;     // over the tube from the outer equator, + up
  float n = 4.0 * max(1.0, round(C / uPlate.x / 4.0));
  float rowT = y / (0.25 * c) + 0.5, k = floor(rowT);
  float s = uv.x * n + 0.5 * mod(k, 2.0);
  vec2 grid = vec2(s, rowT);
  vec2 size = vec2(C / n, 0.25 * c);
  // No hatches in the window band
  Surface o = plating(grid, (fract(grid) - 0.5) * size, size, fw, vec2(mod(floor(s), n), k),
                      uPaint, uContrast, k == 0.0 ? 0.0 : 1.0, false, 200.0);

  float nG = round(C * 1.2);
  o.albedo *= 1.0 + 0.08 * fbm(vec2(uv.x * nG, y * 1.2), vec2(nG, NOWRAP.y), 4, 30.0);
  o.height += 0.00015 * peel(vec2(uv.x * round(C * 70.0), y * 70.0), vec2(round(C * 70.0), NOWRAP.y),
                             70.0, max(fw.x, fw.y));

  float nW = round(C / uWindow.z), cell = uv.x * nW;
  for (int i = 0; i < 2; i++) {
    float dy = y - (i == 0 ? uRowY.x : uRowY.y);
    if (abs(dy) < uWindow.y)
      windowPane(o, vec2((fract(cell) - 0.5) * C / nW, dy), vec2(floor(cell), float(i) + 7.0), fw, uWindow.xy);
  }

  for (int i = 0; i < 2; i++) {
    vec2 d = vec2((fract(uv.x - (i == 0 ? 0.25 : 0.75) + 0.5) - 0.5) * C, y);
    float fwm = max(fw.x, fw.y);
    float housing = disc(d, 0.022, fwm), lamp = disc(d, 0.014, fwm);
    vec3 lampColor = i == 0 ? vec3(0.25, 1.0, 0.45) : vec3(1.0, 0.18, 0.12);
    o.albedo = mix(mix(o.albedo, vec3(0.2), housing - lamp), lampColor, lamp);
    o.emit = max(o.emit, lamp);
    o.height += 0.0008 * housing;
  }
  return o;
}
` },

  // A cylinder and the caps that share its texture (hull, neck, nacelles):
  // u runs around from the right side (0) over the top (0.25), v along the
  // length from the back (0) to the front (1). Plates in staggered rows, with
  // optional window rows running the length, a raised spine, and dark trim
  // bands down both sides.
  plating: { normal: true, glsl: `
uniform float uCirc, uLength;  // ship units spanned by u and by v
uniform vec2 uPlate;
uniform vec3 uPaint;
uniform float uContrast;
uniform float uFeatures;
uniform float uWinU[6];        // window rows: the u each runs along
uniform int uWinCount;
uniform vec3 uWindow;          // pane width (along v), pane height (around), spacing
uniform vec2 uWinV;            // the v range the rows span
uniform vec3 uSpine;           // raised strip along v: u, half-width, height (0 = none)
uniform vec2 uTrim;            // dark recessed bands at u and u + 0.5: u, half-width (0 = none)

vec2 texelPhys(vec2 uv) { return vec2(uCirc / uSize.x, uLength / uSize.y); }

// Ship units around the part from u0 to u, the short way
float around(float u, float u0) { return (fract(u - u0 + 0.5) - 0.5) * uCirc; }

Surface surface(vec2 uv) {
  vec2 fw = texelPhys(uv);
  float cols = 4.0 * max(1.0, round(uCirc / uPlate.x / 4.0));
  float rows = max(1.0, round(uLength / uPlate.y));
  float rowT = uv.y * rows, k = floor(rowT);
  float colT = uv.x * cols + 0.5 * mod(k, 2.0);
  vec2 grid = vec2(colT, rowT);
  vec2 size = vec2(uCirc / cols, uLength / rows);
  Surface o = plating(grid, (fract(grid) - 0.5) * size, size, fw, vec2(mod(floor(colT), cols), k),
                      uPaint, uContrast, uFeatures, true, 300.0);

  // Weathering: broad grime, and streaks that run aft along the length
  float nG = round(uCirc * 1.2), nS = round(uCirc / 0.04), nP = round(uCirc * 70.0);
  float grime = fbm(uv * vec2(nG, uLength * 1.2), vec2(nG, NOWRAP.y), 4, 40.0);
  float streak = fbm(uv * vec2(nS, uLength * 0.8), vec2(nS, NOWRAP.y), 3, 41.0);
  o.albedo *= (1.0 + 0.08 * grime) * (1.0 - 0.06 * max(streak, 0.0));
  o.height += 0.00015 * peel(uv * vec2(nP, uLength * 70.0), vec2(nP, NOWRAP.y), 70.0, max(fw.x, fw.y));

  // Spine: a darker raised strip in segments, edged by a groove; the plates'
  // seams stop at it
  if (uSpine.z > 0.0) {
    float d = around(uv.x, uSpine.x);
    float strip = band(d, uSpine.y, fw.x);
    float segT = uv.y * uLength / 0.12;
    float joint = band((segT - round(segT)) * 0.12, 0.0015, fw.y);
    float lip = band(abs(d) - uSpine.y, 0.0018, fw.x);
    o.albedo = mix(o.albedo, uPaint * 0.62 * (1.0 - 0.35 * joint), strip) * (1.0 - 0.3 * lip);
    o.height = mix(o.height, uSpine.z * (1.0 - 0.5 * joint), strip) - 0.002 * lip;
  }

  // Trim: dark recessed bands down both sides
  if (uTrim.y > 0.0) {
    float d = min(abs(around(uv.x, uTrim.x)), abs(around(uv.x, uTrim.x + 0.5)));
    float trim = band(d, uTrim.y, fw.x);
    o.albedo = mix(o.albedo, vec3(0.12, 0.13, 0.17), trim);
    o.height = mix(o.height, -0.002, trim);
  }

  // Window rows, evenly spaced along the length
  if (uWinCount > 0 && uv.y > uWinV.x && uv.y < uWinV.y) {
    float span = (uWinV.y - uWinV.x) * uLength;
    float nW = round(span / uWindow.z);
    float cell = (uv.y - uWinV.x) / (uWinV.y - uWinV.x) * nW;
    float dv = (fract(cell) - 0.5) * span / nW;
    for (int i = 0; i < 6; i++) {
      if (i >= uWinCount) break;
      float du = around(uv.x, uWinU[i]);
      if (abs(du) < uWindow.y) windowPane(o, vec2(dv, du), vec2(floor(cell), float(i)), fw.yx, uWindow.xy);
    }
  }
  return o;
}
` },

  // Deflector dish, unlit: a sphere turned pole-forward, so rho (0 at the pole,
  // v = 1, and 1 at its equator) is the distance out from the dish's center in
  // dish radii. A white-hot core fading to deep blue, a little shimmer, and a
  // grid of concentric rings and radial ribs, inside a dark rim.
  deflector: { normal: false, glsl: `
uniform vec3 uInner, uOuter;   // colors at the center and at the edge
uniform float uRings, uSpokes;

vec2 texelPhys(vec2 uv) { return vec2(1.0); }

Surface surface(vec2 uv) {
  float rho = uv.y > 0.5 ? sin(PI * uv.y) : 1.0;
  vec2 fw = max(vec2(TAU * rho / uSize.x, PI * abs(cos(PI * uv.y)) / uSize.y), 1e-6);
  vec3 col = mix(uOuter, uInner, pow(1.0 - rho, 1.4));
  col += vec3(0.5, 0.6, 0.6) * exp(-rho * rho * 80.0);
  vec2 cart = rho * vec2(cos(TAU * uv.x), sin(TAU * uv.x));
  col *= 0.88 + 0.3 * fbm(cart * 5.0, NOWRAP, 4, 1.0);
  float ringT = rho * uRings, spokeT = uv.x * uSpokes;
  float ring = band((ringT - round(ringT)) / uRings, 0.005, fw.y);
  float spoke = band((spokeT - round(spokeT)) / uSpokes * TAU * rho, 0.005, fw.x) * step(1.5 / uRings, rho);
  col *= 1.0 - 0.45 * max(ring, spoke);
  col *= 1.0 - 0.8 * smoothstep(0.9, 0.97, rho);
  return Surface(col, 1.0, 0.0);
}
` },

  // A glowing strip on a box face (warp grilles, impulse engines), unlit: u
  // runs along it, v across. Hottest down the middle, crossed by dark slats,
  // brightening and dimming along its length, inside a dark frame.
  strip: { normal: false, glsl: `
uniform vec3 uInner, uOuter, uFrame;
uniform float uSlats;      // how many dark slats cross it
uniform float uFlow;       // how much the glow varies along it

vec2 texelPhys(vec2 uv) { return vec2(1.0); }

Surface surface(vec2 uv) {
  float across = abs(uv.y - 0.5) * 2.0;
  vec3 col = mix(uOuter, uInner, pow(1.0 - across, 1.3));
  float t = uv.x * uSlats;
  float slat = band(t - round(t), 0.14, uSlats / uSize.x);
  float flow = fbm(vec2(uv.x * 8.0, uv.y * 2.0), vec2(8.0, NOWRAP.y), 4, 2.0);
  col *= (1.0 + uFlow * flow) * (1.0 - 0.4 * slat);
  col = mix(col, uFrame, smoothstep(0.84, 0.9, across));
  return Surface(col, 1.0, 0.0);
}
` },
};

// Pass 1: the pattern, once per texel. The height goes out in 16 bits, split
// across two 8-bit channels, since 8 bits would step the slopes visibly.
const SKIN_SURFACE_MAIN = `
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outHeight;

void main() {
  Surface s = surface(gl_FragCoord.xy / uSize);
  outColor = vec4(clamp(s.albedo, 0.0, 1.0), clamp(s.emit, 0.0, 1.0));
  float q = round(clamp(s.height / (2.0 * HMAX) + 0.5, 0.0, 1.0) * 65535.0);
  float hi = floor(q / 256.0);
  outHeight = vec4(hi / 255.0, (q - 256.0 * hi) / 255.0, 0.0, 1.0);
}
`;

// Pass 2: the normal from central differences of the height, as true slopes:
// height change over the ship units one texel spans. u always wraps; v wraps
// only on the rim, whose tube closes on itself, and clamps at a part's ends.
const SKIN_NORMAL_MAIN = `
uniform sampler2D uHeight;
uniform float uRelief;     // 1 = true slopes; more exaggerates the relief
uniform bool uWrapV;
layout(location = 0) out vec4 outNormal;

float heightAt(ivec2 p) {
  ivec2 n = ivec2(uSize);
  p.x = (p.x + n.x) % n.x;
  p.y = uWrapV ? (p.y + n.y) % n.y : clamp(p.y, 0, n.y - 1);
  vec2 hl = round(texelFetch(uHeight, p, 0).rg * 255.0);
  return ((hl.x * 256.0 + hl.y) / 65535.0 - 0.5) * 2.0 * HMAX;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 t = texelPhys(gl_FragCoord.xy / uSize);
  float dhdu = (heightAt(p + ivec2(1, 0)) - heightAt(p - ivec2(1, 0))) / (2.0 * t.x);
  float dhdv = (heightAt(p + ivec2(0, 1)) - heightAt(p - ivec2(0, 1))) / (2.0 * t.y);
  vec3 n = normalize(vec3(-uRelief * dhdu, -uRelief * dhdv, 1.0));
  outNormal = vec4(0.5 * n + 0.5, 1.0);
}
`;

// One triangle that covers the whole target: vertices 0, 1, 2 land at (0, 0),
// (2, 0), (0, 2), which in clip space is (-1, -1), (3, -1), (-1, 3)
const SKIN_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(2.0 * p - 1.0, 0.0, 1.0);
}
`;

// Returns generateSkin(kind, options) -> { color, normal }, normal null for
// the unlit kinds. options:
//   size      [width, height] in texels at full quality
//   uniforms  the pattern's uniforms, by name
//   seed      lays out a different skin with the same settings
//   relief    normal-map gain (1 = true slopes)
//   wrapV     whether v wraps for the normal pass
// scale shrinks every size (0.5 on phones: a quarter of the memory), and no
// side exceeds the GPU's limit.
function createSkinGenerator(gl, { scale = 1 } = {}) {
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  const maxAniso = aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const vao = gl.createVertexArray();   // no attributes: the vertex shader makes its own
  const programs = new Map();

  function programFor(kind, pass) {
    const key = kind + ":" + pass;
    if (!programs.has(key)) {
      const main = pass === "surface" ? SKIN_SURFACE_MAIN : SKIN_NORMAL_MAIN;
      const prog = createProgram(SKIN_VS, SKIN_COMMON + SKIN_KINDS[kind].glsl + main);
      programs.set(key, { prog, set: uniformSetters(prog) });
    }
    return programs.get(key);
  }

  // A setter per active uniform, keyed by name ("uRows", not "uRows[0]").
  // Values may be numbers, arrays, or arrays of arrays; names a program
  // doesn't use (the compiler drops unused ones) are skipped.
  function uniformSetters(prog) {
    const set = {};
    for (let i = 0; i < gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i++) {
      const { name, type } = gl.getActiveUniform(prog, i);
      const loc = gl.getUniformLocation(prog, name);
      const flat = v => [v].flat(2);
      set[name.replace(/\[0\]$/, "")] = {
        [gl.FLOAT]: v => gl.uniform1fv(loc, flat(v)),
        [gl.FLOAT_VEC2]: v => gl.uniform2fv(loc, flat(v)),
        [gl.FLOAT_VEC3]: v => gl.uniform3fv(loc, flat(v)),
        [gl.FLOAT_VEC4]: v => gl.uniform4fv(loc, flat(v)),
        [gl.INT]: v => gl.uniform1i(loc, v),
        [gl.BOOL]: v => gl.uniform1i(loc, v ? 1 : 0),
        [gl.SAMPLER_2D]: v => gl.uniform1i(loc, v),
      }[type];
    }
    return set;
  }

  function draw(kind, pass, uniforms) {
    const { prog, set } = programFor(kind, pass);
    gl.useProgram(prog);
    for (const [name, value] of Object.entries(uniforms)) set[name]?.(value);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Immutable RGBA8 storage. The final textures get a full mip chain, trilinear
  // filtering and the most anisotropy the GPU offers, which is what keeps the
  // saucer sharp when it's seen nearly edge-on.
  function target(w, h, mipmapped) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, mipmapped ? 1 + Math.floor(Math.log2(Math.max(w, h))) : 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mipmapped ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (aniso && mipmapped) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, maxAniso);
    return tex;
  }

  return function generateSkin(kind, { size: [w0, h0], uniforms = {}, seed = 1, relief = 1, wrapV = false }) {
    const k = Math.min(scale, maxSize / Math.max(w0, h0));
    const w = Math.max(4, Math.round(w0 * k)), h = Math.max(4, Math.round(h0 * k));
    const withNormal = SKIN_KINDS[kind].normal;
    const common = { ...uniforms, uSize: [w, h], uSeed: seed };

    // Everything this changes, to put back after
    const saved = { prog: gl.getParameter(gl.CURRENT_PROGRAM), viewport: gl.getParameter(gl.VIEWPORT),
      caps: [gl.DEPTH_TEST, gl.BLEND, gl.CULL_FACE, gl.SCISSOR_TEST].map(cap => [cap, gl.isEnabled(cap)]) };
    saved.caps.forEach(([cap]) => gl.disable(cap));
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(vao);

    // Pass 1: color, and the height if there will be a normal map
    const color = target(w, h, true);
    const height = withNormal ? target(w, h, false) : null;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    if (height) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, height, 0);
    gl.drawBuffers(height ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
    draw(kind, "surface", common);

    // Pass 2: normals from the height, which comes off the framebuffer first
    // so it isn't sampled and drawn to at once
    let normal = null;
    if (height) {
      normal = target(w, h, true);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, normal, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, height);
      draw(kind, "normal", { ...common, uHeight: 0, uRelief: relief, uWrapV: wrapV });
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(height);
    for (const tex of [color, normal]) {
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    gl.bindVertexArray(null);
    gl.useProgram(saved.prog);
    gl.viewport(...saved.viewport);
    saved.caps.forEach(([cap, on]) => on && gl.enable(cap));
    return { color, normal };
  };
}
