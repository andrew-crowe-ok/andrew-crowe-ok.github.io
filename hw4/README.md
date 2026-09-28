# CS 412: Homework 4 – Hierarchical Modeling

## Overview

In this assignment, you will build hierarchical models with the 3D primitives you have learned. Hierarchical modeling allows you to construct complex articulated systems where child components inherit transformations (rotations, translations, and scaling) from their parent components in a kinematic chain.

---

## Requirements & Grading Breakdown (Total: 6 pts + 1 bonus pt)

### 1. Hierarchical Structures (2 pts)
- **Four-Level Hierarchy (2 pts):**
  - Create a hierarchical model with **at least four levels** (including the base/root segment).
  - *Example structure:* Base (Root) $\rightarrow$ Lower Arm $\rightarrow$ Upper Arm $\rightarrow$ Hand / End-Effector.
  - Transforming a parent segment must properly cascade down to all descendant segments.

### 2. Model Movements (4 pts)
- **Chained Movements across Multiple Levels (2 pts):**
  - **At least three levels** in your hierarchy must have movements (e.g., joint rotation or translation).
- **Interactive UI Controls (2 pts):**
  - Implement **at least two UI elements** (such as sliders, buttons, or input dials) that control the chained movements interactively in real time.

> **Class Demo Reference:**  
> You can reproduce a robotic arm like the class demonstration:  
> `Base` $\rightarrow$ `Lower Arm` $\rightarrow$ `Upper Arm` $\rightarrow$ `Hand`

### 3. Creativity & Bonus (+1 pt)
- **Outstanding Effects & Creativity (+1 pt):**
  - Exceptional visual polish, creative model design (e.g., articulated characters, multi-finger grippers, mechanical creatures), or unique interactive effects will earn up to **+1 bonus point**.

---

## Submission Instructions

You may submit via **one** of the following methods:

1. **Option A: File Upload (Zip Archive)**
   - Zip the entire folder containing all required source files, HTML, CSS, and JavaScript.
   - Include your name as part of the folder name (e.g., `hw4_firstname_lastname.zip`).
   - Upload the zipped file to the assignment submission portal.

2. **Option B: GitHub Webpage URL**
   - Submit the direct URL to your hosted GitHub Pages website (or repository).
   - ⚠️ **Important:** Do **not** edit or push commits to your online repository after the deadline. The timestamp of the last edit will be considered your final submission time.

---

## Checklist
- [ ] Hierarchical model with $\ge 4$ levels (including root)
- [ ] Movements implemented on $\ge 3$ levels
- [ ] At least 2 interactive UI controls for chained movements
- [ ] Creative touches / outstanding effects considered for bonus credit
- [ ] Tested on modern web browsers
- [ ] Ready for submission (Zip package or GitHub Pages URL)
