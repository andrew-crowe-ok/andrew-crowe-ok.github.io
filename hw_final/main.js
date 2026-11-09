// Input + frame loop.

const KEYS = {      // key -> flipper index
  ArrowLeft: 0, KeyZ: 0, ShiftLeft: 0,
  ArrowRight: 1, Slash: 1, ShiftRight: 1,
};
const PLUNGER_KEYS = new Set(["Space", "ArrowDown"]);

// Light up the on-screen key caps while held (Shift and ArrowDown share a cap)
const CAP_FOR = { ShiftLeft: "KeyZ", ShiftRight: "Slash", ArrowDown: "Space" };
function showKey(code, down) {
  const cap = document.querySelector(`kbd[data-code="${CAP_FOR[code] ?? code}"]`);
  if (cap) cap.classList.toggle("down", down);
}

function onKey(e, down) {
  if (e.repeat) return;
  showKey(e.code, down);
  if (e.code in KEYS) setFlipper(KEYS[e.code], down);
  else if (PLUNGER_KEYS.has(e.code)) setPlunger(down);
  else return;
  e.preventDefault();
}
window.addEventListener("keydown", e => onKey(e, true));
window.addEventListener("keyup", e => onKey(e, false));

// ---------- touch ----------

// Tell the renderer how much of the screen the HUD and control overlays cover
function measureInsets() {
  const visible = [...document.querySelectorAll("#hud, #controls, .pad, #touchLaunch")]
    .map(el => el.getBoundingClientRect()).filter(r => r.height > 0);
  const h = window.innerHeight;
  // Touch pads in landscape sit beside the table, so they don't need dodging
  const sidePads = document.body.classList.contains("touch") && window.innerWidth > h;
  screenInsets = {
    top: Math.max(0, ...visible.filter(r => r.top < h / 2).map(r => r.bottom)),
    bottom: sidePads ? 0 : Math.max(0, ...visible.filter(r => r.top >= h / 2).map(r => h - r.top)),
  };
}
window.addEventListener("resize", measureInsets);

// Show the touch or keyboard controls, whichever was used last
function setTouchMode(on) {
  document.body.classList.toggle("touch", on);
  measureInsets();
}
setTouchMode(matchMedia("(pointer: coarse)").matches);
window.addEventListener("pointerdown", e => { if (e.pointerType === "touch") setTouchMode(true); }, true);
window.addEventListener("keydown", () => setTouchMode(false));
window.addEventListener("contextmenu", e => e.preventDefault());

// Multi-touch hold: a control stays down while any finger is on it, and
// pointer capture keeps a finger bound to the control it started on
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

holdControl(document.getElementById("touchLeft"), down => {
  setFlipper(0, down);
  if (down) navigator.vibrate?.(8);
});
holdControl(document.getElementById("touchRight"), down => {
  setFlipper(1, down);
  if (down) navigator.vibrate?.(8);
});
holdControl(document.getElementById("touchLaunch"), setPlunger);

// ---------- HUD ----------

const hud = document.getElementById("hud");
function updateHud() {
  const touch = document.body.classList.contains("touch");
  const status = game.state === "over" ? (touch ? "GAME OVER - tap LAUNCH" : "GAME OVER - press Space")
    : game.state === "ready" ? (touch ? "Hold LAUNCH" : "Hold Space to launch") : "";
  hud.textContent = `Score ${game.score}   Balls ${game.balls}   ${status}`;
}

newGame();
updateHud();
measureInsets();   // the HUD has its height now
let last = performance.now();
function frame(now) {
  // Clamp so a background tab doesn't hand physics a huge step
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  stepPhysics(dt);
  render();
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
