// Chase camera and lens.
//
// In orbit the view is the free one: the scene turns under the mouse and the
// a two-finger drag walks the camera around, through a 45 degree rectilinear lens.
// The moment "Engage" is pressed the camera swings in behind the ship, to a
// chase position far enough back for the plain lens to frame it:
//
//   k            = smootherstep(time since the press / CHASE.blend), so the
//                  swing eases in and out
//
// The instant the ship jumps to warp (scene.js) a second weight starts:
//
//   w            = smootherstep(time at warp / CHASE.warpBlend)
//
// w opens the lens smoothly into the stretched fisheye while the camera falls
// monotonically behind the ship (`lag`), keeping the ship centered on screen
// without any upward pitch or pivot jolt. Both weights drop back to 0 at a reset.

const CHASE = {
  blend: 3.0,                     // s, the swing in
  dist: 1.65,                     // units behind the ship's middle before warp,
  height: 0.52,                   //   and above it: the plain lens frames it whole
  warpDist: 1.65,                 // matches pre-warp dist so pull-away is purely monotonic
  warpHeight: 0.42,               // gently settles slightly lower over the wake
  warpBlend: 0.90,                // s, smooth C2 transition into the warp lens
  warpLagRate: 2.7,               // units/s the camera falls behind at warp
  warpLagKnee: 0.6,               // s before steady fallback reaches full rate
  fishHalfX: 138 * Math.PI / 180, // half the fisheye's horizontal field of view
  fishStretch: 2.15,              // sustained vertical stretch during warp
  fishPivot: 0                    // centered vertically so stretching never shifts the horizon up
};

// The lens, read by the ray tracer every frame: 0 = the projection matrix's
// rectilinear view, 1 = full fisheye. The fisheye is equisolid,
// r = sin(theta / 2) / sin(fishHalfX / 2), stretched lensStretch times
// vertically about fishPivot, so the ship draws out nose to tail; the ray
// tracer runs that mapping backwards to find each pixel's ray (raytrace.js).
let lensFisheye = 0;
let lensStretch = CHASE.fishStretch;

let chaseGrab = null;   // the drag angles when this chase began
let warpGrab = null;    // frozen drag angles once warp begins

// The camera's own frame inside the ship's: dist behind the ship's middle and
// height above it, pitched down toward (0, aimY, 0) in ship space. The
// rotateY(PI) is there because the ship flies up its own +z while an eye looks
// down its own -z.
function chaseEyeFrame(dist, height, aimY = 0) {
  return multiply(multiply(rotateX(Math.atan2(height - aimY, dist)), rotateY(Math.PI)),
    translate(0, -height, dist));
}

// The ship is drawn in rotateX(tilt) * translate(pos) * rotateY(heading), and
// that product inverts term by term -- no general inverse needed
function inverseShipFrame({ pos, heading }) {
  return multiply(multiply(rotateY(-heading), translate(-pos[0], -pos[1], -pos[2])),
    rotateX(-ORBIT.tilt));
}

// The view matrix that rides the ship. `look` turns the ship's frame before the
// camera is placed in it, which swings the camera around the ship.
function chaseView(ship, look, dist, height, aimY = 0) {
  return multiply(multiply(chaseEyeFrame(dist, height, aimY), look), inverseShipFrame(ship));
}

// Blend of two rigid views: slerp the rotation, and slide the eye along an arc
// about the planet rather than a straight line, which would cut through it on
// the way in. The arc keeps the eye at least as far out as the nearer of the
// two viewpoints.
function blendViews(from, to, k) {
  const a = viewParts(from), b = viewParts(to);
  const r0 = Math.hypot(...a.eye), r1 = Math.hypot(...b.eye);
  let eye = a.eye.map((v, i) => v + (b.eye[i] - v) * k);          // straight line
  if (r0 > 1e-3 && r1 > 1e-3) {
    const dir = a.eye.map((v, i) => v / r0 + (b.eye[i] / r1 - v / r0) * k);
    const len = Math.hypot(...dir);
    // len collapses only if the two viewpoints are exactly opposite, where no
    // arc between them is any better than another: keep the straight line
    if (len > 1e-3) eye = dir.map(v => v * (r0 + (r1 - r0) * k) / len);
  }
  return viewFromParts(slerp(a.q, b.q, k), eye);
}

