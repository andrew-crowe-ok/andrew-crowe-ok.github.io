// Procedural textures: the ship's skin is generated here from code at load time,
// with no image files.
//
// A generator returns { color, height, size }:
//   color  = RGBA bytes, ready for texImage2D
//   height = Float32 relief in [0, 1] over the same pixels, for the parts that
//            are normal mapped (the bump-mapped saucer's has none)
// normalMap() bakes a height field into a tangent-space normal map, so a part's
// color map and normal map always describe one and the same surface.
//
// Everything tiles: the noise lattice wraps, and the panel lines land on whole
// numbers of cells, so the textures repeat without a visible seam.

const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// Integer hash -> [0, 1). Math.imul keeps the products in 32 bits.
function hash(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Value noise on a lattice that wraps every `period` cells
function noise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period;
  const y0 = ((yi % period) + period) % period, y1 = (y0 + 1) % period;
  return mix(mix(hash(x0, y0, seed), hash(x1, y0, seed), sx),
             mix(hash(x0, y1, seed), hash(x1, y1, seed), sx), sy);
}

// Fractal sum of value noise; each octave doubles the lattice, so it still tiles
function fbm(u, v, period, octaves, seed) {
  let sum = 0, amp = 1, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(u * p, v * p, p, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

// Distance in pixels from the nearest line at a whole number of t, where one
// unit of t spans cellPx pixels
const edgePx = (t, cellPx) => Math.abs(t - Math.round(t)) * cellPx;
// 1 on a line of width widthPx centered on every whole number of t, fading over 1 px
const line = (t, cellPx, widthPx) =>
  1 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1, edgePx(t, cellPx));

function put(color, i, r, g, b) {
  color[i * 4] = clamp01(r) * 255;
  color[i * 4 + 1] = clamp01(g) * 255;
  color[i * 4 + 2] = clamp01(b) * 255;
  color[i * 4 + 3] = 255;
}

// Saucer plating: spokes and concentric rings of panel lines. The saucer is a
// squashed sphere, so u (around the pole) draws the spokes and v (pole to pole)
// the rings -- seen from above, exactly the way a saucer hull is plated.
// This texture is used in bump mode, where the shader takes relief from the
// image's own luminance, so it needs no normal map; the material's negative
// bumpScale makes the dark lines read as grooves between raised plates.
function createSaucerTexture(size = 512, seed = 7) {
  const SPOKES = 36, RINGS = 12;
  const spokePx = size / SPOKES, ringPx = size / RINGS;
  const color = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size, ring = v * RINGS;
    const ringIndex = Math.floor(ring);
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, spoke = u * SPOKES;

      // One plate per (spoke, ring) cell, each with its own shade
      const plate = hash(Math.floor(spoke), ringIndex, seed);
      let g = 0.42 + (plate - 0.5) * 0.10;

      // Weathering, and the plates dulling toward the rim
      g *= 0.94 + 0.10 * fbm(u, v, 8, 3, seed + 3);
      g *= 1 - 0.06 * smoothstep(0.2, 0.5, Math.abs(v - 0.5));

      // Panel lines: every spoke (a few plates run double width), every ring,
      // and a heavier structural line every sixth spoke
      const minor = Math.max(plate > 0.86 ? 0 : line(spoke, spokePx, 1.5),
                             line(ring, ringPx, 2.0));
      const major = line(spoke / 6, spokePx * 6, 3.0);  // structural ribs
      const lines = Math.max(minor, major);
      g = mix(mix(g, g * 0.62, minor), g * 0.42, major);

      // Warm plates, cool shadow in the lines, like bare and shaded metal
      put(color, y * size + x, g * 1.04, g, g * 0.97 + 0.04 * lines);
    }
  }
  return { color, size };
}

