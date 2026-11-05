// Hierarchical Newton's cradle carried over from HW 5.
//
// Nothing here runs on load: call createNewtonsCradle(...) with meshes built by
// main.js to get a scene graph, then walk it with drawSceneTree(). The nodes
// keep the HW 5 color/material fields, which the HW 6 shader currently ignores
// but a draw callback is free to read.

const CRADLE_IDENTITY = translate(0, 0, 0);

function createSceneNode(mesh, color, shape, material = {}, texture = null) {
  return {
    mesh,
    color,
    shape,
    ambient: material.ambient ?? 0.25,
    diffuse: material.diffuse ?? 0.70,
    specular: material.specular ?? 0.0,
    shininess: material.shininess ?? 32.0,
    flatShading: material.flatShading ?? 0.0,
    texture,
    joint: CRADLE_IDENTITY,
    children: []
  };
}

// drawNode(node, frame) receives the node and its accumulated model-view frame;
// node.shape still has to be applied: multiply(frame, node.shape).
function drawSceneTree(root, rootFrame, drawNode) {
  const stack = [[root, rootFrame]];
  while (stack.length > 0) {
    const [node, parentFrame] = stack.pop();
    const frame = multiply(parentFrame, node.joint);
    drawNode(node, frame);
    for (const child of node.children) stack.push([child, frame]);
  }
}