// Once a frame: set the lens and return the view matrix. Everything follows from
// the scene clock and the flight, so a reset (back in orbit) needs no extra step.
//   t:    the scene clock
//   free: the matrix the free camera would use on its own
//   drag: the mouse drag angles, so dragging still looks around while chasing
function updateCamera(t, ship, free, drag) {
  const sincePress = engageElapsed(t);
  if (sincePress === null) {
    lensFisheye = 0;
    lensStretch = CHASE.fishStretch;
    chaseGrab = null;
    warpGrab = null;
    return free;
  }
  const k = smootherstep(sincePress / CHASE.blend);
  const wt = ship.warpTau;
  const w = lensFisheye = wt === null ? 0 : smootherstep(wt / CHASE.warpBlend);

  // Smoothly fall behind the ship as it accelerates away at warp, keeping the
  // vertical stretch and aim steady with zero jump or rebound.
  lensStretch = CHASE.fishStretch;
  const lag = wt === null ? 0 : CHASE.warpLagRate * (wt * wt) / (wt + CHASE.warpLagKnee);

  // Only the dragging done since the chase took over counts, so taking the
  // mouse never snaps the view; once warp begins, lock the camera orientation.
  chaseGrab ??= { ...drag };
  if (wt === null) {
    warpGrab = null;
  } else {
    warpGrab ??= { ...drag };
  }
  const activeDrag = warpGrab ?? drag;

  const pitch = Math.max(-1.2, Math.min(1.2, activeDrag.x - chaseGrab.x));
  const look = multiply(rotateY(activeDrag.y - chaseGrab.y), rotateX(pitch));
  const chase = chaseView(ship, look,
    CHASE.dist + (CHASE.warpDist - CHASE.dist) * w + lag,
    CHASE.height + (CHASE.warpHeight - CHASE.height) * w,
    0);
  return k >= 1 ? chase : blendViews(free, chase, k);
}

// ---------------------------------------------------------------------------
// The free camera: focus and zoom
//
// The free view turns the scene about a focus point and stands back from it:
//
//   view = translate(pan, -dist) * rotation * translate(-focus)
//
// The focus starts on the ship. Clicking the ship, the planet or the moon slides it
// onto that object over FOCUS.blend (smootherstep), from wherever it was; on
// the ship or the moon it then rides along. The two-finger pan eases back to zero
// over the same slide, so the object ends up dead center.
//
// A click hits the planet's or the moon's own sphere, or a box around the ship in its own
// frame that holds every vertex, and the nearer hit along the ray wins: the
// ship in front of the planet is picked, the ship hidden behind it is not.
//
// The scroll wheel scales the distance by exp(ZOOM.perPixel * deltaY), so a
// notch is the same proportion near or far; a pinch scales it by the spread.
// The distance eases toward that goal with time constant ZOOM.ease, in log
// space so near and far zooms feel alike, and stays within per-object bounds.
// At max zoom (nearest distance) on the ship or moon, the camera smoothly locks
// to that object's orbital heading (keeping the planet world-fixed), so the
// object holds its orientation while mouse dragging still looks around it.
//
// Following the ship, the eye stands a fixed offset from it, so once an orbit
// that offset can carry it into the planet. Whenever it would come within
// ZOOM.clearPlanet of the surface it is pushed straight out to that height
// instead, the view direction kept: the camera rides over the surface
// for that stretch and lets go again as the ship comes round.
// ---------------------------------------------------------------------------

const FOCUS = { blend: 1.2 };     // s, the slide onto a newly clicked object
const ZOOM = {
  start: 10,                      // distance on load and after a reset
  // Nearest the camera may come. Around the planet it stays outside the ship
  // and glass prism's outer sweep, so neither flies through the lens; around
  // the ship and moon it clears their bounding extents. The prism itself is
  // kept out of from any view (keepOutOfMoon).
  min: { planet: 18, ship: 1.22, moon: 3.4 },
  max: 18,                        // the planet view's own distance (min.planet), so it can't zoom
  clearPlanet: 0.5,               // nearest the eye comes to the planet's surface
  perPixel: 0.0012,               // about 13% a wheel notch
  ease: 0.12                      // s
};
const LOCK = {
  goalTol: 1.001,                 // zoom.goal within 0.1% of ZOOM.min counts as max zoom
  distTol: 1.15,                  // wait until zoom.dist has nearly reached max zoom
  blend: 0.25                     // s, smooth ramp in and out of orbital co-rotation
};

