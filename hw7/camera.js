// Chase camera and lens.
//
// In orbit the view is the free one: the scene turns under the mouse and the
// arrow keys walk the camera around, through a 45 degree rectilinear lens.
// The moment "Engage" is pressed the camera swings in behind the ship, to a
// chase position far enough back for the plain lens to frame it:
//
//   k            = smootherstep(time since the press / CHASE.blend), so the
//                  swing eases in and out
//
// The instant the ship jumps to warp (scene.js) a second weight starts:
//
//   w            = easeOutCubic(time at warp / CHASE.warpBlend)
//
// w is a dolly zoom. It pulls the camera in tight behind the ship while, as
// `lensFisheye`, it opens the lens out into the stretched fisheye, so the ship
// holds its size on screen as the universe around it balloons outward. It
// leaves at full speed, which is the jump, under the warp flash (main.js), and
// settles gently. Both weights drop back to 0 at a reset.

const CHASE = {
  blend: 3.0,                     // s, the swing in
  // Closer in and wider out than a plain chase view: the wider the lens, the
  // harder it bows the scene; pulling in by the same factor keeps the ship
  // the same size on screen while it bulges toward the lens.
  dist: 2.2,                      // units behind the ship's middle before warp,
  height: 0.7,                    //   and above it: the plain lens frames it whole
  warpDist: 0.95,                 // at warp: the hull's tail reaches 0.62 back,
                                  //   the nacelle tail cones 0.95 back but 0.32
                                  //   off to either side
  warpHeight: 0.30,               // and above it, clear of the hull and saucer
  warpBlend: 0.55,                // s, the dolly zoom into warp
  fishHalfX: 125 * Math.PI / 180, // half the fisheye's horizontal field of view
  fishStretch: 1.8,               // the fisheye's vertical stretch (see the lens),
  fishPivot: -0.47                //   about this height on screen (-1 bottom, 1 top)
};

// The lens, read by the ray tracer every frame: 0 = the projection matrix's
// rectilinear view, 1 = full fisheye. The fisheye is equisolid,
// r = sin(theta / 2) / sin(fishHalfX / 2), stretched fishStretch times
// vertically about fishPivot, so the ship draws out nose to tail; the ray
// tracer runs that mapping backwards to find each pixel's ray (raytrace.js).
let lensFisheye = 0;

let chaseGrab = null;   // the drag angles when this chase began

// The camera's own frame inside the ship's: dist behind the ship's middle and
// height above it, pitched down by atan(height / dist) so the ship sits in the
// middle of the frame. The rotateY(PI) is there because the ship flies up its
// own +z while an eye looks down its own -z.
function chaseEyeFrame(dist, height) {
  return multiply(multiply(rotateX(Math.atan2(height, dist)), rotateY(Math.PI)),
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
function chaseView(ship, look, dist, height) {
  return multiply(multiply(chaseEyeFrame(dist, height), look), inverseShipFrame(ship));
}

const easeOutCubic = u => u <= 0 ? 0 : u >= 1 ? 1 : 1 - (1 - u) ** 3;

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
    chaseGrab = null;
    return free;
  }
  const k = smootherstep(sincePress / CHASE.blend);
  const w = lensFisheye = ship.warpTau === null ? 0 : easeOutCubic(ship.warpTau / CHASE.warpBlend);

  // Only the dragging done since the chase took over counts, so taking the
  // mouse never snaps the view
  chaseGrab ??= { ...drag };

  const look = multiply(rotateY(drag.y - chaseGrab.y), rotateX(drag.x - chaseGrab.x));
  const chase = chaseView(ship, look, CHASE.dist + (CHASE.warpDist - CHASE.dist) * w,
    CHASE.height + (CHASE.warpHeight - CHASE.height) * w);
  return k >= 1 ? chase : blendViews(free, chase, k);
}

// ---------------------------------------------------------------------------
// The free camera: focus and zoom
//
// The free view turns the scene about a focus point and stands back from it:
//
//   view = translate(pan, -dist) * rotation * translate(-focus)
//
// The focus starts on the planet. Clicking the ship, the planet or the moon slides it
// onto that object over FOCUS.blend (smootherstep), from wherever it was; on
// the ship or the moon it then rides along. The arrow-key pan eases back to zero
// over the same slide, so the object ends up dead center.
//
// A click hits the planet's or the moon's own sphere, or a box around the ship in its own
// frame that holds every vertex, and the nearer hit along the ray wins: the
// ship in front of the planet is picked, the ship hidden behind it is not.
//
// The scroll wheel scales the distance by exp(ZOOM.perPixel * deltaY), and
// w / s by exp(ZOOM.keyStep), so a step is the same proportion near or far.
// The distance eases toward that goal with time constant ZOOM.ease, in log
// space so near and far zooms feel alike, and stays within per-object bounds.
//
// Following the ship, the eye stands a fixed offset from it, so once an orbit
// that offset can carry it into the planet. Whenever it would come within
// ZOOM.clearPlanet of the surface it is pushed straight out to that height
// instead, the view direction kept: the camera rides over the surface
// for that stretch and lets go again as the ship comes round.
// ---------------------------------------------------------------------------