function createNewtonsCradle({
  cubeMesh,
  cylinderMesh,
  sphereMesh,
  pyramidMesh,
  pyramidTexture = null,
  ballTexture = null
} = {}) {
  // Level 1: lower arm (cylinder), diffuse/ambient only, smooth shaded
  const lowerArm = createSceneNode(
    cylinderMesh,
    [0.95, 0.35, 0.35],
    multiply(translate(0, 0.6, 0), scale(0.3, 0.6, 0.3)),
    { ambient: 0.25, diffuse: 0.85, specular: 0.0, shininess: 1.0, flatShading: 0.0 }
  );

  // Level 2: upper arm (cube), flat shaded
  const upperArm = createSceneNode(
    cubeMesh,
    [0.2, 0.5, 1.0],
    multiply(translate(0, 0.5, 0), scale(0.2, 0.5, 0.2)),
    { ambient: 0.25, diffuse: 0.65, specular: 1.0, shininess: 64.0, flatShading: 1.0 }
  );
  lowerArm.children.push(upperArm);

  // Level 3: mounting pyramid, textured
  const frameX = 2.1, frameZ = 0.75;
  const topY = 1.0, botY = -1.35;
  const barThick = 0.07;
  const cradleScale = 0.35;
  const pyrHalfH = 0.35;
  const pyrHeight = pyrHalfH * 2.0;
  const pyrHalfX = cradleScale * (frameX + barThick);
  const pyrHalfZ = cradleScale * (frameZ + barThick);

  const pyramidNode = createSceneNode(
    pyramidMesh,
    [1.0, 0.85, 0.40],
    multiply(translate(0, pyrHalfH, 0), scale(pyrHalfX, pyrHalfH, pyrHalfZ)),
    { ambient: 0.55, diffuse: 1.15, specular: 1.0, shininess: 32.0, flatShading: 1.0 },
    pyramidTexture
  );
  upperArm.children.push(pyramidNode);

  // Level 4: cradle frame, black and shiny
  const frameColor = [0.02, 0.02, 0.02];
  const frameMaterial = {
    ambient: 0.15, diffuse: 0.10, specular: 1.4, shininess: 96.0, flatShading: 1.0
  };

  const frameRoot = createSceneNode(
    cubeMesh,
    frameColor,
    multiply(translate(0, botY, frameZ), scale(frameX + barThick, barThick, barThick)),
    frameMaterial
  );
  frameRoot.joint = multiply(
    translate(0, pyrHeight, 0),
    multiply(scale(cradleScale, cradleScale, cradleScale), translate(0, -(botY - barThick), 0))
  );
  pyramidNode.children.push(frameRoot);

  const addBar = (tx, ty, tz, sx, sy, sz) => frameRoot.children.push(
    createSceneNode(cubeMesh, frameColor, multiply(translate(tx, ty, tz), scale(sx, sy, sz)), frameMaterial)
  );

  addBar(0, botY, -frameZ, frameX + barThick, barThick, barThick);
  addBar(-frameX, botY, 0, barThick, barThick, frameZ);
  addBar( frameX, botY, 0, barThick, barThick, frameZ);

  const postHalfH = (topY - botY) / 2;
  const postMidY = (topY + botY) / 2;
  for (const x of [-frameX, frameX])
    for (const z of [-frameZ, frameZ])
      addBar(x, postMidY, z, barThick, postHalfH, barThick);

  addBar(0, topY,  frameZ, frameX + barThick, barThick, barThick);
  addBar(0, topY, -frameZ, frameX + barThick, barThick, barThick);
  addBar(-frameX, topY, 0, barThick, barThick, frameZ);
  addBar( frameX, topY, 0, barThick, barThick, frameZ);

  // Levels 5 & 6: wires (smooth, diffuse only) and textured balls (shiny)
  const wireColor = [0.70, 0.70, 0.75];
  const wireMaterial = { ambient: 0.3, diffuse: 0.7, specular: 0.0, shininess: 1.0, flatShading: 0.0 };
  const sphereRadius = 0.34;
  const dropY = 1.65;
  const wireHalfLen = Math.hypot(dropY, frameZ) / 2;
  const wireTilt = Math.atan2(frameZ, dropY);
  const wireRadius = 0.015;

  const pendulums = [];
  for (let i = 0; i < 5; i++) {
    const pivotX = (i - 2) * (sphereRadius * 2);

    // The pivot node is itself the front wire; the back wire mirrors it in z
    const pendulumPivot = createSceneNode(
      cylinderMesh,
      wireColor,
      multiply(
        translate(0, -dropY / 2, -frameZ / 2),
        multiply(rotateX(-wireTilt), scale(wireRadius, wireHalfLen, wireRadius))
      ),
      wireMaterial
    );
    const backWire = createSceneNode(
      cylinderMesh,
      wireColor,
      multiply(
        translate(0, -dropY / 2, frameZ / 2),
        multiply(rotateX(wireTilt), scale(wireRadius, wireHalfLen, wireRadius))
      ),
      wireMaterial
    );
    const ball = createSceneNode(
      sphereMesh,
      [0.88, 0.90, 0.95],
      multiply(translate(0, -dropY, 0), scale(sphereRadius, sphereRadius, sphereRadius)),
      { ambient: 0.20, diffuse: 0.60, specular: 1.8, shininess: 128.0, flatShading: 0.0 },
      ballTexture
    );

    pendulumPivot.children.push(backWire, ball);
    frameRoot.children.push(pendulumPivot);
    pendulums.push({ node: pendulumPivot, pivotX });
  }

  // Poses the joints for time t; only the end balls swing, as in HW 5.
  function update(t, animating = true, baseRotation = CRADLE_IDENTITY) {
    const lowerDynamic = animating ? 0.5 * Math.sin(t) : 0.0;
    const upperDynamic = animating ? Math.sin(1.5 * t) : 0.0;

    lowerArm.joint = multiply(multiply(translate(0, -2.0, 0), baseRotation), rotateZ(lowerDynamic));
    upperArm.joint = multiply(translate(0, 1.2, 0), rotateZ(upperDynamic));
    pyramidNode.joint = multiply(translate(0, 1.0, 0), rotateY(animating ? 2.5 * t : 0.0));

    const swing = animating ? 0.75 * Math.sin(3.0 * t) : 0.0;
    pendulums.forEach(({ node, pivotX }, i) => {
      let angle = 0;
      if (i === 0) angle = Math.min(0, swing);
      else if (i === 4) angle = Math.max(0, swing);
      node.joint = multiply(translate(pivotX, topY, 0), rotateZ(angle));
    });
  }

  update(0, false);
  return { root: lowerArm, lowerArm, upperArm, pyramidNode, frameRoot, pendulums, update };
}