// `pivot` and `panLeft` are this frame's focus point and the pan still easing
// away; `from` and `fromPan` are what they were when the slide began
let camFocus, zoom, camLock;
function resetFreeCamera() {
  const start = focusPoint("ship", { pos: orbitPoint(orbitAngle(0)) }, null);
  camFocus = { on: "ship", from: start, fromPan: [0, 0], t0: -Infinity,
               pivot: start, panLeft: [0, 0], switching: false };
  zoom = { dist: ZOOM.start, goal: ZOOM.start };
  camLock = { angle: 0, u: 0, lastHeading: null };
}

const focusPoint = (on, ship, moon) =>
  on === "ship" ? transformPoint(rotateX(ORBIT.tilt), ship.pos) : on === "moon" ? moon : [0, 0, 0];
const focusHeading = (on, ship, t) =>
  on === "ship" ? ship.heading : on === "moon" ? moonAngle(t) : null;
const wrapAngle = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

function setZoomGoal(d) {
  zoom.goal = Math.min(ZOOM.max, Math.max(ZOOM.min[camFocus.on], d));
}
const zoomWheel = px => setZoomGoal(zoom.goal * Math.exp(ZOOM.perPixel * px));
const zoomPinch = ratio => setZoomGoal(zoom.goal * ratio);

// Start the slide onto `on`. `pan` is the two-finger pan as it stands, which
// the caller zeroes: it is folded into what eases away.
function focusOn(on, now, pan) {
  const switched = on !== camFocus.on;
  Object.assign(camFocus, { on, from: camFocus.pivot, fromPan: vadd(camFocus.panLeft, pan), t0: now,
                            switching: switched || camFocus.switching });
  if (switched) {
    camLock.u = 0;
    camLock.lastHeading = null;
  }
  setZoomGoal(zoom.goal);
}

// Once a frame, before updateCamera: the free view. `now` is real time (the
// slide doesn't care about resets), `t` the scene clock, dt the frame's length.
function freeView(now, dt, t, ship, moon, rotation, [panX, panY]) {
  const s = smootherstep((now - camFocus.t0) / FOCUS.blend);
  if (s >= 1) camFocus.switching = false;
  camFocus.pivot = vadd(camFocus.from, vmul(vsub(focusPoint(camFocus.on, ship, moon), camFocus.from), s));
  camFocus.panLeft = vmul(camFocus.fromPan, 1 - s);
  zoom.dist *= (zoom.goal / zoom.dist) ** (1 - Math.exp(-dt / ZOOM.ease));

  const heading = focusHeading(camFocus.on, ship, t);
  const minDist = ZOOM.min[camFocus.on];
  const settled = !camFocus.switching || s >= 0.85;
  const atMax = heading !== null && settled &&
    zoom.goal <= minDist * LOCK.goalTol && zoom.dist <= minDist * LOCK.distTol;
  const step = dt / LOCK.blend;
  camLock.u = atMax ? Math.min(1, camLock.u + step) : Math.max(0, camLock.u - step);
  if (heading !== null) {
    if (camLock.lastHeading !== null) {
      const w = smootherstep(camLock.u);
      if (w > 0) camLock.angle = wrapAngle(camLock.angle + w * wrapAngle(heading - camLock.lastHeading));
    }
    camLock.lastHeading = heading;
  } else {
    camLock.lastHeading = null;
  }

  const viewRot = camLock.angle === 0 ? rotation
    : multiply(rotation, multiply(rotateX(ORBIT.tilt),
        multiply(rotateY(-camLock.angle), rotateX(-ORBIT.tilt))));
  const eye = translate(panX + camFocus.panLeft[0], panY + camFocus.panLeft[1], -zoom.dist);
  const view = multiply(multiply(eye, viewRot), translate(...vmul(camFocus.pivot, -1)));

  // Keep the eye out of the planet: move it to `clear` with the rotation as
  // is, which is view * translate(eye - clear)
  const at = viewParts(view).eye, r = Math.hypot(...at), rClear = PLANET.radius + ZOOM.clearPlanet;
  if (r >= rClear) return view;
  const clear = r > 1e-6 ? vmul(at, rClear / r) : untransformVector(view, [0, 0, rClear]);
  return multiply(view, translate(...vsub(at, clear)));
}

