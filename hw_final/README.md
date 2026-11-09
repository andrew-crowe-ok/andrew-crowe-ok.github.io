# Pinball

A 3D pinball table rendered with WebGL 2, built as the CS 412 final project.

**Play it:** <https://andrew-crowe-ok.github.io/hw_final/>

## How to play

| Action | Keyboard | Touch |
| --- | --- | --- |
| Left flipper | `Z` or `←` (or left `Shift`) | Hold the left half of the screen |
| Right flipper | `/` or `→` (or right `Shift`) | Hold the right half of the screen |
| Launch | Hold `Space` (or `↓`), release to fire | Hold **LAUNCH**, release to fire |

- The longer you hold launch, the harder the ball is fired. About half a charge is enough to clear the top of the table; a weak launch rolls back onto the plunger to try again.
- You get three balls. Each bumper hit scores 100 points.
- After game over, press launch to start a new game.

The page switches between keyboard and touch controls based on whichever you used last, and the camera reframes the table to fit any screen, portrait or landscape.

## Project structure

Plain scripts with no build step, loaded in this order by `index.html`:

| File | Role |
| --- | --- |
| `transforms.js` | 4x4 matrix helpers (column-major): translate, scale, rotate, `compose`, `lookAt`, `frustum` |
| `models.js` | Unit cube, cylinder and sphere meshes (positions, normals, texture coordinates, tangents) |
| `physics.js` | Table layout, ball and flipper physics, scoring and game state. No rendering. |
| `render.js` | WebGL setup, shaders, camera, and drawing the table from the physics state |
| `main.js` | Keyboard and touch input, the HUD, and the frame loop |
| `index.html` | Canvas, HUD and control overlays, and their styles |

## Architecture

Every frame, `main.js` runs:

```
input → stepPhysics(dt) → render(insets) → update HUD
```

- **Physics owns the state.** `physics.js` holds everything in two objects: `table` (walls, bumpers, flippers) and `game` (ball, score, balls left, plunger). Input only calls `setFlipper(i, down)` and `setPlunger(down)`.
- **The renderer only reads.** `render.js` never changes game state, so it can be replaced (for example by a ray tracer) without touching the physics.
- **Two coordinate systems.** Physics works in 2D *table space*: x to the right, y up the table, 1 unit = one ball diameter, origin at the bottom-left corner. The renderer places that plane at world z = 0, with z pointing up out of the playfield.

## Physics

- **Simple colliders.** Walls are line segments, and bumpers and the ball are circles. A flipper is a segment with thickness (a capsule). Every collision is an exact closest-point test followed by pushing the ball out and reflecting its velocity with a per-surface bounciness.
- **No tunneling.** Each frame is split into 8 physics steps, and the ball's speed is capped, so it never moves more than its radius in one step.
- **Flippers.** Each flipper swings toward its up or rest angle at a fixed angular speed. When it hits the ball, the bounce is computed relative to the velocity of the flipper's surface at the contact point (ω × r), which is what gives a flick its power.
- **Bumpers.** A hit pushes the ball away at a guaranteed minimum speed, scores points, and starts a short flash timer the renderer reads.
- **Game states.** `ready` (ball on the plunger) → `play` → back to `ready` on a drain while balls remain, or `over`.

## Rendering

- **Lighting.** Blinn-Phong shading with two point lights: a warm key light above the table and a dim, cool fill from the player's side. Each material sets a color, specular strength and shininess; bumpers add an emissive glow when hit.
- **Normals.** The vertex shader transforms normals by the inverse transpose of the model-view matrix, since most parts are non-uniformly scaled primitives.
- **Hierarchical modeling.** Each flipper is built in its own frame (translate to the pivot, then rotate by the flipper's angle), and its body, rounded ends and pivot cap are placed inside that frame.
- **Ball shadow.** A translucent disk where the line from the key light through the ball's center meets the table.
- **Camera.** A player's-eye view that tilts more overhead on tall screens. The projection is an off-center frustum fitted each frame so the whole cabinet fills the space between the HUD and the on-screen controls.

## Course topics

| Topic | Where it appears | Status |
| --- | --- | --- |
| Hierarchical modeling | Flippers (`drawFlipper` in `render.js`) | Done |
| Lighting and shading | Blinn-Phong, two lights, materials (`render.js` shaders) | Done |
| Computing normals | Inverse-transpose normal matrix (vertex shader) | Done |
| Texture mapping | Meshes already carry texture coordinates and tangents | Planned |
| Ray tracing | | Planned |

## Roadmap

- [ ] Ray-traced renderer (spheres, cylinders, boxes) with reflections and shadows
- [ ] Complex-log (Droste) warp applied to the whole screen at runtime
- [ ] Textures and normal maps for the playfield, cabinet and bumpers
- [ ] More table features: slingshots, targets, ramps
- [ ] Sound effects

## Team

| Member | Contributions |
| --- | --- |
| | |

## Credits

- `transforms.js` and `models.js` are adapted from CS 412 homework 7.
