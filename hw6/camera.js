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

// The lens, read by both programs every frame: 0 = the projection matrix as
// built, 1 = full fisheye
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

// The view matrix that rides the ship. The ship is drawn in
// rotateX(tilt) * translate(pos) * rotateY(heading), and that product inverts
// term by term -- no general inverse needed. `look` turns the ship's frame
// before the camera is placed in it, which swings the camera around the ship.
function chaseView({ pos, heading }, look, dist, height) {
  const inverseShip = multiply(multiply(rotateY(-heading), translate(-pos[0], -pos[1], -pos[2])),
    rotateX(-ORBIT.tilt));
  return multiply(multiply(chaseEyeFrame(dist, height), look), inverseShip);
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
// The lens, in GLSL. Both vertex shaders (main.js and stars.js) project through
// this, so the shared source lives here.
//
// A rectilinear projection puts a vertex on screen at a radius proportional to
// tan(theta), theta being its angle off the view axis: it is defined only for
// theta < 90 degrees and stretches without bound as it gets there. A fisheye
// maps the angle without that blow-up, which is why it can see past its own
// sides. This one is equisolid, r = sin(theta / 2) / sin(thetaMax / 2): it
// magnifies the middle of the frame and crowds the edges harder than an
// equidistant lens (r = theta / thetaMax), which is the fishbowl look. Both
// mappings push the vertex out along the same direction on screen, so blending
// them is a slide along that direction and the scene bows out smoothly.
//
// A fishbowl crowds things outward from the middle, and from behind the ship
// its length runs straight down the frame, so on its own the lens makes the
// ship look squat. The fisheye is therefore anamorphic: its image is stretched
// vertically by uFishStretch, which draws the ship out nose to tail. The
// stretch is about a line uFishPivot below the middle of the frame, near the
// hull's tail, so the ship grows up the frame rather than off its bottom.
//
// The fisheye has to carry distance in w rather than -z, since -z is zero or
// negative exactly where the lens is still supposed to see. Depth survives
// that: along any one pixel's ray, distance and -z are in fixed proportion, so
// the depth test still orders the same way. The near and far planes become
// spheres at those same distances from the eye.
// ---------------------------------------------------------------------------
const LENS_GLSL = `
uniform float uFisheye;      // 0 = the projection matrix as given, 1 = fisheye
uniform float uFishHalfX;    // half the fisheye's horizontal field of view
uniform float uFishStretch;  // vertical stretch of the fisheye's image
uniform float uFishPivot;    // the height on screen the stretch is about

// p: the vertex in eye space. proj: the usual perspective matrix.
vec4 project(mat4 proj, vec4 p) {
  if (uFisheye <= 0.0) return proj * p;

  // proj scales x by cot(fovy/2) / aspect and y by cot(fovy/2)
  float aspect = proj[1].y / proj[0].x;
  float d = length(p.xyz);
  float theta = acos(clamp(-p.z / max(d, 1e-5), -1.0, 1.0));
  vec2 dir = length(p.xy) < 1e-6 ? vec2(0.0) : normalize(p.xy);

  vec4 c = proj * p;
  // Vertices at or behind the eye plane have no rectilinear image at all, so
  // they are sent far out along dir -- off the frame, rather than mirrored
  // back into it -- and the fisheye brings them in as the blend takes over.
  vec2 rect = c.w > 1e-3 ? c.xy / c.w : dir * 40.0;
  // Equisolid, scaled so the horizontal edge of the frame is uFishHalfX off
  // axis; y carries the aspect, which would keep the image circle round, and
  // then the stretch, which draws it out into an upright ellipse
  vec2 fish = dir * (sin(0.5 * theta) / sin(0.5 * uFishHalfX)) * vec2(1.0, aspect);
  fish.y = uFishPivot + (fish.y - uFishPivot) * uFishStretch;

  // proj's own depth row, rewritten for d: it reads eye-space z, which is -d
  return vec4(mix(rect, fish, uFisheye) * d, proj[3].z - proj[2].z * d, d);
}
`;

// A setter for the lens uniforms above, for a program linked with LENS_GLSL
function lensUniforms(program) {
  const uFisheye = gl.getUniformLocation(program, "uFisheye");
  const uFishHalfX = gl.getUniformLocation(program, "uFishHalfX");
  const uFishStretch = gl.getUniformLocation(program, "uFishStretch");
  const uFishPivot = gl.getUniformLocation(program, "uFishPivot");
  return () => {
    gl.uniform1f(uFisheye, lensFisheye);
    gl.uniform1f(uFishHalfX, CHASE.fishHalfX);
    gl.uniform1f(uFishStretch, CHASE.fishStretch);
    gl.uniform1f(uFishPivot, CHASE.fishPivot);
  };
}
