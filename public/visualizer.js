(function () {
  "use strict";

  if (typeof THREE === "undefined") return;

  /* ===== Tunables (mutable at runtime) ===== */
  const cfg = {
    bands: 24,
    histW: 250,
    fftSize: 2048,
    freqLo: 30,
    freqHi: 18000,
    nmRed: 780,
    nmViolet: 380,

    orbitSpeed: 0.15,
    orbitRadius: 20,
    orbitHeight: 5,
    chartSize: 16,
    peakHeight: 2.0,
    fov: 50,

    smoothPasses: 12,
    fftSmooth: 0.95,
    decay: 0.10,
    avgRate: 0.003,
    peakDecay: 0.0005,
    floorFactor: 0.99,

    lineOpacity: 1.0,
    fillOpacity: 0.10,

    minDb: -80,
    maxDb: 0,
  };

  /* Catmull-Rom interpolation */
  function catmullRom(src, outLen) {
    const out = new Float32Array(outLen);
    const n = src.length;
    for (let i = 0; i < outLen; i++) {
      const t = (i / (outLen - 1)) * (n - 1);
      const idx = Math.floor(t);
      const frac = t - idx;
      const p0 = src[Math.max(0, idx - 1)];
      const p1 = src[idx];
      const p2 = src[Math.min(n - 1, idx + 1)];
      const p3 = src[Math.min(n - 1, idx + 2)];
      const t2 = frac * frac;
      const t3 = t2 * frac;
      out[i] = 0.5 * (
        (2 * p1) +
        (-p0 + p2) * frac +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
      );
    }
    return out;
  }

  /* Hz → nm → RGB */
  function hzToNm(hz) {
    const t = Math.log(hz / cfg.freqLo) / Math.log(cfg.freqHi / cfg.freqLo);
    return cfg.nmRed - t * (cfg.nmRed - cfg.nmViolet);
  }

  function nmToRGB(nm) {
    let r, g, b;
    if      (nm < 380) { r = 0; g = 0; b = 0; }
    else if (nm < 440) { r = -(nm - 440) / 60; g = 0; b = 1; }
    else if (nm < 490) { r = 0; g = (nm - 440) / 50; b = 1; }
    else if (nm < 510) { r = 0; g = 1; b = -(nm - 510) / 20; }
    else if (nm < 580) { r = (nm - 510) / 70; g = 1; b = 0; }
    else if (nm < 645) { r = 1; g = -(nm - 645) / 65; b = 0; }
    else if (nm <= 780){ r = 1; g = 0; b = 0; }
    else               { r = 0; g = 0; b = 0; }
    let f;
    if      (nm >= 380 && nm < 420) f = 0.3 + 0.7 * (nm - 380) / 40;
    else if (nm <= 700)             f = 1.0;
    else if (nm <= 780)             f = 0.3 + 0.7 * (780 - nm) / 80;
    else                            f = 0;
    return [r * f, g * f, b * f];
  }

  function hzToRGB(hz) { return nmToRGB(hzToNm(hz)); }

  /* ===== Visualizer ===== */

  class Visualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      this.renderer.setClearColor(0x0a0a0a, 1);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      this.aspect = 1;
      this.camera = new THREE.PerspectiveCamera(cfg.fov, 1, 0.1, 200);
      this.scene = new THREE.Scene();

      this.audioCtx = null;
      this.analyser = null;
      this.rawData = null;
      this.sampleRate = 44100;
      this.binCount = cfg.fftSize / 2;
      this.smoothed = new Float32Array(this.binCount);
      this.connected = false;
      this.isPlaying = false;

      this.bandAvg = new Float32Array(cfg.bands).fill(0.15);
      this.bandPeak = new Float32Array(cfg.bands).fill(0.3);
      this.bandDisplay = new Float32Array(cfg.bands);
      this.bandBinMap = [];

      this.history = [];
      for (let b = 0; b < cfg.bands; b++) {
        this.history.push(new Float32Array(cfg.histW));
      }
      this.writeCol = 0;
      this.activeBands = cfg.bands;

      this.time = 0;
      this.lastTime = performance.now() / 1000;

      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._buildBandMap(this.sampleRate);
      this._buildRidges();
      this._loop();
    }

    _resize() {
      const p = this.canvas.parentElement;
      const w = p.clientWidth;
      const h = p.clientHeight;
      this.aspect = w / h;
      this.renderer.setSize(w, h);
      this.camera.aspect = this.aspect;
      this.camera.updateProjectionMatrix();
    }

    _buildBandMap(sr) {
      this.sampleRate = sr;
      const hzPerBin = sr / cfg.fftSize;
      this.bandBinMap = [];
      for (let i = 0; i < cfg.bands; i++) {
        const f0 = cfg.freqLo * Math.pow(cfg.freqHi / cfg.freqLo, i / cfg.bands);
        const f1 = cfg.freqLo * Math.pow(cfg.freqHi / cfg.freqLo, (i + 1) / cfg.bands);
        const b0 = Math.max(0, Math.floor(f0 / hzPerBin));
        const b1 = Math.min(this.binCount, Math.max(Math.ceil(f1 / hzPerBin), b0 + 1));
        this.bandBinMap.push([b0, b1]);
      }
    }

    /* ---- audio ---- */

    connectAudio(el) {
      if (this.connected) return;
      try {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this._buildBandMap(this.audioCtx.sampleRate);
        const src = this.audioCtx.createMediaElementSource(el);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = cfg.fftSize;
        this.analyser.minDecibels = cfg.minDb;
        this.analyser.maxDecibels = cfg.maxDb;
        this.analyser.smoothingTimeConstant = cfg.fftSmooth;
        src.connect(this.analyser);
        this.delayNode = this.audioCtx.createDelay(1.0);
        this.delayNode.delayTime.value = 0.10;
        this.analyser.connect(this.delayNode);
        this.delayNode.connect(this.audioCtx.destination);
        this.rawData = new Uint8Array(this.analyser.frequencyBinCount);
        this.connected = true;
      } catch (e) {
        console.warn("Visualizer: connect failed", e);
      }
    }

    resumeCtx() {
      if (this.audioCtx && this.audioCtx.state === "suspended")
        this.audioCtx.resume();
    }

    /* ---- frequency ---- */

    _freq() {
      if (this.connected && this.analyser && this.isPlaying) {
        if (this.analyser.smoothingTimeConstant !== cfg.fftSmooth)
          this.analyser.smoothingTimeConstant = cfg.fftSmooth;
        if (this.analyser.minDecibels !== cfg.minDb)
          this.analyser.minDecibels = cfg.minDb;
        if (this.analyser.maxDecibels !== cfg.maxDb)
          this.analyser.maxDecibels = cfg.maxDb;

        this.analyser.getByteFrequencyData(this.rawData);
        let sum = 0;
        for (let i = 0; i < this.rawData.length; i++) sum += this.rawData[i];
        if (sum > 200) {
          for (let i = 0; i < this.binCount; i++) {
            const r = this.rawData[i] / 255;
            this.smoothed[i] += (r - this.smoothed[i]) * 1.0;
          }
          return;
        }
      }
      const t = this.time;
      const boost = this.isPlaying ? 1.4 : 0.5;
      for (let i = 0; i < this.binCount; i++) {
        const f = i / this.binCount;
        const fall = Math.pow(1 - f, 1.6);
        const v =
          (0.15 +
            Math.sin(t * 0.4 + f * 5) * 0.1 +
            Math.sin(t * 0.7 + f * 10 + 1.2) * 0.08 +
            Math.cos(t * 1.0) * 0.06 * (1 - f)) *
          fall * boost;
        this.smoothed[i] +=
          (Math.max(0, Math.min(1, v)) - this.smoothed[i]) * 0.04;
      }
    }

    /* ---- history ---- */

    _updateHistory() {
      const bands = this.activeBands;
      for (let b = 0; b < bands; b++) {
        const [lo, hi] = this.bandBinMap[b];
        let s = 0;
        for (let j = lo; j < hi && j < this.binCount; j++) s += this.smoothed[j];
        const raw = s / (hi - lo);

        this.bandAvg[b] += (raw - this.bandAvg[b]) * cfg.avgRate;

        if (raw > this.bandPeak[b]) this.bandPeak[b] = raw;
        else this.bandPeak[b] += (raw - this.bandPeak[b]) * cfg.peakDecay;

        const floor = this.bandAvg[b] * cfg.floorFactor;
        const range = Math.max(this.bandPeak[b] - floor, 0.01);
        const norm = Math.min(1, Math.max(0, (raw - floor) / range));

        if (norm > this.bandDisplay[b]) {
          this.bandDisplay[b] += (norm - this.bandDisplay[b]) * 0.4;
        } else {
          this.bandDisplay[b] *= cfg.decay;
        }

        this.history[b][this.writeCol] = this.bandDisplay[b];
      }
      this.writeCol = (this.writeCol + 1) % cfg.histW;
    }

    /* ---- build / rebuild 3D ridges ---- */

    _buildRidges() {
      this.ridgeData = [];
      this._rebuildRidges();
    }

    _rebuildRidges() {
      this.ridgeData.forEach(d => {
        this.scene.remove(d.line);
        this.scene.remove(d.fillMesh);
        d.lineGeo.dispose();
        d.lineMat.dispose();
        d.fillGeo.dispose();
        d.fillMat.dispose();
      });
      this.ridgeData = [];

      const bands = cfg.bands;
      const histW = cfg.histW;

      if (bands !== this.activeBands || histW !== this.history[0]?.length) {
        this.activeBands = bands;
        this.history = [];
        for (let b = 0; b < bands; b++) {
          this.history.push(new Float32Array(histW));
        }
        this.bandAvg = new Float32Array(bands).fill(0.15);
        this.bandPeak = new Float32Array(bands).fill(0.3);
        this.bandDisplay = new Float32Array(bands);
        this.writeCol = 0;
        this._buildBandMap(this.sampleRate);
      }

      for (let b = 0; b < bands; b++) {
        const bandT = bands > 1 ? b / (bands - 1) : 0.5;
        const hz = cfg.freqLo * Math.pow(cfg.freqHi / cfg.freqLo, bandT);
        const [cr, cg, cb] = hzToRGB(hz);
        const color = new THREE.Color(cr, cg, cb);

        const z = -cfg.chartSize / 2 + bandT * cfg.chartSize;

        const linePos = new Float32Array(histW * 3);
        for (let i = 0; i < histW; i++) {
          linePos[i * 3] = -cfg.chartSize / 2 + (i / (histW - 1)) * cfg.chartSize;
          linePos[i * 3 + 1] = 0;
          linePos[i * 3 + 2] = z;
        }
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
        const lineMat = new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: cfg.lineOpacity,
        });
        const line = new THREE.Line(lineGeo, lineMat);
        this.scene.add(line);

        const fillVerts = new Float32Array(histW * 2 * 3);
        const fillGeo = new THREE.BufferGeometry();
        fillGeo.setAttribute("position", new THREE.BufferAttribute(fillVerts, 3));
        const indices = [];
        for (let i = 0; i < histW - 1; i++) {
          const top = i * 2;
          const bot = i * 2 + 1;
          const topN = (i + 1) * 2;
          const botN = (i + 1) * 2 + 1;
          indices.push(top, bot, topN);
          indices.push(bot, botN, topN);
        }
        fillGeo.setIndex(indices);
        const fillMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: cfg.fillOpacity,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const fillMesh = new THREE.Mesh(fillGeo, fillMat);
        this.scene.add(fillMesh);

        this.ridgeData.push({ line, lineGeo, lineMat, fillGeo, fillMat, fillMesh, z });
      }
    }

    _smoothPass(arr, passes) {
      for (let p = 0; p < passes; p++) {
        for (let i = 1; i < arr.length - 1; i++) {
          arr[i] = arr[i] * 0.5 + (arr[i - 1] + arr[i + 1]) * 0.25;
        }
      }
    }

    _updateRidges() {
      const histW = cfg.histW;
      const raw = new Float32Array(histW);
      const fadeLen = Math.min(40, Math.floor(histW * 0.08));

      for (let b = 0; b < this.activeBands && b < this.ridgeData.length; b++) {
        for (let i = 0; i < histW; i++) {
          let v = this.history[b][(this.writeCol + i) % histW];
          if (i < fadeLen) v *= i / fadeLen;
          else if (i > histW - fadeLen) v *= (histW - i) / fadeLen;
          raw[i] = v;
        }

        this._smoothPass(raw, cfg.smoothPasses);
        const smooth = catmullRom(raw, histW);

        const d = this.ridgeData[b];
        const lineAttr = d.lineGeo.getAttribute("position");
        const lineArr = lineAttr.array;
        const fillAttr = d.fillGeo.getAttribute("position");
        const fillArr = fillAttr.array;
        const z = d.z;

        d.lineMat.opacity = cfg.lineOpacity;
        d.fillMat.opacity = cfg.fillOpacity;

        for (let i = 0; i < histW; i++) {
          const x = -cfg.chartSize / 2 + (i / (histW - 1)) * cfg.chartSize;
          const y = Math.max(0, smooth[i]) * cfg.peakHeight;

          lineArr[i * 3 + 1] = y;

          const ti = i * 2;
          fillArr[ti * 3] = x;
          fillArr[ti * 3 + 1] = y;
          fillArr[ti * 3 + 2] = z;
          fillArr[(ti + 1) * 3] = x;
          fillArr[(ti + 1) * 3 + 1] = 0;
          fillArr[(ti + 1) * 3 + 2] = z;
        }

        lineAttr.needsUpdate = true;
        fillAttr.needsUpdate = true;
      }
    }

    /* ---- camera orbit ---- */

    _updateCamera() {
      const angle = this.time * cfg.orbitSpeed;
      this.camera.position.set(
        Math.sin(angle) * cfg.orbitRadius,
        cfg.orbitHeight,
        Math.cos(angle) * cfg.orbitRadius
      );
      if (this.camera.fov !== cfg.fov) {
        this.camera.fov = cfg.fov;
        this.camera.updateProjectionMatrix();
      }
      this.camera.lookAt(0, 0.3, 0);
    }

    /* ---- loop ---- */

    _loop() {
      requestAnimationFrame(() => this._loop());
      const now = performance.now() / 1000;
      const dt = Math.min(now - this.lastTime, 0.06);
      this.lastTime = now;
      this.time += dt;

      this._freq();
      this._updateHistory();
      this._updateRidges();
      this._updateCamera();

      this.renderer.render(this.scene, this.camera);
    }
  }

  /* ===== Bootstrap ===== */
  const canvas = document.getElementById("visualizer-canvas");
  if (!canvas) return;

  const viz = new Visualizer(canvas);

  /* Expose config and rebuild for the settings panel */
  window.__vizCfg = cfg;
  window.__vizRebuild = () => {
    viz._rebuildRidges();
  };
  window.__vizResize = () => viz._resize();

  /* ===== Settings wiring ===== */

  const settingsBtn = document.getElementById("settings-btn");
  const settingsPanel = document.getElementById("viz-settings");
  const settingsClose = document.getElementById("settings-close");
  const fullscreenBtn = document.getElementById("fullscreen-btn");
  const vizSection = document.getElementById("visualizer-section");

  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener("click", () => {
      settingsPanel.classList.toggle("hidden");
    });
    settingsClose.addEventListener("click", () => {
      settingsPanel.classList.add("hidden");
    });
  }

  if (fullscreenBtn && vizSection) {
    fullscreenBtn.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        vizSection.requestFullscreen().catch(() => {});
        vizSection.classList.add("fullscreen");
      } else {
        document.exitFullscreen();
        vizSection.classList.remove("fullscreen");
      }
    });
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) {
        vizSection.classList.remove("fullscreen");
      }
      setTimeout(() => viz._resize(), 100);
    });
  }

  /* Slider bindings: { sliderId: { key, needsRebuild } } */
  const sliders = {
    "s-orbit-radius": { key: "orbitRadius" },
    "s-orbit-height": { key: "orbitHeight" },
    "s-orbit-speed":  { key: "orbitSpeed" },
    "s-fov":          { key: "fov" },
    "s-bands":        { key: "bands", rebuild: true },
    "s-peak-height":  { key: "peakHeight" },
    "s-chart-size":   { key: "chartSize", rebuild: true },
    "s-hist-w":       { key: "histW", rebuild: true },
    "s-smooth-passes":{ key: "smoothPasses" },
    "s-fft-smooth":   { key: "fftSmooth" },
    "s-decay":        { key: "decay" },
    "s-avg-rate":     { key: "avgRate" },
    "s-peak-decay":   { key: "peakDecay" },
    "s-floor-factor": { key: "floorFactor" },
    "s-line-opacity": { key: "lineOpacity" },
    "s-fill-opacity": { key: "fillOpacity" },
    "s-min-db":       { key: "minDb" },
    "s-max-db":       { key: "maxDb" },
  };

  let rebuildTimer = null;

  Object.entries(sliders).forEach(([id, { key, rebuild }]) => {
    const slider = document.getElementById(id);
    const valEl = document.getElementById("sv-" + id.slice(2));
    if (!slider) return;

    slider.addEventListener("input", () => {
      const v = parseFloat(slider.value);
      cfg[key] = v;
      if (valEl) valEl.textContent = v % 1 === 0 ? v : v.toFixed(
        v < 0.01 ? 4 : v < 1 ? 2 : 1
      );

      if (rebuild) {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => viz._rebuildRidges(), 150);
      }
    });
  });

  /* ===== Audio hook ===== */

  function hookAudio() {
    const audio = window.__wsAudio;
    if (!audio) {
      requestAnimationFrame(hookAudio);
      return;
    }
    audio.addEventListener("play", () => {
      viz.connectAudio(audio);
      viz.resumeCtx();
      viz.isPlaying = true;
    });
    audio.addEventListener("pause", () => {
      viz.isPlaying = false;
    });
    if (!audio.paused) {
      viz.connectAudio(audio);
      viz.resumeCtx();
      viz.isPlaying = true;
    }
  }
  hookAudio();
})();
