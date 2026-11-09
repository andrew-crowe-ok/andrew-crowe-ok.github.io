// Input (keyboard and touch), the HUD, and the frame loop that ties
// physics.js and render.js together.

// ---------- keyboard ----------

const FLIPPER_KEYS = {      // key code -> flipper index (0 left, 1 right)
  ArrowLeft: 0, KeyZ: 0, ShiftLeft: 0,
  ArrowRight: 1, Slash: 1, ShiftRight: 1,
};
const PLUNGER_KEYS = new Set(["Space", "ArrowDown"]);

// Keys without their own on-screen cap light up the cap for the same action
const CAP_FOR = { ShiftLeft: "KeyZ", ShiftRight: "Slash", ArrowDown: "Space" };
function showKey(code, down) {
  const cap = document.querySelector(`kbd[data-code="${CAP_FOR[code] ?? code}"]`);
  if (cap) cap.classList.toggle("down", down);
}

function onKey(e, down) {
  if (down) setTouchMode(false);
  if (e.repeat) return;
  showKey(e.code, down);
  if (e.code in FLIPPER_KEYS) setFlipper(FLIPPER_KEYS[e.code], down);
  else if (PLUNGER_KEYS.has(e.code)) setPlunger(down);
  else return;
  e.preventDefault();   // stop Space and the arrows from scrolling the page
}
window.addEventListener("keydown", e => onKey(e, true));
window.addEventListener("keyup", e => onKey(e, false));

// ---------- touch ----------

// A control that is held while any finger is on it. Pointer capture keeps
// each finger tied to the control it first touched, even if it slides off.
function holdControl(el, onChange) {
  const fingers = new Set();
  el.addEventListener("pointerdown", e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    if (fingers.size === 0) { onChange(true); el.classList.add("down"); }
    fingers.add(e.pointerId);
  });
  const release = e => {
    if (!fingers.delete(e.pointerId) || fingers.size > 0) return;
    onChange(false);
    el.classList.remove("down");
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
}

const flipperControl = i => down => {
  setFlipper(i, down);
  if (down) navigator.vibrate?.(8);   // short buzz where supported (Android)
};
holdControl(document.getElementById("touchLeft"), flipperControl(0));
holdControl(document.getElementById("touchRight"), flipperControl(1));
holdControl(document.getElementById("touchLaunch"), setPlunger);

window.addEventListener("pointerdown", e => { if (e.pointerType === "touch") setTouchMode(true); }, true);
window.addEventListener("contextmenu", e => e.preventDefault());   // long-press menu

// ---------- overlay layout ----------

// CSS px at the top and bottom of the screen covered by the HUD and controls;
// the renderer frames the table in the space between them
let screenInsets = { top: 0, bottom: 0 };

function measureInsets() {
  const rects = [...document.querySelectorAll("#hud, #controls, .pad, #touchLaunch")]
    .map(el => el.getBoundingClientRect()).filter(r => r.height > 0);   // skip hidden ones
  const h = window.innerHeight;
  // In landscape the touch pads sit beside the table, so they don't need room
  const padsBeside = document.body.classList.contains("touch") && window.innerWidth > h;
  screenInsets = {
    top: Math.max(0, ...rects.filter(r => r.top < h / 2).map(r => r.bottom)),
    bottom: padsBeside ? 0 : Math.max(0, ...rects.filter(r => r.top >= h / 2).map(r => h - r.top)),
  };
}
window.addEventListener("resize", measureInsets);

// Show the touch or keyboard controls, whichever was used last
function setTouchMode(on) {
  if (document.body.classList.contains("touch") === on) return;
  document.body.classList.toggle("touch", on);
  measureInsets();
}

// ---------- HUD ----------

const hud = document.getElementById("hud");
function updateHud() {
  const touch = document.body.classList.contains("touch");
  const status = game.state === "over" ? (touch ? "GAME OVER - tap LAUNCH" : "GAME OVER - press Space")
    : game.state === "ready" ? (touch ? "Hold LAUNCH" : "Hold Space to launch") : "";
  hud.textContent = `Score ${game.score}   Balls ${game.balls}   ${status}`;
}

// ---------- start ----------

document.body.classList.toggle("touch", matchMedia("(pointer: coarse)").matches);
newGame();
updateHud();
measureInsets();   // after the HUD has text, so it has a height

let last = performance.now();
function frame(now) {
  // Cap the step so returning from a background tab doesn't jump the ball
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  stepPhysics(dt);
  render(screenInsets);
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
