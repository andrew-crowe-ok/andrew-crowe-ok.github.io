// Input + frame loop.

const KEYS = {      // key -> flipper index
  ArrowLeft: 0, KeyZ: 0, ShiftLeft: 0,
  ArrowRight: 1, Slash: 1, ShiftRight: 1,
};
const PLUNGER_KEYS = new Set(["Space", "ArrowDown"]);

function onKey(e, down) {
  if (e.repeat) return;
  if (e.code in KEYS) setFlipper(KEYS[e.code], down);
  else if (PLUNGER_KEYS.has(e.code)) setPlunger(down);
  else return;
  e.preventDefault();
}
window.addEventListener("keydown", e => onKey(e, true));
window.addEventListener("keyup", e => onKey(e, false));

const hud = document.getElementById("hud");
function updateHud() {
  const status = game.state === "over" ? "GAME OVER - press Space"
    : game.state === "ready" ? "Hold Space to launch" : "";
  hud.textContent = `Score ${game.score}   Balls ${game.balls}   ${status}`;
}

newGame();
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
