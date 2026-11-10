// flight/audio.js
// Procedural Web Audio Engine for Flight Simulation
// Synthesizes sci-fi ship audio with zero external sound files or asset dependencies.

(function () {
  "use strict";

  const AudioContextClass = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;
  const isAudioSupported = !!AudioContextClass;

  const MASTER_VOLUME = 0.65;
  let isMuted = false;
  let isInitialized = false;

  let audioCtx = null;
  let masterGainNode = null;

  // Continuous persistent nodes (created once on init to guarantee 0 heap allocations per frame)
  let oscSub = null;
  let oscMid = null;
  let oscDetune = null;
  let engineFilter = null;
  let engineGain = null;

  let oscWarpCharge = null;
  let warpChargeFilter = null;
  let warpChargeGain = null;

  let oscDrone1 = null;
  let oscDrone2 = null;
  let droneFilter = null;
  let warpDroneGain = null;

  // Pre-allocated noise buffer for procedural whoosh / impacts
  let noiseBuffer = null;

  // State tracking for transitions
  let prevWarpState = "off";

  // Verifiable parameters (always computed, even in headless/unsupported environments)
  const AUDIO_PARAMS = {
    supported: isAudioSupported,
    initialized: false,
    muted: false,
    masterVolume: MASTER_VOLUME,
    drive: 0,
    engineFreq: 52,
    engineGain: 0.08,
    engineCutoff: 160,
    warpChargeFreq: 0,
    warpChargeGain: 0,
    warpDroneGain: 0,
    lastImpactSpeed: 0,
    lastImpactTime: 0
  };

  function createNoiseBuffer(ctx, seconds = 1.0) {
    const bufferSize = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  function initAudio() {
    if (isInitialized || !isAudioSupported) return isAudioSupported;
    try {
      audioCtx = new AudioContextClass();
      masterGainNode = audioCtx.createGain();
      masterGainNode.gain.setValueAtTime(isMuted ? 0 : MASTER_VOLUME, audioCtx.currentTime);
      masterGainNode.connect(audioCtx.destination);

      // 1. Continuous Impulse Engine (low sub-bass + warm triangle + detuned harmonic)
      oscSub = audioCtx.createOscillator();
      oscSub.type = "sine";
      oscSub.frequency.setValueAtTime(26, audioCtx.currentTime);

      oscMid = audioCtx.createOscillator();
      oscMid.type = "triangle";
      oscMid.frequency.setValueAtTime(52, audioCtx.currentTime);

      oscDetune = audioCtx.createOscillator();
      oscDetune.type = "sawtooth";
      oscDetune.frequency.setValueAtTime(78, audioCtx.currentTime);

      engineFilter = audioCtx.createBiquadFilter();
      engineFilter.type = "lowpass";
      engineFilter.frequency.setValueAtTime(160, audioCtx.currentTime);
      engineFilter.Q.setValueAtTime(2.0, audioCtx.currentTime);

      engineGain = audioCtx.createGain();
      engineGain.gain.setValueAtTime(0.08, audioCtx.currentTime);

      oscSub.connect(engineFilter);
      oscMid.connect(engineFilter);
      oscDetune.connect(engineFilter);
      engineFilter.connect(engineGain);
      engineGain.connect(masterGainNode);

      oscSub.start(0);
      oscMid.start(0);
      oscDetune.start(0);

      // 2. Continuous Warp Coil Charge Whine (sawtooth through resonant bandpass)
      oscWarpCharge = audioCtx.createOscillator();
      oscWarpCharge.type = "sawtooth";
      oscWarpCharge.frequency.setValueAtTime(220, audioCtx.currentTime);

      warpChargeFilter = audioCtx.createBiquadFilter();
      warpChargeFilter.type = "bandpass";
      warpChargeFilter.frequency.setValueAtTime(220, audioCtx.currentTime);
      warpChargeFilter.Q.setValueAtTime(4.5, audioCtx.currentTime);

      warpChargeGain = audioCtx.createGain();
      warpChargeGain.gain.setValueAtTime(0, audioCtx.currentTime);

      oscWarpCharge.connect(warpChargeFilter);
      warpChargeFilter.connect(warpChargeGain);
      warpChargeGain.connect(masterGainNode);
      oscWarpCharge.start(0);

      // 3. Continuous Subspace Drone (binaural low sine pair 43 Hz + 46 Hz -> 3 Hz pulsing beat)
      oscDrone1 = audioCtx.createOscillator();
      oscDrone1.type = "sine";
      oscDrone1.frequency.setValueAtTime(43, audioCtx.currentTime);

      oscDrone2 = audioCtx.createOscillator();
      oscDrone2.type = "sine";
      oscDrone2.frequency.setValueAtTime(46, audioCtx.currentTime);

      droneFilter = audioCtx.createBiquadFilter();
      droneFilter.type = "lowpass";
      droneFilter.frequency.setValueAtTime(95, audioCtx.currentTime);
      droneFilter.Q.setValueAtTime(1.5, audioCtx.currentTime);

      warpDroneGain = audioCtx.createGain();
      warpDroneGain.gain.setValueAtTime(0, audioCtx.currentTime);

      oscDrone1.connect(droneFilter);
      oscDrone2.connect(droneFilter);
      droneFilter.connect(warpDroneGain);
      warpDroneGain.connect(masterGainNode);

      oscDrone1.start(0);
      oscDrone2.start(0);

      // 4. Noise buffer for one-shot bursts (whoosh / impact)
      noiseBuffer = createNoiseBuffer(audioCtx, 1.2);

      isInitialized = true;
      AUDIO_PARAMS.initialized = true;
    } catch (err) {
      console.warn("AudioContext initialization bypassed:", err);
      return false;
    }
    return true;
  }

  function ensureAudioContext() {
    if (!isInitialized) {
      initAudio();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  }

  function setMuted(muted) {
    isMuted = !!muted;
    AUDIO_PARAMS.muted = isMuted;
    AUDIO_PARAMS.masterVolume = isMuted ? 0 : MASTER_VOLUME;
    if (masterGainNode && audioCtx) {
      masterGainNode.gain.setTargetAtTime(AUDIO_PARAMS.masterVolume, audioCtx.currentTime, 0.03);
    }
    syncAudioUI();
  }

  function isAudioMuted() {
    return isMuted;
  }

  function toggleMute() {
    ensureAudioContext();
    setMuted(!isMuted);
    return isMuted;
  }

  function syncAudioUI() {
    if (typeof document === "undefined") return;
    const btn = document.getElementById("audioButton");
    if (btn) {
      btn.setAttribute("aria-pressed", isMuted ? "false" : "true");
      btn.textContent = isMuted ? "Muted" : "Audio";
    }
    const chk = document.getElementById("audioToggle");
    if (chk) {
      chk.checked = !isMuted;
    }
  }

  // One-shot: Explosive Warp Jump Whoosh
  function triggerWarpJump() {
    if (!audioCtx || isMuted || audioCtx.state === "suspended") return;
    try {
      const now = audioCtx.currentTime;
      if (noiseBuffer) {
        const noiseSrc = audioCtx.createBufferSource();
        noiseSrc.buffer = noiseBuffer;

        const filter = audioCtx.createBiquadFilter();
        filter.type = "bandpass";
        filter.Q.setValueAtTime(2.2, now);
        filter.frequency.setValueAtTime(2200, now);
        filter.frequency.exponentialRampToValueAtTime(75, now + 0.85);

        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.7, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);

        noiseSrc.connect(filter);
        filter.connect(gain);
        gain.connect(masterGainNode);

        noiseSrc.start(now);
        noiseSrc.stop(now + 0.86);
      }

      // Sub-bass thump
      const sub = audioCtx.createOscillator();
      sub.type = "sine";
      sub.frequency.setValueAtTime(115, now);
      sub.frequency.exponentialRampToValueAtTime(32, now + 0.65);

      const subGain = audioCtx.createGain();
      subGain.gain.setValueAtTime(0.65, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

      sub.connect(subGain);
      subGain.connect(masterGainNode);
      sub.start(now);
      sub.stop(now + 0.66);
    } catch (e) {
      console.warn("Warp jump audio error:", e);
    }
  }

  // One-shot: Warp Dropout Deceleration Chirp
  function triggerWarpDropout() {
    if (!audioCtx || isMuted || audioCtx.state === "suspended") return;
    try {
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(940, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.38);

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.42, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

      osc.connect(gain);
      gain.connect(masterGainNode);
      osc.start(now);
      osc.stop(now + 0.39);
    } catch (e) {
      console.warn("Warp dropout audio error:", e);
    }
  }

  // One-shot: Resonant Shield Impact Deflection
  function triggerShieldImpact(speed, normal) {
    AUDIO_PARAMS.lastImpactSpeed = speed || 0;
    AUDIO_PARAMS.lastImpactTime = audioCtx ? audioCtx.currentTime : performance.now() * 0.001;
    if (!audioCtx || isMuted || audioCtx.state === "suspended") return;

    try {
      const now = audioCtx.currentTime;
      const maxImpulse = (typeof FLIGHT !== "undefined" && FLIGHT.impulse) ? FLIGHT.impulse : 3.0;
      const intensity = Math.min(1.0, Math.max(0.15, (speed || 1.0) / maxImpulse));

      // 1. Resonant harmonic ring (shield energy dissipation)
      const osc1 = audioCtx.createOscillator();
      osc1.type = "sine";
      const baseFreq = 180 + (1.0 - intensity) * 80;
      osc1.frequency.setValueAtTime(baseFreq, now);
      osc1.frequency.exponentialRampToValueAtTime(baseFreq * 0.5, now + 0.42);

      const osc2 = audioCtx.createOscillator();
      osc2.type = "triangle";
      osc2.frequency.setValueAtTime(baseFreq * 2.1, now);
      osc2.frequency.exponentialRampToValueAtTime(baseFreq * 0.9, now + 0.35);

      const ringFilter = audioCtx.createBiquadFilter();
      ringFilter.type = "bandpass";
      ringFilter.frequency.setValueAtTime(360, now);
      ringFilter.Q.setValueAtTime(5.5, now);

      const ringGain = audioCtx.createGain();
      ringGain.gain.setValueAtTime(0.55 * intensity, now);
      ringGain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);

      osc1.connect(ringFilter);
      osc2.connect(ringFilter);
      ringFilter.connect(ringGain);
      ringGain.connect(masterGainNode);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.43);
      osc2.stop(now + 0.43);

      // 2. Transient contact snap
      if (noiseBuffer) {
        const noise = audioCtx.createBufferSource();
        noise.buffer = noiseBuffer;
        const snapFilter = audioCtx.createBiquadFilter();
        snapFilter.type = "highpass";
        snapFilter.frequency.setValueAtTime(800, now);
        const snapGain = audioCtx.createGain();
        snapGain.gain.setValueAtTime(0.4 * intensity, now);
        snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

        noise.connect(snapFilter);
        snapFilter.connect(snapGain);
        snapGain.connect(masterGainNode);
        noise.start(now);
        noise.stop(now + 0.085);
      }
    } catch (e) {
      console.warn("Shield impact audio error:", e);
    }
  }

  // Once per frame: modulate engine hum, warp charge whine, and subspace drone with ZERO allocations
  function updateAudio(t, dt, ship) {
    if (typeof window !== "undefined" && window.benchRunning) return;
    if (!ship) return;

    const maxImpulse = (typeof FLIGHT !== "undefined" && FLIGHT.impulse) ? FLIGHT.impulse : 3.0;
    const warpChargeDuration = (typeof FLIGHT !== "undefined" && FLIGHT.warpCharge) ? FLIGHT.warpCharge : 1.2;

    const speed = ship.speed || 0;
    const throttle = ship.throttle || 0;
    const isFlown = typeof offOrbit === "function" ? offOrbit() : !!ship.helm;

    // Combined drive metric [0, 1]
    const speedRatio = Math.min(1.0, speed / maxImpulse);
    const drive = Math.max(throttle, speedRatio);
    AUDIO_PARAMS.drive = drive;

    // Engine hum modulation
    const engineFreq = 52 + drive * 88;
    const engineCutoff = 160 + drive * 520;
    const engineTargetGain = isFlown ? (0.15 + drive * 0.55) : 0.08;

    AUDIO_PARAMS.engineFreq = engineFreq;
    AUDIO_PARAMS.engineCutoff = engineCutoff;
    AUDIO_PARAMS.engineGain = engineTargetGain;

    // Warp state transitions
    const warpState = ship.warp ? ship.warp.state : "off";
    const warpTau = (ship.warp && ship.warp.tau) || 0;

    // Transition detection
    if (prevWarpState === "charge" && warpState === "on") {
      triggerWarpJump();
      if (typeof window !== "undefined" && typeof window.addCameraShake === "function") {
        window.addCameraShake(0.65);
      }
    } else if ((prevWarpState === "on" || prevWarpState === "charge") && warpState === "off") {
      triggerWarpDropout();
    }
    prevWarpState = warpState;

    // Warp charge whine parameter calculation
    let warpChargeFreq = 0;
    let warpChargeGainVal = 0;
    if (warpState === "charge") {
      const p = Math.min(1.0, warpTau / warpChargeDuration);
      warpChargeFreq = 220 + Math.pow(p, 2.4) * 1180;
      warpChargeGainVal = 0.45 * Math.sin(p * Math.PI * 0.5) * (0.85 + 0.15 * Math.sin(warpTau * 38));
    }
    AUDIO_PARAMS.warpChargeFreq = warpChargeFreq;
    AUDIO_PARAMS.warpChargeGain = warpChargeGainVal;

    // Warp subspace drone parameter calculation
    let warpDroneGainVal = 0;
    if (warpState === "on") {
      warpDroneGainVal = 0.48 * Math.min(1.0, ship.warpLevel || 0);
    }
    AUDIO_PARAMS.warpDroneGain = warpDroneGainVal;

    // Apply to Web Audio nodes if active and running
    if (audioCtx && isInitialized && !isMuted && audioCtx.state === "running") {
      const time = audioCtx.currentTime;
      const tc = 0.04;

      oscSub.frequency.setTargetAtTime(engineFreq * 0.5, time, tc);
      oscMid.frequency.setTargetAtTime(engineFreq, time, tc);
      oscDetune.frequency.setTargetAtTime(engineFreq * 1.503, time, tc);
      engineFilter.frequency.setTargetAtTime(engineCutoff, time, tc);
      engineGain.gain.setTargetAtTime(engineTargetGain, time, tc);

      if (warpState === "charge") {
        oscWarpCharge.frequency.setTargetAtTime(warpChargeFreq, time, tc);
        warpChargeFilter.frequency.setTargetAtTime(warpChargeFreq, time, tc);
        warpChargeGain.gain.setTargetAtTime(warpChargeGainVal, time, tc);
      } else {
        warpChargeGain.gain.setTargetAtTime(0, time, tc);
      }

      warpDroneGain.gain.setTargetAtTime(warpDroneGainVal, time, 0.05);
    }
  }

  // Safe user-gesture hooks for autoplay policy
  if (typeof window !== "undefined") {
    const handleGesture = () => ensureAudioContext();
    window.addEventListener("pointerdown", handleGesture, { passive: true, once: true });
    window.addEventListener("touchstart", handleGesture, { passive: true, once: true });
    window.addEventListener("keydown", handleGesture, { passive: true, once: true });
  }

  const audioEngine = {
    isSupported: () => isAudioSupported,
    isInitialized: () => isInitialized,
    isMuted: isAudioMuted,
    setMuted: setMuted,
    toggleMute: toggleMute,
    ensureAudioContext: ensureAudioContext,
    init: initAudio,
    update: updateAudio,
    triggerWarpJump: triggerWarpJump,
    triggerWarpDropout: triggerWarpDropout,
    triggerShieldImpact: triggerShieldImpact,
    getParams: () => AUDIO_PARAMS,
    syncUI: syncAudioUI
  };

  if (typeof window !== "undefined") {
    window.audioEngine = audioEngine;
  }
})();