// The glass prism is solid to the camera, whatever it is doing: free, riding
// the ship as it flies through the prism, or chasing it at Engage. An eye that
// would be inside is slid straight out from the prism's center line, in its
// cross-section, onto the hexagon grown by the surface's ripple (12% of the
// apothem) and MOON_CLEAR.pad; the view's rotation is kept, as for the planet.
// Past each end cap that hexagon shrinks away over MOON_CLEAR.ends of arc, so
// an eye coming at an end rides up over it instead of jumping from the cap
// face to the side -- the push is continuous everywhere off the center line.
const MOON_CLEAR = { pad: 0.12, ends: 1.6 };
function keepOutOfMoon(view, t) {
  const at = viewParts(view).eye;
  const p = transformPoint(inverseMoonFrame(t), at);
  const { rho, dr, u, v } = moonSection(p, t);
  if (rho < 1e-6) return view;
  const past = (Math.abs(Math.atan2(p[2], p[0])) - MOON.halfAngle) * rho;   // arc beyond the nearer cap
  const need = (1 - smootherstep(past / MOON_CLEAR.ends)) * (1.12 * MOON.apothem + MOON_CLEAR.pad);
  const have = hexRadius(u, v);
  if (have >= need) return view;
  // Scale the offset (dr, y) from the center line up to the hexagon; on the
  // line itself, there is no direction to keep, so go straight out
  const spin = moonSpin(t);
  const [ddr, dy, from] = have > 1e-6 ? [dr, p[1], have] : [1, 0, hexRadius(Math.cos(spin), -Math.sin(spin))];
  const k = need / from;
  const out = (ORBIT.radius + ddr * k) / rho;
  const target = transformPoint(moonFrame(t), [p[0] * out, dy * k, p[2] * out]);
  return multiply(view, translate(...vsub(at, target)));
}

// Where the ray o + t d (t >= 0) enters the box |p_i| <= half_i, as t, or null
// if it misses: the slab test, narrowing the span of t the ray spends inside
// each pair of faces
function rayHitsBox(o, d, half) {
  let near = 0, far = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (Math.abs(o[i]) > half[i]) return null;
      continue;
    }
    const a = (-half[i] - o[i]) / d[i], b = (half[i] - o[i]) / d[i];
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return near;
}

