# HW6: Texture Mapping

A WebGL2 scene of a starship orbiting a planet, with an **Engage** button that sends the ship to warp.
Live: https://andrew-crowe-ok.github.io/hw6/

## Primitives

| Primitive | Used for | Mapping |
|---|---|---|
| Sphere | Planet; saucer disc; dome; Bussard collector | bump (planet, saucer), normal (dome), animated (collector) |
| Torus | Saucer rim | bump |
| Cone | Deflector dish and antenna (`mars2.jpg`); nacelle caps | bump (deflector), normal (nacelle) |
| Cylinder | Engineering hull and nacelles | normal |
| Cube | Neck and pylons | normal |

Curved primitives (sphere, torus, cone) are in `models.js` with per-vertex normals, tangents and UVs.

## Texture mapping

- **Bump mapping**: the shader tilts the normal using the gradient of the texture's luminance. The planet (antelope photo) and the saucer (procedural panel lines) use it.
- **Normal mapping**: the dome, hull and nacelles have a color map plus a tangent-space normal map baked from the same height field (`normalMap()` in `textures.js`), so paint and relief always match.
- **Animated texture**: the Bussard collectors are lit by a looping plasma video (`textures/plasma.webm` / `.mp4`). The current frame is re-uploaded to the GPU each render (`loadVideoTexture` in `main.js`). The swirl is periodic in u, so it wraps around the sphere without a seam, and loops cleanly in time.

## Functional approach

The code uses plain functions and data, with no classes.

- **Hierarchy by composition**: each part is a `drawX(parent)` function that takes its parent's transform matrix, multiplies in its own local transform, and passes the result to its children (`ship.js`, `scene.js`). The ship, saucer, dome, hull, pylons and nacelles all nest this way, and the planet and orbit are siblings so the planet's spin never reaches the ship.
- **Pure helpers**: `multiply`, `translate`, `rotateY` and the other transform functions return new matrices, and `normalMap()` turns a height field into a normal map without side effects.
- **Textures as data**: each generator in `textures.js` returns `{ color, height, size }`, which is uploaded to the GPU in one place (`main.js`).
- **One draw call**: every object goes through `drawPrimitive(mesh, texture, mapping, modelView, material, normalMap)`, so the mapping mode (bump, normal, emissive) is an argument rather than a different code path.

## Other effects

Orbiting ship, atmosphere glow on the planet's limb, star field, chase camera, fisheye lens and a white-blue flash on warp.

## AI assistance

This was an iterative project built with Claude Code. The design evolved over many rounds of prompting and revision. Claude wrote and revised much of the code, including the geometry, shaders, camera and warp sequence.

### How it was built

The scene was built in small steps, roughly one commit per feature.

1. **Starting point:** the HW5 boilerplate (cube, cylinder, sphere, pyramid, Newton's cradle) with the shader editors removed so the canvas fills the window.
2. **Saucer first:** a flattened sphere as the root of a transform hierarchy, then a normal-mapped dome as its child.
3. **One primitive per step:** the torus rim, then the engineering hull with a sphere nose and tilted neck, then the cone deflector dish and antenna.
4. **Nacelles and plasma:** pylons, nacelles, Bussard caps and tail cones, followed by a re-proportioning pass that moved the ship's dimensions into layout constants. The animated plasma video went in at this stage.
5. **Planet and lighting:** the ship orbits a spinning sandstone-textured planet, with per-object materials, two colored lights and an atmosphere rim. The leftover boilerplate objects were then removed.
6. **Texture rework:** the ship's skin was replaced with procedural color maps and normal maps baked from one height field each. The saucer stayed on luminance bump mapping.
7. **Interaction:** a star field, a Break Orbit button that departs along the tangent at the moment of the press, and finally the Engage warp sequence with a chase camera, fisheye lens and flash.

The commit history has the full sequence.

### AI-generated assets
- **Ship textures** (saucer panel lines, hull, dome, nacelle plating, and their normal maps): generated procedurally at load time by code Claude wrote (`textures.js`). There are no image files for them.
- **Plasma video**: rendered by a Python script Claude wrote (`tools/make_plasma.py`).
