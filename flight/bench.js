// Benchmark harness for flight/ ray tracer
// Measures CPU and GPU timings across deterministic frames and calculates
// an image checksum to guard against regressions during optimization.

(function () {
  const params = new URLSearchParams(location.search);

  let benchRunning = false;

  function createOverlay() {
    let overlay = document.getElementById("benchOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "benchOverlay";
      overlay.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong style="color:rgb(var(--glow)); letter-spacing:0.1em; text-transform:uppercase;">Benchmark Mode</strong>
          <div style="display:flex; align-items:center; gap:8px;">
            <span id="benchStatus" style="font-size:11px; opacity:0.8;">Initializing...</span>
            <button id="benchClose" style="background:none; border:none; color:var(--ink); font-size:18px; cursor:pointer; line-height:1; padding:0 4px;" title="Close overlay">×</button>
          </div>
        </div>
        <pre id="benchOut" style="margin:0; font-family:ui-monospace, monospace; font-size:12px; line-height:1.45;"></pre>
      `;
      overlay.querySelector("#benchClose").addEventListener("click", () => overlay.remove());
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
    if (benchRunning) return;
    benchRunning = true;
    window.benchRunning = true;

    try {
      createOverlay();
      const statusEl = document.getElementById("benchStatus");
      const outEl = document.getElementById("benchOut");

      const frames = opts.frames ?? Number(params.get("frames") || 30);
      const warmup = opts.warmup ?? Number(params.get("warmup") || 5);
      const dt = 1 / 60;

      if (opts.resolution !== undefined && typeof window.setResolution === "function") {
        window.setResolution(Number(opts.resolution));
      } else if (params.has("resolution") && typeof window.setResolution === "function") {
        window.setResolution(Number(params.get("resolution")));
      }

      if (statusEl) statusEl.textContent = "Loading assets...";

      // Wait for all image/media assets to decode
      if (window.assetsReady && window.assetsReady.length > 0) {
        try {
          await Promise.all(window.assetsReady);
        } catch (err) {
          console.warn("Asset load warning in benchmark:", err);
        }
      }

      // Allow a couple ticks for DOM / WebGL initialization to settle
      await new Promise(r => setTimeout(r, 100));

      if (statusEl) statusEl.textContent = `Warming up (${warmup} frames)...`;

      const syncPixel = new Uint8Array(4);
      const cx = Math.floor(canvas.width / 2);
      const cy = Math.floor(canvas.height / 2);

      let simTime = 0;
      for (let i = 0; i < warmup; i++) {
        simTime += dt;
        await new Promise(r => requestAnimationFrame(r));
        const frame = window.stepFrame(simTime, dt);
        window.buildScene(frame, false);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
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
        // In WebGL, gl.finish() does not block CPU on fragment rasterization across IPC.
        // Synchronously reading back a center pixel forces the GPU pipeline to complete rendering.
        gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
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

      // Readback full framebuffer for checksum
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
        `  • GPU (draw/sync):   ${results.meanDrawMs.toFixed(3)} ms`,
        `Framebuffer Hash:     ${results.imageHash}`,
        "========================================"
      ].join("\n");

      if (outEl) outEl.textContent = report;
      console.log(report);
      return results;
    } finally {
      benchRunning = false;
      window.benchRunning = false;
      if (!params.has("bench") && typeof window.render === "function") {
        requestAnimationFrame(window.render);
      }
    }
  }

  window.runBenchmark = runBenchmark;

  if (params.has("bench")) {
    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", () => runBenchmark(), { once: true });
    } else {
      runBenchmark();
    }
  }
})();