const HEX_S3 = Math.sqrt(3) / 2;
function rayHitsHexTorus(o, d, R, r, halfAngle, spin) {
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-12) return null;
  const u = [d[0] / len, d[1] / len, d[2] / len];
  const sinA = Math.sin(halfAngle), cosA = Math.cos(halfAngle);
  let w0 = 0, w1 = Infinity, hole0 = Infinity, hole1 = -Infinity;

  for (const nz of [cosA, -cosA]) {
    const op = -sinA * o[0] + nz * o[2];
    const dp = -sinA * u[0] + nz * u[2];
    if (Math.abs(dp) < 1e-12) {
      if (op > 0) return null;
    } else {
      const tc = -op / dp;
      if (dp < 0) w0 = Math.max(w0, tc);
      else w1 = Math.min(w1, tc);
    }
  }
  if (w0 >= w1) return null;

  const rBound = 1.16 * r;
  if (Math.abs(u[1]) < 1e-12) {
    if (Math.abs(o[1]) > rBound) return null;
  } else {
    const ya = (-rBound - o[1]) / u[1], yb = (rBound - o[1]) / u[1];
    w0 = Math.max(w0, Math.min(ya, yb));
    w1 = Math.min(w1, Math.max(ya, yb));
    if (w0 >= w1) return null;
  }

  const rOut = R + rBound, rIn = Math.max(R - rBound, 0);
  const a = u[0] * u[0] + u[2] * u[2];
  const b = o[0] * u[0] + o[2] * u[2];
  const oo2 = o[0] * o[0] + o[2] * o[2];
  const cOut = oo2 - rOut * rOut;
  if (a < 1e-12) {
    if (cOut > 0 || (rIn > 0 && oo2 < rIn * rIn)) return null;
  } else {
    const discOut = b * b - a * cOut;
    if (discOut < 0) return null;
    const sqOut = Math.sqrt(discOut);
    w0 = Math.max(w0, (-b - sqOut) / a);
    w1 = Math.min(w1, (-b + sqOut) / a);
    if (w0 >= w1) return null;

    if (rIn > 0) {
      const discIn = b * b - a * (oo2 - rIn * rIn);
      if (discIn > 0) {
        const sqIn = Math.sqrt(discIn);
        const i0 = (-b - sqIn) / a, i1 = (-b + sqIn) / a;
        if (i0 <= w0 && i1 >= w1) return null;
        if (i0 <= w0 && i1 > w0) w0 = i1;
        else if (i1 >= w1 && i0 < w1) w1 = i0;
        else if (i0 > w0 && i1 < w1) { hole0 = i0; hole1 = i1; }
      }
    }
  }
  if (w0 >= w1) return null;

  const cs = Math.cos(spin), sn = Math.sin(spin);
  const sideEval = x => {
    const px = o[0] + u[0] * x, py = o[1] + u[1] * x, pz = o[2] + u[2] * x;
    const dr = Math.hypot(px, pz) - R;
    const hu = cs * dr + sn * py, hv = -sn * dr + cs * py;
    const dY = Math.abs(hv);
    return Math.max(dY, HEX_S3 * Math.abs(hu) + 0.5 * dY) - r;
  };

  let prevX = w0, prevV = sideEval(prevX);
  if (prevV <= 0) return prevX / len;

  for (let k = 0; k < 64; k++) {
    if (prevX >= hole0 && prevX < hole1) {
      prevX = hole1;
      prevV = sideEval(prevX);
    }
    let x = prevX + Math.max(prevV * 0.95, k === 0 ? 0.005 : 0.03);
    if (prevX < hole0 && x > hole0) x = hole0;
    if (x > w1) x = w1;
    const v = sideEval(x);
    if (v <= 0) {
      let lo = prevX, hi = x;
      for (let j = 0; j < 8; j++) {
        const mid = 0.5 * (lo + hi);
        if (sideEval(mid) <= 0) hi = mid;
        else lo = mid;
      }
      return 0.5 * (lo + hi) / len;
    }
    if (x >= w1) return null;
    prevX = x;
    prevV = v;
  }
  return null;
}

// The same for the sphere |p| <= r about the origin: the smaller root of
// |o + t d|^2 = r^2, or the larger if the ray starts inside
function rayHitsSphere(o, d, r) {
  const a = vdot(d, d), b = vdot(o, d), c = vdot(o, o) - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const near = (-b - Math.sqrt(disc)) / a, far = (-b + Math.sqrt(disc)) / a;
  return near >= 0 ? near : far >= 0 ? 0 : null;
}

// What a click at (x, y) in normalized device coordinates lands on, given the
// view, ship and scene time t of the frame it was clicked on: "ship", "planet",
// "moon" or null. The plain lens sends eye-space direction (x / P00, y / P11, -1)
// to that pixel, and the view's rotation is undone by its transpose. Only for the
// free view, whose lens is the plain one. Rigid frames preserve t along the ray.
function pickObject(x, y, view, ship, t) {
  const d = untransformVector(view, [x / projection[0], y / projection[5], -1]);
  const o = viewParts(view).eye;

  const toShip = inverseShipFrame(ship);
  const toMoon = inverseMoonFrame(t);
  const hits = [
    ["ship", rayHitsBox(transformPoint(toShip, o), transformVector(toShip, d),
      vmul(SHIP_HALF_EXTENT, ORBIT.shipScale))],
    ["planet", rayHitsSphere(o, d, PLANET.radius)],
    ["moon", rayHitsHexTorus(transformPoint(toMoon, o), transformVector(toMoon, d),
      ORBIT.radius, MOON.apothem, MOON.halfAngle, moonSpin(t))]
  ].filter(([, t]) => t !== null);
  if (!hits.length) return null;
  return hits.reduce((a, b) => b[1] < a[1] ? b : a)[0];
}
