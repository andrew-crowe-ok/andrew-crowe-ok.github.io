// Benchmark harness for flight/ ray tracer
// Measures CPU and GPU timings across deterministic frames and calculates
// an image checksum to guard against regressions during optimization.

(function () {
  const params = new URLSearchParams(location.search);

  function createOverlay() {
    let overlay = document.getElementById("benchOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "benchOverlay";
      overlay.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong style="color:rgb(var(--glow)); letter-spacing:0.1em; text-transform:uppercase;">Benchmark Mode</strong>
          <span id="benchStatus" style="font-size:11px; opacity:0.8;">Initializing...</span>
        </div>
        <pre id="benchOut" style="margin:0; font-family:ui-monospace, monospace; font-size:12px; line-height:1.45;"></pre>
      `;
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  function hashPixels(pixels) {
    let h = 0x811c9dc5;
    for (let i = 0; i < pixels.length; i += 4) {
      h ^= pixels[i];
      h = Math.imul(h, 0x01000193);
      h ^= pixels[i + 1];
      h = Math.imul(h, 0x01000193);
      h ^= pixels[i + 2];
      h = Math.imul(h, 0x01000193);
      h ^= pixels[i + 3];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  async function runBenchmark(opts = {}) {
    createOverlay();
    const statusEl = document.getElementById("benchStatus");
    const outEl = document.getElementById("benchOut");

    const frames = opts.frames ?? Number(params.get("frames") || 30);
    const warmup = opts.warmup ?? Number(params.get("warmup") || 5);
    const dt = 1 / 60;

    if (statusEl) statusEl.textContent = "Loading assets...";

    // Wait for all image/media assets to decode
    if (window.assetsReady && window.assetsReady.length > 0) {
      await Promise.all(window.assetsReady);
    }

    // Allow a couple ticks for DOM / WebGL initialization to settle
    await new Promise(r => setTimeout(r, 100));

    if (statusEl) statusEl.textContent = `Warming up (${warmup} frames)...`;

    let simTime = 0;
    for (let i = 0; i < warmup; i++) {
      simTime += dt;
      await new Promise(r => requestAnimationFrame(r));
      const frame = window.stepFrame(simTime, dt);
      window.buildScene(frame, false);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
    }

    if (statusEl) statusEl.textContent = `Benchmarking (${frames} frames)...`;

    const stepTimes = [];
    const buildTimes = [];
    const drawTimes = [];
    const totalTimes = [];

    // Reset scene to a deterministic state for repeatable benchmark runs
    resetScene(0);
    simTime = 0;

    for (let i = 0; i < frames; i++) {
      simTime += dt;
      await new Promise(r => requestAnimationFrame(r));

      const t0 = performance.now();
      const frame = window.stepFrame(simTime, dt);
      const t1 = performance.now();

      window.buildScene(frame, false);
      const t2 = performance.now();

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      const t3 = performance.now();

      const stepMs = t1 - t0;
      const buildMs = t2 - t1;
      const drawMs = t3 - t2;
      const totalMs = t3 - t0;

      stepTimes.push(stepMs);
      buildTimes.push(buildMs);
      drawTimes.push(drawMs);
      totalTimes.push(totalMs);
    }

    // Readback framebuffer for checksum
    const w = canvas.width, h = canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const imgHash = hashPixels(pixels);

    // Compute stats
    const sum = arr => arr.reduce((a, b) => a + b, 0);
    const meanTotal = sum(totalTimes) / frames;
    const meanStep = sum(stepTimes) / frames;
    const meanBuild = sum(buildTimes) / frames;
    const meanDraw = sum(drawTimes) / frames;
    const minTotal = Math.min(...totalTimes);
    const maxTotal = Math.max(...totalTimes);
    const variance = totalTimes.reduce((acc, t) => acc + (t - meanTotal) ** 2, 0) / frames;
    const stdTotal = Math.sqrt(variance);
    const fps = 1000 / meanTotal;

    const results = {
      frames,
      warmup,
      viewport: `${w}x${h}`,
      renderScale: typeof renderScale !== "undefined" ? renderScale : 1,
      fps: +fps.toFixed(1),
      meanTotalMs: +meanTotal.toFixed(3),
      minTotalMs: +minTotal.toFixed(3),
      maxTotalMs: +maxTotal.toFixed(3),
      stdTotalMs: +stdTotal.toFixed(3),
      meanStepMs: +meanStep.toFixed(3),
      meanBuildMs: +meanBuild.toFixed(3),
      meanDrawMs: +meanDraw.toFixed(3),
      imageHash: imgHash
    };

    window.BENCH_RESULTS = results;
    window.__BENCH_DONE = true;
    document.body.classList.add("bench-done");

    if (statusEl) statusEl.textContent = "Done";

    const report = [
      "========================================",
      "       FLIGHT RAY TRACE BENCHMARK       ",
      "========================================",
      `Viewport:        ${results.viewport} (scale: ${results.renderScale.toFixed(2)})`,
      `Frames measured: ${results.frames} (warmup: ${results.warmup})`,
      `Frame Time:      ${results.meanTotalMs.toFixed(2)} ms (±${results.stdTotalMs.toFixed(2)} ms)`,
      `Range:           [${results.minTotalMs.toFixed(2)} ms .. ${results.maxTotalMs.toFixed(2)} ms]`,
      `Effective FPS:   ${results.fps.toFixed(1)} fps`,
      "Breakdown per frame (mean):",
      `  • Sim (stepFrame):  ${results.meanStepMs.toFixed(3)} ms`,
      `  • Build (scene/UBO): ${results.meanBuildMs.toFixed(3)} ms`,
      `  • GPU (draw/finish): ${results.meanDrawMs.toFixed(3)} ms`,
      `Framebuffer Hash:     ${results.imageHash}`,
      "========================================"
    ].join("\n");

    if (outEl) outEl.textContent = report;
    console.log(report);
    return results;
  }

  window.runBenchmark = runBenchmark;

  if (params.has("bench")) {
    window.addEventListener("DOMContentLoaded", () => runBenchmark());
    if (document.readyState === "complete" || document.readyState === "interactive") {
      runBenchmark();
    }
  }
})();