// Plated metal for the hull and the nacelles: a color map and the matching
// height field, both drawn from one plate layout. cols runs along u (around the
// cylinder), rows along v (its length).
//   stripe  { at, width, color, relief }  raised conduit running the length
//   grille  { at, width, slats, color }   inset strip of slats (the warp grille)
function createPlating({
  size = 512, cols = 8, rows = 12, seed = 11,
  base = [0.40, 0.42, 0.46], seamColor = [0.14, 0.15, 0.18],
  stripe = null, grille = null
} = {}) {
  const colPx = size / cols, rowPx = size / rows;
  const color = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const [baseR, baseG, baseB] = base;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size, row = v * rows;
    const rowIndex = Math.floor(row), rowEdge = edgePx(row, rowPx);
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, col = u * cols;
      const i = y * size + x;
      const colEdge = edgePx(col, colPx);

      const plate = hash(Math.floor(col), rowIndex, seed);
      const grain = fbm(u, v, 16, 3, seed + 5);           // fine orange peel
      const streak = fbm(u * 3, v * 0.5, 8, 2, seed + 9); // stains along the length

      // Each plate crowns away from its edges, so the seams read as gaps
      // between separate sheets rather than scratches in one surface
      const bevel = Math.min(smoothstep(1, 6, colEdge), smoothstep(1, 6, rowEdge));
      let lines = Math.max(line(col, colPx, 2.0), line(row, rowPx, 2.0));
      let h = 0.5 + 0.055 * bevel + 0.05 * (grain - 0.5);

      const tint = (1 + (plate - 0.5) * 0.10) * (0.93 + 0.10 * grain) * (0.95 + 0.05 * streak);
      let r = baseR * tint, g = baseG * tint, b = baseB * tint;

      // A seventh of the plates are a recessed hatch with a raised lip
      if (plate > 0.86) {
        const inside = Math.min(smoothstep(4, 7, colEdge), smoothstep(4, 7, rowEdge));
        const lip = Math.max(0, Math.min(smoothstep(2, 4, colEdge),
                                         smoothstep(2, 4, rowEdge)) - inside);
        h += 0.10 * lip - 0.08 * inside;
        const dark = 1 - 0.16 * inside;
        r *= dark; g *= dark; b *= dark;
      }

      // Conduit running the length of the part: raised, a shade darker
      if (stripe) {
        const band = 1 - smoothstep(stripe.width * 0.5, stripe.width * 0.5 + 0.012,
                                    Math.abs(u - stripe.at));
        h += stripe.relief * band;
        r = mix(r, stripe.color[0], band);
        g = mix(g, stripe.color[1], band);
        b = mix(b, stripe.color[2], band);
      }

      // Grille: an inset strip of raised slats crossing the part's length. The
      // plate seams stop at its edge, so the grille reads as one long fixture.
      if (grille) {
        const inset = 1 - smoothstep(-0.012, 0.012,
                                     Math.abs(u - grille.at) - grille.width * 0.5);
        const slat = 1 - line(v * grille.slats, size / grille.slats, 3.0);
        h += inset * (-0.09 + 0.15 * slat);
        lines *= 1 - inset;
        const k = 0.6 + 0.55 * slat;
        r = mix(r, grille.color[0] * k, inset);
        g = mix(g, grille.color[1] * k, inset);
        b = mix(b, grille.color[2] * k, inset);
      }

      height[i] = clamp01(h - 0.42 * lines);
      // The seams stay dark in the color map too, so the panel lines read even
      // where the lighting is flat
      put(color, i, mix(r, seamColor[0], lines), mix(g, seamColor[1], lines),
          mix(b, seamColor[2], lines));
    }
  }
  return { color, height, size };
}

// Height field -> tangent-space normal map. The central differences wrap with
// the texture, and the frame is the shader's: T along u, B along v, N out.
function normalMap({ height, size }, strength = 7) {
  const out = new Uint8Array(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dhdu = (at(x + 1, y) - at(x - 1, y)) * 0.5 * strength;
      const dhdv = (at(x, y + 1) - at(x, y - 1)) * 0.5 * strength;
      const len = Math.hypot(dhdu, dhdv, 1);
      put(out, y * size + x, (-dhdu / len + 1) / 2, (-dhdv / len + 1) / 2, (1 / len + 1) / 2);
    }
  }
  return { color: out, size };
}
