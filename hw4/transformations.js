// The perspective matrix is built as a product of three factors:
//
//     M_per = M_orth * P * F
//
//   M_orth: Normalization from box to cube [l,r][b,t][n,f] -> [-1,1]^3
//   P: Perspective warping, from frustum to box
//   F: z-axis flip.


// Warpping the frustum into the box [l,r][b,t][n,f]
//   [ n  0   0    0  ]
//   [ 0  n   0    0  ]
//   [ 0  0  f+n  -fn ]
//   [ 0  0   1    0  ]
function frustum2Box(near, far) {
    return new Float32Array([
        near, 0, 0, 0,
        0, near, 0, 0,
        0, 0, far + near, 1,
        0, 0, -far * near, 0
    ]);
}

// mapping box [l,r][b,t][n,f] onto the normalized cube [-1,1]^3.
//   [ 2/(r-l)    0        0      -(r+l)/(r-l) ]
//   [    0    2/(t-b)     0      -(t+b)/(t-b) ]
//   [    0       0     2/(f-n)   -(f+n)/(f-n) ]
//   [    0       0        0            1      ]
function box2Cube(left, right, bottom, top, near, far) {
    const rl = 1 / (right - left), tb = 1 / (top - bottom), fn = 1 / (far - near);
    return new Float32Array([
        2 * rl, 0, 0, 0,
        0, 2 * tb, 0, 0,
        0, 0, 2 * fn, 0,
        -(right + left) * rl, -(top + bottom) * tb, -(far + near) * fn, 1
    ]);
}

//Camera Looks down -z, near/far passed as positive distances into the
//+z-forward convention P and M_orth are written in
function flipZ() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
}


// Matrix multiplication
function multiplyMat4(a, b) {
    let r = new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
            sum += a[k * 4 + i] * b[j * 4 + k]; 
        }
        r[j * 4 + i] = sum;
    }
    return r;
}

// Multiply matrices left to right, e.g. matMul(A, B, C) is A * B * C.
// JavaScript has no operator overloading, GLSL does overload `*` for mat4
function matMul(...matrices) {
    return matrices.reduce(multiplyMat4);
}

// General perspective frustum
function frustum(left, right, bottom, top, near, far) {
    const M_orth = box2Cube(left, right, bottom, top, near, far);
    const P      = frustum2Box(near, far);
    const F      = flipZ();
    return matMul(M_orth, P, F);        // M_per = M_orth * Perspective Warping * FlipZ
}

// Symmetric frustum from vertical field of view. fov in radians.
function perspective(fov, aspect, near, far) {
    const top = near * Math.tan(fov / 2);
    const right = top * aspect;
    return frustum(-right, right, -top, top, near, far);
}

// Orthographic matrix
function ortho(left, right, bottom, top, near, far) {
    const lr = 1 / (left - right), bt = 1 / (bottom - top), nf = 1 / (near - far);
    return new Float32Array([
        -2*lr, 0, 0, 0,
        0, -2*bt, 0, 0,
        0, 0, 2*nf, 0,
        (left+right)*lr, (top+bottom)*bt, (far+near)*nf, 1
    ]);
}

// Identity matrix
function mat4Identity() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// Matrix translation
function mat4Translate(matrix, translation) {
    const result = new Float32Array(matrix);
    result[12] = matrix[0] * translation[0] + matrix[4] * translation[1] + matrix[8] * translation[2] + matrix[12];
    result[13] = matrix[1] * translation[0] + matrix[5] * translation[1] + matrix[9] * translation[2] + matrix[13];
    result[14] = matrix[2] * translation[0] + matrix[6] * translation[1] + matrix[10] * translation[2] + matrix[14];
    result[15] = matrix[3] * translation[0] + matrix[7] * translation[1] + matrix[11] * translation[2] + matrix[15];
    return result;
}

// Matrix rotation around X axis
function mat4RotateX(matrix, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const result = new Float32Array(matrix);

    const mv1 = matrix[4], mv5 = matrix[5], mv9 = matrix[6], mv13 = matrix[7];
    const mv2 = matrix[8], mv6 = matrix[9], mv10 = matrix[10], mv14 = matrix[11];

    result[4] = mv1 * c + mv2 * s;
    result[5] = mv5 * c + mv6 * s;
    result[6] = mv9 * c + mv10 * s;
    result[7] = mv13 * c + mv14 * s;
    result[8] = mv2 * c - mv1 * s;
    result[9] = mv6 * c - mv5 * s;
    result[10] = mv10 * c - mv9 * s;
    result[11] = mv14 * c - mv13 * s;

    return result;
}

// Matrix rotation around Y axis
function mat4RotateY(matrix, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const result = new Float32Array(matrix);

    const mv0 = matrix[0], mv4 = matrix[1], mv8 = matrix[2], mv12 = matrix[3];
    const mv2 = matrix[8], mv6 = matrix[9], mv10 = matrix[10], mv14 = matrix[11];

    result[0] = mv0 * c - mv2 * s;
    result[1] = mv4 * c - mv6 * s;
    result[2] = mv8 * c - mv10 * s;
    result[3] = mv12 * c - mv14 * s;
    result[8] = mv0 * s + mv2 * c;
    result[9] = mv4 * s + mv6 * c;
    result[10] = mv8 * s + mv10 * c;
    result[11] = mv12 * s + mv14 * c;

    return result;
}

// Matrix scaling
function mat4Scale(matrix, scale) {
    const result = new Float32Array(matrix);
    result[0]  = matrix[0]  * scale[0];
    result[1]  = matrix[1]  * scale[0];
    result[2]  = matrix[2]  * scale[0];
    result[3]  = matrix[3]  * scale[0];
    
    result[4]  = matrix[4]  * scale[1];
    result[5]  = matrix[5]  * scale[1];
    result[6]  = matrix[6]  * scale[1];
    result[7]  = matrix[7]  * scale[1];
    
    result[8]  = matrix[8]  * scale[2];
    result[9]  = matrix[9]  * scale[2];
    result[10] = matrix[10] * scale[2];
    result[11] = matrix[11] * scale[2];
    
    return result;
}

// [optional] Helper function converting math format row-major matrices into a flat column-major array.
// function mat4FromRows(m00, m01, m02, m03,
//                       m10, m11, m12, m13,
//                       m20, m21, m22, m23,
//                       m30, m31, m32, m33) {
//     return new Float32Array([
//         m00, m10, m20, m30,   // column 0
//         m01, m11, m21, m31,   // column 1
//         m02, m12, m22, m32,   // column 2
//         m03, m13, m23, m33    // column 3
//     ]);
// }
