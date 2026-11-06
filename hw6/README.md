# HW6: Texture Mapping

A WebGL2 scene of a starship orbiting a planet, with an **Engage** button that sends the ship to warp.

Live: https://andrew-crowe-ok.github.io/hw6/

## Controls

| Input | Action |
|---|---|
| Drag | Turn the scene (orbit the ship once Engage is pressed) |
| Click the ship or planet | Center the view on it |
| Scroll wheel, `w` / `s` | Zoom |
| Arrow keys | Pan |
| **Engage** | Warp; the scene resets 10 s later |

The Engage button appears after 10 s, 3 clicks, or 1.5 s of holding the mouse down. Clicking, zooming and panning work only in orbit; after Engage, dragging swings the chase camera around the ship.

To run it locally, serve the folder (`python3 -m http.server`, then open http://localhost:8000). Browsers block WebGL texture loads over `file://`.

## AI assistance

This was an iterative project built with Claude Code. The design evolved over many rounds of prompting and revision. Claude wrote and revised much of the code, including the geometry, shaders, camera and warp sequence.

### AI-generated assets
- **Ship textures** (saucer panel lines, hull, dome, nacelle plating, and their normal maps): generated procedurally at load time by code Claude wrote (`textures.js`). There are no image files for them.
- **Plasma video**: rendered by a Python script Claude wrote (`tools/make_plasma.py`).

## Primitives

| Primitive | Used for | Mapping |
|---|---|---|
| Sphere | Planet; saucer disc; dome; hull nose; Bussard collector | bump (planet, saucer), normal (dome, hull nose), animated (collector) |
| Torus | Saucer rim | bump |
| Cone | Deflector dish and antenna (`mars2.jpg`); nacelle caps | bump (deflector), normal (nacelle) |
| Cylinder | Engineering hull and nacelles | normal |
| Cube | Neck and pylons | normal |

All five primitives are built in `models.js` with per-vertex normals, tangents and UVs. The sphere, torus and cone are the curved ones.

## Texture mapping

- **Bump mapping**: the shader tilts the normal using the gradient of the texture's luminance. The planet (antelope photo), the saucer and its rim (procedural panel lines), and the deflector dish and antenna (`mars2.jpg`) use it.
- **Normal mapping**: the dome, hull and nacelles (with the neck, pylons and nacelle caps) have a color map plus a tangent-space normal map baked from the same height field (`normalMap()` in `textures.js`), so paint and relief always match.
- **Animated texture**: the Bussard collectors are lit by a looping plasma video (`textures/plasma.webm` / `.mp4`). The current frame is re-uploaded to the GPU each render (`loadVideoTexture` in `main.js`). The swirl is periodic in u, so it wraps around the sphere without a seam, and loops cleanly in time.

## Functional approach

The code uses plain functions and data, with no classes.

- **Hierarchy by composition**: each part is a `drawX(parent)` function that takes its parent's transform matrix, multiplies in its own local transform, and passes the result to its children (`ship.js`, `scene.js`). The ship, saucer, dome, hull, pylons and nacelles all nest this way, and the planet and orbit are siblings so the planet's spin never reaches the ship.
- **Pure helpers**: `multiply`, `translate`, `rotateY` and the other transform functions return new matrices, and `normalMap()` turns a height field into a normal map without side effects.
- **Textures as data**: each generator in `textures.js` returns `{ color, height, size }`, which is uploaded to the GPU in one place (`main.js`).
- **One draw call**: every object goes through `drawPrimitive(mesh, texture, mapping, modelView, material, normalMap)`, so the mapping mode (bump, normal, emissive) is an argument rather than a different code path.

## How it was built

The scene was built in small steps, roughly one commit per feature.

1. **Starting point:** the HW5 boilerplate (cube, cylinder, sphere, pyramid, Newton's cradle) with the shader editors removed so the canvas fills the window.
2. **Saucer first:** a flattened sphere as the root of a transform hierarchy, then a normal-mapped dome as its child.
3. **One primitive per step:** the torus rim, then the engineering hull with a sphere nose and tilted neck, then the cone deflector dish and antenna.
4. **Nacelles and plasma:** pylons, nacelles, Bussard caps and tail cones, followed by a re-proportioning pass that moved the ship's dimensions into layout constants. The animated plasma video went in at this stage.
5. **Planet and lighting:** the ship orbits a spinning sandstone-textured planet, with per-object materials, two colored lights and an atmosphere rim. The leftover boilerplate objects were then removed.
6. **Texture rework:** the ship's skin was replaced with procedural color maps and normal maps baked from one height field each. The saucer stayed on luminance bump mapping.
7. **Interaction:** a star field, a Break Orbit button that departs along the tangent at the moment of the press, and finally the Engage warp sequence with a chase camera, fisheye lens and flash.
8. **Polish:** the delayed Engage reveal, a slightly later jump to warp, click-to-center and wheel zoom, then a review pass on picking, zoom and input handling.

The commit history has the full sequence.

## Other effects

- **Orbit and departure** (`scene.js`): the ship rides a circle in a plane tilted 0.25 rad, and its heading is its orbit angle, so it always flies nose-first. Engage blends the circle into the tangent line at the moment of the press over 2.5 s, weighted by the quintic smootherstep. Its first and second derivatives vanish at both ends, so position, velocity and acceleration all match where the ship leaves the circle and where it joins the line. At 3.2 s the ship jumps straight to 10× orbital speed.
- **Lighting and atmosphere** (`main.js`): Phong shading from two point lights, a warm sun and a dim blue fill on the opposite side. The planet's atmosphere is a rim term, `pow(1 - N·V, 3)`, that brightens where the surface turns away from the viewer. It uses the smooth normal from before bump mapping, so the halo isn't speckled, and is masked to the sunlit side with a smoothstep of `N·L`.
- **Star field** (`stars.js`): 3000 point sprites on a sphere of radius 45, drawn in one call by their own shader program with depth writes off, so everything else paints over them. A seeded generator gives each star a brightness (cubed, for a few bright and many faint), a blue-to-orange color and its own twinkle phase.
- **Warp streaks** (`stars.js`): at warp the vertex shader projects each star where it will be 0.45 s later and takes the difference on screen. The sprite grows to hold that streak and the fragment shader draws a capsule inside it, so stars sweeping past the sides stretch most and those dead ahead barely stretch. The sky drifts along with the ship at 52.5% of warp's extra distance, so the stars stream past and the ship reaches their edge just as the scene resets.
- **Chase camera** (`camera.js`): on Engage the camera swings over 3 s from the free view to a point 2.2 units behind and 0.7 above the ship. The blend slerps the rotation as a quaternion and slides the eye along an arc about the planet rather than a straight line, which could cut through it. Dragging still swings the camera around the ship.
- **Fisheye lens and dolly zoom** (`camera.js`): both shaders project through one shared GLSL `project()`, which blends the usual perspective into an equisolid fisheye, `r = sin(θ/2) / sin(θmax/2)`, with a 125° half-width and a 1.8× vertical stretch that draws the ship out nose to tail. The fisheye carries distance in `w` instead of `-z`, so the depth test still works past 90° off axis. As the lens opens over 0.55 s the camera pulls in from 2.2 to 0.95 units behind the ship, so the ship holds its size while the scene balloons out around it.
- **Flash and fades** (`main.js`, `index.html`): two full-screen layers over the canvas. A white-blue radial gradient in `screen` blend mode rises over 0.05 s at the jump to warp and decays exponentially. A black layer fades out over 0.45 s before the reset and back in over 0.7 s after it, hiding the scene snapping back to how it loaded.
- **Engage reveal** (`main.js`, `index.html`): the button stays hidden until 10 s have passed, the page has been clicked 3 times, or the left button has been held for 1.5 s in total. It then fades in over 3 s and rises over 3.6 s. The rise uses CSS `translate`, separate from `transform`, so the press and bow-out animations keep their quick timing. A reset hides it again.
- **Click to center** (`camera.js`): a click casts a ray through the clicked pixel and tests it against the planet's sphere and against a box around the ship, in the ship's own frame, that holds every vertex. The nearer hit wins, so a ship hidden behind the planet isn't picked through it. The view then slides onto that object over 1.2 s and follows the ship around its orbit.
- **Zoom** (`camera.js`): each wheel notch scales the distance by about 13%, and each `w` / `s` press by about 1.5%, eased in log space so near and far zooms feel the same. The distance stays between 5.6 and 30 from the planet (outside the ship's whole orbit) and between 1.2 and 30 from the ship (outside its hitbox). Following the ship, the eye is pushed out to 0.25 above the planet's surface whenever the orbit would carry it inside.