const FOCUS = { blend: 1.2 };     // s, the slide onto a newly clicked object
const ZOOM = {
  start: 14,                      // distance on load and after a reset
  // Nearest the camera may come. Around the planet it stays outside the ship's
  // whole sweep (orbit radius + half its length), so the ship never flies
  // through the lens; around the ship it stays outside the ship's box.
  min: { planet: 5.6, ship: 1.2, moon: 2.0 },
  max: 30,                        // inside the star sphere even from the ship
  clearPlanet: 0.25,              // nearest the eye comes to the planet's surface
  perPixel: 0.0012,               // about 13% a wheel notch
  keyStep: 0.015,                 // log distance per w / s, about 1.5%
  ease: 0.12                      // s
};

// `pivot` and `panLeft` are this frame's focus point and the pan still easing
// away; `from` and `fromPan` are what they were when the slide began
let camFocus, zoom;
function resetFreeCamera() {
  camFocus = { on: "planet", from: [0, 0, 0], fromPan: [0, 0], t0: -Infinity,
               pivot: [0, 0, 0], panLeft: [0, 0] };
  zoom = { dist: ZOOM.start, goal: ZOOM.start };
}

const focusPoint = (on, ship, moon) =>
  on === "ship" ? transformPoint(rotateX(ORBIT.tilt), ship.pos) : on === "moon" ? moon : [0, 0, 0];

function setZoomGoal(d) {
  zoom.goal = Math.min(ZOOM.max, Math.max(ZOOM.min[camFocus.on], d));
}
const zoomWheel = px => setZoomGoal(zoom.goal * Math.exp(ZOOM.perPixel * px));
const zoomKey = dir => setZoomGoal(zoom.goal * Math.exp(dir * ZOOM.keyStep));

// Start the slide onto `on`. `pan` is the arrow-key pan as it stands, which
// the caller zeroes: it is folded into what eases away.
function focusOn(on, now, pan) {
  Object.assign(camFocus, { on, from: camFocus.pivot, fromPan: vadd(camFocus.panLeft, pan), t0: now });
  setZoomGoal(zoom.goal);
}

// Once a frame, before updateCamera: the free view. `now` is real time (the
// slide doesn't care about resets), dt the frame's length.
function freeView(now, dt, ship, moon, rotation, [panX, panY]) {
  const s = smootherstep((now - camFocus.t0) / FOCUS.blend);
  camFocus.pivot = vadd(camFocus.from, vmul(vsub(focusPoint(camFocus.on, ship, moon), camFocus.from), s));
  camFocus.panLeft = vmul(camFocus.fromPan, 1 - s);
  zoom.dist *= (zoom.goal / zoom.dist) ** (1 - Math.exp(-dt / ZOOM.ease));
  const eye = translate(panX + camFocus.panLeft[0], panY + camFocus.panLeft[1], -zoom.dist);
  const view = multiply(multiply(eye, rotation), translate(...vmul(camFocus.pivot, -1)));

  // Keep the eye out of the planet: move it to `clear` with the rotation as
  // is, which is view * translate(eye - clear)
  const at = viewParts(view).eye, r = Math.hypot(...at), rClear = PLANET.radius + ZOOM.clearPlanet;
  if (r >= rClear) return view;
  const clear = r > 1e-6 ? vmul(at, rClear / r) : untransformVector(view, [0, 0, rClear]);
  return multiply(view, translate(...vsub(at, clear)));
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
// view, ship and moon of the frame it was clicked on: "ship", "planet", "moon"
// or null. The
// plain lens sends eye-space direction (x / P00, y / P11, -1) to that pixel,
// and the view's rotation is undone by its transpose. Only for the free view,
// whose lens is the plain one. The ship's frame is rigid, so t along the ray
// means the same distance in it as in the world and the two hits compare.
function pickObject(x, y, view, ship, moon) {
  const d = untransformVector(view, [x / projection[0], y / projection[5], -1]);
  const o = viewParts(view).eye;

  const toShip = inverseShipFrame(ship);
  const hits = [
    ["ship", rayHitsBox(transformPoint(toShip, o), transformVector(toShip, d),
      vmul(SHIP_HALF_EXTENT, ORBIT.shipScale))],
    ["planet", rayHitsSphere(o, d, PLANET.radius)],
    ["moon", rayHitsSphere(vsub(o, moon), d, MOON.radius)]
  ].filter(([, t]) => t !== null);
  if (!hits.length) return null;
  return hits.reduce((a, b) => b[1] < a[1] ? b : a)[0];
}
