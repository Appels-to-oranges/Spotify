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

    lineWidth: 1,
    colorMix: 0,
    colorDecay: 0.03,
    colorBase: 0,
    invert: 0,
    bgBrightness: 0,
    envelopeSteep: 1.0,

    minDb: -80,
    maxDb: 0,

    audioDelay: 0.10,

    waveFlowStrength: 0,
    waveFlowFreq: 0.15,
    waveFlowSpeed: 0.1,

    flowPerBand: 50,
    flowSteps: 80,

    flowNoiseFreq: 0.04,
    flowNoiseSpeed: 0.025,
    flowOctaves: 2,

    flowStepSizeLo: 0.12,
    flowStepSizeHi: 0.20,
    flowStepSizeReact: 0.12,

    flowEdgeFade: 0.6,
    flowStartDrift: 0.8,

    flowStagger: 0.4,
    flowHistWindow: 1.0,
    flowHistFade: 0.08,
    flowHistBlend: 0.2,
    flowBandSpread: 0,
    flowSmooth: 3,
  };

  const THEMES = ["wavestation", "perlinstation"];
  let currentTheme = 0;

  /* ===== Simplex 3D noise ===== */
  const GRAD3 = [
    [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
    [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
    [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
  ];
  const PERM = new Uint8Array(512);
  (function() {
    const p = [];
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  })();

  function dot3(g, x, y, z) { return g[0]*x + g[1]*y + g[2]*z; }

  function simplex3(xin, yin, zin) {
    const F3 = 1/3, G3 = 1/6;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const X0 = i - t, Y0 = j - t, Z0 = k - t;
    const x0 = xin - X0, y0 = yin - Y0, z0 = zin - Z0;

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=1;k2=0; }
      else if (x0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=0;k2=1; }
      else { i1=0;j1=0;k1=1;i2=1;j2=0;k2=1; }
    } else {
      if (y0 < z0) { i1=0;j1=0;k1=1;i2=0;j2=1;k2=1; }
      else if (x0 < z0) { i1=0;j1=1;k1=0;i2=0;j2=1;k2=1; }
      else { i1=0;j1=1;k1=0;i2=1;j2=1;k2=0; }
    }

    const x1=x0-i1+G3, y1=y0-j1+G3, z1=z0-k1+G3;
    const x2=x0-i2+2*G3, y2=y0-j2+2*G3, z2=z0-k2+2*G3;
    const x3=x0-1+3*G3, y3=y0-1+3*G3, z3=z0-1+3*G3;

    const ii=i&255, jj=j&255, kk=k&255;
    const gi0=PERM[ii+PERM[jj+PERM[kk]]]%12;
    const gi1=PERM[ii+i1+PERM[jj+j1+PERM[kk+k1]]]%12;
    const gi2=PERM[ii+i2+PERM[jj+j2+PERM[kk+k2]]]%12;
    const gi3=PERM[ii+1+PERM[jj+1+PERM[kk+1]]]%12;

    let n0=0, n1=0, n2=0, n3=0;
    let t0=0.6-x0*x0-y0*y0-z0*z0;
    if (t0>0) { t0*=t0; n0=t0*t0*dot3(GRAD3[gi0],x0,y0,z0); }
    let t1=0.6-x1*x1-y1*y1-z1*z1;
    if (t1>0) { t1*=t1; n1=t1*t1*dot3(GRAD3[gi1],x1,y1,z1); }
    let t2=0.6-x2*x2-y2*y2-z2*z2;
    if (t2>0) { t2*=t2; n2=t2*t2*dot3(GRAD3[gi2],x2,y2,z2); }
    let t3=0.6-x3*x3-y3*y3-z3*z3;
    if (t3>0) { t3*=t3; n3=t3*t3*dot3(GRAD3[gi3],x3,y3,z3); }
    return 32*(n0+n1+n2+n3);
  }

  /* Fractal Brownian Motion for richer noise */
  function fbm3(x, y, z, octaves) {
    let val = 0, amp = 1, freq = 1, max = 0;
    for (let o = 0; o < octaves; o++) {
      val += simplex3(x * freq, y * freq, z * freq) * amp;
      max += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return val / max;
  }

  /* ===== Catmull-Rom interpolation ===== */
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

  /* ===== Hz → nm → RGB ===== */
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

  const _white = new THREE.Color(1, 1, 1);
  const _black = new THREE.Color(0, 0, 0);

  class Visualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      this.renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
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
      this.bandColorAmp = new Float32Array(cfg.bands);
      this.bandBinMap = [];

      this.history = [];
      for (let b = 0; b < cfg.bands; b++) {
        this.history.push(new Float32Array(cfg.histW));
      }
      this.writeCol = 0;
      this.activeBands = cfg.bands;

      this.time = 0;
      this.lastTime = performance.now() / 1000;

      this.ridgeData = [];
      this.perlinData = [];

      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._buildBandMap(this.sampleRate);
      this._buildScene();
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
        this.delayNode.delayTime.value = cfg.audioDelay;
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
        if (this.delayNode && this.delayNode.delayTime.value !== cfg.audioDelay)
          this.delayNode.delayTime.value = cfg.audioDelay;

        this.analyser.getByteFrequencyData(this.rawData);
        for (let i = 0; i < this.binCount; i++) {
          const r = this.rawData[i] / 255;
          this.smoothed[i] += (r - this.smoothed[i]) * 1.0;
        }
        return;
      }

      for (let i = 0; i < this.binCount; i++) {
        this.smoothed[i] *= 0.92;
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

        if (norm > this.bandColorAmp[b]) {
          this.bandColorAmp[b] += (norm - this.bandColorAmp[b]) * 0.4;
        } else {
          this.bandColorAmp[b] *= (1 - cfg.colorDecay);
        }

        this.history[b][this.writeCol] = this.bandDisplay[b];
      }
      this.writeCol = (this.writeCol + 1) % cfg.histW;
    }

    /* ---- scene management ---- */

    _buildScene() {
      if (THEMES[currentTheme] === "wavestation") {
        this._rebuildRidges();
      } else {
        this._rebuildPerlin();
      }
    }

    _clearScene() {
      this.ridgeData.forEach(d => {
        this.scene.remove(d.line);
        this.scene.remove(d.fillMesh);
        d.lineGeo.dispose(); d.lineMat.dispose();
        d.fillGeo.dispose(); d.fillMat.dispose();
      });
      this.ridgeData = [];

      this.perlinData.forEach(d => {
        this.scene.remove(d.line);
        this.scene.remove(d.fillMesh);
        d.geo.dispose(); d.mat.dispose();
        d.fillGeo.dispose(); d.fillMat.dispose();
      });
      this.perlinData = [];
    }

    switchTheme() {
      currentTheme = (currentTheme + 1) % THEMES.length;
      this._clearScene();
      this._buildScene();
      return THEMES[currentTheme];
    }

    rebuildCurrentTheme() {
      this._clearScene();

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
        this.bandColorAmp = new Float32Array(bands);
        this.writeCol = 0;
        this._buildBandMap(this.sampleRate);
      }

      this._buildScene();
    }

    /* ======== WAVESTATION theme ======== */

    _rebuildRidges() {
      const bands = cfg.bands;
      const histW = cfg.histW;

      if (bands !== this.activeBands || histW !== this.history[0]?.length) {
        this.activeBands = bands;
        this.history = [];
        for (let b = 0; b < bands; b++) this.history.push(new Float32Array(histW));
        this.bandAvg = new Float32Array(bands).fill(0.15);
        this.bandPeak = new Float32Array(bands).fill(0.3);
        this.bandDisplay = new Float32Array(bands);
        this.bandColorAmp = new Float32Array(bands);
        this.writeCol = 0;
        this._buildBandMap(this.sampleRate);
      }

      for (let b = 0; b < bands; b++) {
        const bandT = bands > 1 ? b / (bands - 1) : 0.5;
        const hz = cfg.freqLo * Math.pow(cfg.freqHi / cfg.freqLo, bandT);
        const [cr, cg, cb] = hzToRGB(hz);
        const bandColor = new THREE.Color(cr, cg, cb);
        const z = -cfg.chartSize / 2 + bandT * cfg.chartSize;

        const linePos = new Float32Array(histW * 3);
        for (let i = 0; i < histW; i++) {
          linePos[i * 3] = -cfg.chartSize / 2 + (i / (histW - 1)) * cfg.chartSize;
          linePos[i * 3 + 1] = 0;
          linePos[i * 3 + 2] = z;
        }
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
        const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: cfg.lineOpacity, linewidth: cfg.lineWidth });
        const line = new THREE.Line(lineGeo, lineMat);
        this.scene.add(line);

        const fillVerts = new Float32Array(histW * 2 * 3);
        const fillGeo = new THREE.BufferGeometry();
        fillGeo.setAttribute("position", new THREE.BufferAttribute(fillVerts, 3));
        const indices = [];
        for (let i = 0; i < histW - 1; i++) {
          indices.push(i*2, i*2+1, (i+1)*2);
          indices.push(i*2+1, (i+1)*2+1, (i+1)*2);
        }
        fillGeo.setIndex(indices);
        const fillMat = new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: cfg.fillOpacity,
          side: THREE.DoubleSide, depthWrite: false,
        });
        const fillMesh = new THREE.Mesh(fillGeo, fillMat);
        this.scene.add(fillMesh);

        this.ridgeData.push({ line, lineGeo, lineMat, fillGeo, fillMat, fillMesh, bandColor, z });
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
        const lineArr = d.lineGeo.getAttribute("position").array;
        const fillArr = d.fillGeo.getAttribute("position").array;
        const z = d.z;
        d.lineMat.opacity = cfg.lineOpacity;
        d.fillMat.opacity = cfg.fillOpacity;
        d.lineMat.linewidth = cfg.lineWidth;

        const baseColor = cfg.colorBase > 0.5 ? _black : _white;
        const cBlend = 1 - (1 - (this.bandColorAmp[b] || 0)) * cfg.colorMix;
        d.lineMat.color.copy(baseColor).lerp(d.bandColor, cBlend);
        d.fillMat.color.copy(baseColor).lerp(d.bandColor, cBlend);

        const wfStr = cfg.waveFlowStrength;
        const wfFreq = cfg.waveFlowFreq;
        const wfT = this.time * cfg.waveFlowSpeed;

        for (let i = 0; i < histW; i++) {
          const baseX = -cfg.chartSize / 2 + (i / (histW - 1)) * cfg.chartSize;
          const y = Math.max(0, smooth[i]) * cfg.peakHeight;

          let x = baseX;
          let zv = z;
          if (wfStr > 0) {
            const nx = baseX * wfFreq;
            const nz = z * wfFreq;
            x += simplex3(nx, nz, wfT) * wfStr;
            zv += simplex3(nx + 100, nz + 100, wfT) * wfStr;
          }

          lineArr[i * 3]     = x;
          lineArr[i * 3 + 1] = y;
          lineArr[i * 3 + 2] = zv;
          const ti = i * 2;
          fillArr[ti * 3] = x;
          fillArr[ti * 3 + 1] = y;
          fillArr[ti * 3 + 2] = zv;
          fillArr[(ti + 1) * 3] = x;
          fillArr[(ti + 1) * 3 + 1] = 0;
          fillArr[(ti + 1) * 3 + 2] = zv;
        }

        d.lineGeo.getAttribute("position").needsUpdate = true;
        d.fillGeo.getAttribute("position").needsUpdate = true;
      }
    }

    /* ======== PERLINSTATION theme ======== */
    /* Dense flow field: many streamlines per band trace through a shared noise
       vector field.  Audio amplitude modulates opacity, height, and reach. */

    _rebuildPerlin() {
      const bands = cfg.bands;

      if (bands !== this.activeBands) {
        this.activeBands = bands;
        this.history = [];
        for (let b = 0; b < bands; b++) this.history.push(new Float32Array(cfg.histW));
        this.bandAvg = new Float32Array(bands).fill(0.15);
        this.bandPeak = new Float32Array(bands).fill(0.3);
        this.bandDisplay = new Float32Array(bands);
        this.bandColorAmp = new Float32Array(bands);
        this.writeCol = 0;
        this._buildBandMap(this.sampleRate);
      }

      const half = cfg.chartSize / 2;

      for (let b = 0; b < bands; b++) {
        const bandT = bands > 1 ? b / (bands - 1) : 0.5;
        const hz = cfg.freqLo * Math.pow(cfg.freqHi / cfg.freqLo, bandT);
        const [cr, cg, cb] = hzToRGB(hz);
        const bandColor = new THREE.Color(cr, cg, cb);

        for (let l = 0; l < cfg.flowPerBand; l++) {
          const steps = cfg.flowSteps;
          const positions = new Float32Array(steps * 3);
          const colors = new Float32Array(steps * 3);
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
          const mat = new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.05, depthWrite: false, linewidth: cfg.lineWidth,
          });
          const line = new THREE.Line(geo, mat);
          this.scene.add(line);

          const fillVerts = new Float32Array(steps * 2 * 3);
          const fillColors = new Float32Array(steps * 2 * 3);
          const fillGeo = new THREE.BufferGeometry();
          fillGeo.setAttribute("position", new THREE.BufferAttribute(fillVerts, 3));
          fillGeo.setAttribute("color", new THREE.BufferAttribute(fillColors, 3));
          const fillIdx = [];
          for (let i = 0; i < steps - 1; i++) {
            fillIdx.push(i*2, i*2+1, (i+1)*2);
            fillIdx.push(i*2+1, (i+1)*2+1, (i+1)*2);
          }
          fillGeo.setIndex(fillIdx);
          const fillMat = new THREE.MeshBasicMaterial({
            vertexColors: true, transparent: true, opacity: cfg.fillOpacity,
            side: THREE.DoubleSide, depthWrite: false,
          });
          const fillMesh = new THREE.Mesh(fillGeo, fillMat);
          this.scene.add(fillMesh);

          const seed = b * 31.7 + l * 3.1;
          const sx = simplex3(seed, 0, 0) * half * 1.4;
          const orderedZ = -half + bandT * cfg.chartSize;
          const spreadOffset = simplex3(b * 7.3, 0.5, 0) * half * 1.8 * cfg.flowBandSpread;
          const baseZ = orderedZ * (1 - cfg.flowBandSpread) + (-half + (simplex3(b * 7.3, 0.5, 0) + 1) * 0.5 * cfg.chartSize) * cfg.flowBandSpread;
          const sz = baseZ + simplex3(0, seed, 0) * (cfg.chartSize / bands) * 0.6;

          this.perlinData.push({ line, geo, mat, fillMesh, fillGeo, fillMat, band: b, bandT, bandColor, sx, sz, seed, lineIdx: l });
        }
      }
    }

    _updatePerlin() {
      const half = cfg.chartSize / 2;
      const bound = half * 1.4;
      const nf = cfg.flowNoiseFreq;
      const t = this.time * cfg.flowNoiseSpeed;
      const oct = Math.round(cfg.flowOctaves);
      const steps = cfg.flowSteps;
      const histW = cfg.histW;
      const fadeStart = cfg.flowEdgeFade;
      const fadeRange = Math.max(0.01, 1 - fadeStart);
      const fadeLen = Math.min(40, Math.floor(histW * cfg.flowHistFade));
      const perBand = cfg.flowPerBand;
      const maxStagger = Math.floor(histW * cfg.flowStagger);
      const histSpan = Math.max(1, Math.floor(histW * cfg.flowHistWindow));
      const hBlend = cfg.flowHistBlend;

      const smoothCache = this._perlinSmoothCache || [];
      const raw = new Float32Array(histW);

      for (let b = 0; b < this.activeBands; b++) {
        for (let i = 0; i < histW; i++) {
          let v = this.history[b][(this.writeCol + i) % histW];
          if (i < fadeLen) v *= i / fadeLen;
          else if (i > histW - fadeLen) v *= (histW - i) / fadeLen;
          raw[i] = v;
        }
        this._smoothPass(raw, cfg.smoothPasses);
        smoothCache[b] = catmullRom(raw, histW);
      }
      this._perlinSmoothCache = smoothCache;

      for (let p = 0; p < this.perlinData.length; p++) {
        const d = this.perlinData[p];
        const arr = d.geo.getAttribute("position").array;
        const colArr = d.geo.getAttribute("color").array;
        const fillArr = d.fillGeo.getAttribute("position").array;
        const fillColArr = d.fillGeo.getAttribute("color").array;
        const amp = this.bandDisplay[d.band] || 0;
        const smooth = smoothCache[d.band];
        if (!smooth) continue;

        const stagger = Math.floor((d.lineIdx / perBand) * maxStagger);

        const ss = cfg.flowStepSizeLo + (cfg.flowStepSizeHi - cfg.flowStepSizeLo) * d.bandT
                 + amp * cfg.flowStepSizeReact;

        d.mat.opacity = cfg.lineOpacity;
        d.fillMat.opacity = cfg.fillOpacity;
        d.mat.linewidth = cfg.lineWidth;

        const baseR = cfg.colorBase > 0.5 ? 0 : 1;
        const baseG = baseR;
        const baseB = baseR;
        const cBlend = 1 - (1 - (this.bandColorAmp[d.band] || 0)) * cfg.colorMix;
        const colR = baseR + (d.bandColor.r - baseR) * cBlend;
        const colG = baseG + (d.bandColor.g - baseG) * cBlend;
        const colB = baseB + (d.bandColor.b - baseB) * cBlend;

        const drift = cfg.flowStartDrift;
        const startX = d.sx + simplex3(d.seed, t * 0.15, 0) * drift;
        const startZ = d.sz + simplex3(0, d.seed, t * 0.15) * drift * 0.5;

        let cx = startX;
        let cz = startZ;

        for (let i = 0; i < steps; i++) {
          const envelope = Math.pow(Math.sin((i / (steps - 1)) * Math.PI), cfg.envelopeSteep);
          const angle = fbm3(cx * nf, cz * nf, t, oct) * Math.PI * 2;

          const yNoise = (fbm3(cx * nf + 200, cz * nf + 200, t, 2) + 1) * 0.5;
          const noiseY = amp * yNoise * cfg.peakHeight;

          const histIdx = Math.min(histW - 1, histW - 1 - stagger + Math.floor(i * histSpan / steps));
          const hVal = histIdx >= 0 ? Math.max(0, smooth[histIdx]) : 0;
          const histY = hVal * cfg.peakHeight;

          const y = (noiseY * (1 - hBlend) + histY * hBlend) * envelope;

          arr[i * 3]     = cx;
          arr[i * 3 + 1] = y;
          arr[i * 3 + 2] = cz;

          cx += Math.cos(angle) * ss;
          cz += Math.sin(angle) * ss;
        }

        const fSmooth = Math.round(cfg.flowSmooth);
        for (let s = 0; s < fSmooth; s++) {
          for (let i = 1; i < steps - 1; i++) {
            arr[i * 3 + 1] = arr[i * 3 + 1] * 0.5
              + (arr[(i - 1) * 3 + 1] + arr[(i + 1) * 3 + 1]) * 0.25;
          }
        }

        for (let i = 0; i < steps; i++) {
          const envelope = Math.pow(Math.sin((i / (steps - 1)) * Math.PI), cfg.envelopeSteep);
          const px = arr[i * 3];
          const py = arr[i * 3 + 1];
          const pz = arr[i * 3 + 2];

          const edgeX = Math.abs(px) / half;
          const edgeZ = Math.abs(pz) / half;
          const edge = Math.max(edgeX, edgeZ);
          const fade = edge < fadeStart ? 1 : Math.max(0, 1 - (edge - fadeStart) / fadeRange);

          const eFade = fade * envelope;
          const fr = colR * fade;
          const fg = colG * fade;
          const fb = colB * fade;

          colArr[i * 3]     = fr;
          colArr[i * 3 + 1] = fg;
          colArr[i * 3 + 2] = fb;

          const ti = i * 2;
          fillArr[ti * 3]         = px;
          fillArr[ti * 3 + 1]     = py;
          fillArr[ti * 3 + 2]     = pz;
          fillArr[(ti+1) * 3]     = px;
          fillArr[(ti+1) * 3 + 1] = 0;
          fillArr[(ti+1) * 3 + 2] = pz;

          fillColArr[ti * 3]         = colR * eFade;
          fillColArr[ti * 3 + 1]     = colG * eFade;
          fillColArr[ti * 3 + 2]     = colB * eFade;
          fillColArr[(ti+1) * 3]     = 0;
          fillColArr[(ti+1) * 3 + 1] = 0;
          fillColArr[(ti+1) * 3 + 2] = 0;
        }

        d.geo.getAttribute("position").needsUpdate = true;
        d.geo.getAttribute("color").needsUpdate = true;
        d.fillGeo.getAttribute("position").needsUpdate = true;
        d.fillGeo.getAttribute("color").needsUpdate = true;
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

      if (THEMES[currentTheme] === "wavestation") {
        this._updateRidges();
      } else {
        this._updatePerlin();
      }

      this._updateCamera();

      const bgV = cfg.bgBrightness;
      this.renderer.setClearColor(new THREE.Color(bgV, bgV, bgV), 1);

      const inverted = cfg.invert > 0.5;
      this.canvas.style.filter = inverted ? "invert(1)" : "";
      this.canvas.parentElement.classList.toggle("inverted", inverted);

      this.renderer.render(this.scene, this.camera);
    }
  }

  /* ===== Bootstrap ===== */
  const canvas = document.getElementById("visualizer-canvas");
  if (!canvas) return;

  const viz = new Visualizer(canvas);

  window.__vizCfg = cfg;
  window.__vizRebuild = () => viz.rebuildCurrentTheme();
  window.__vizResize = () => viz._resize();

  /* ===== Theme visibility ===== */

  function updateThemeSettings() {
    const isWave = THEMES[currentTheme] === "wavestation";
    document.querySelectorAll(".theme-perlin").forEach(el => el.style.display = isWave ? "none" : "block");
    document.querySelectorAll(".theme-wave").forEach(el => el.style.display = isWave ? "block" : "none");
  }

  updateThemeSettings();

  /* ===== Settings wiring ===== */

  const settingsBtn = document.getElementById("settings-btn");
  const settingsPanel = document.getElementById("viz-settings");
  const settingsClose = document.getElementById("settings-close");
  const fullscreenBtn = document.getElementById("fullscreen-btn");
  const vizSection = document.getElementById("visualizer-section");

  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener("click", () => settingsPanel.classList.toggle("hidden"));
    settingsClose.addEventListener("click", () => settingsPanel.classList.add("hidden"));
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
      if (!document.fullscreenElement) vizSection.classList.remove("fullscreen");
      setTimeout(() => viz._resize(), 100);
    });
  }

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
    "s-line-width":   { key: "lineWidth" },
    "s-color-mix":    { key: "colorMix" },
    "s-color-decay":  { key: "colorDecay" },
    "s-color-base":   { key: "colorBase" },
    "s-bg-brightness":{ key: "bgBrightness" },
    "s-envelope-steep":{ key: "envelopeSteep" },
    "s-min-db":       { key: "minDb" },
    "s-max-db":       { key: "maxDb" },
    "s-audio-delay":  { key: "audioDelay" },
    "s-wave-flow-strength": { key: "waveFlowStrength" },
    "s-wave-flow-freq":     { key: "waveFlowFreq" },
    "s-wave-flow-speed":    { key: "waveFlowSpeed" },
    "s-flow-per-band":  { key: "flowPerBand", rebuild: true },
    "s-flow-steps":     { key: "flowSteps", rebuild: true },
    "s-flow-noise-freq":{ key: "flowNoiseFreq" },
    "s-flow-noise-speed":{ key: "flowNoiseSpeed" },
    "s-flow-octaves":   { key: "flowOctaves" },
    "s-flow-edge-fade": { key: "flowEdgeFade" },
    "s-flow-start-drift":{ key: "flowStartDrift" },
    "s-flow-step-size-lo":    { key: "flowStepSizeLo" },
    "s-flow-step-size-hi":    { key: "flowStepSizeHi" },
    "s-flow-step-size-react": { key: "flowStepSizeReact" },
    "s-flow-band-spread":     { key: "flowBandSpread", rebuild: true },
    "s-flow-smooth":          { key: "flowSmooth" },
    "s-flow-stagger":         { key: "flowStagger" },
    "s-flow-hist-window":     { key: "flowHistWindow" },
    "s-flow-hist-fade":       { key: "flowHistFade" },
    "s-flow-hist-blend":      { key: "flowHistBlend" },
  };

  let rebuildTimer = null;

  Object.entries(sliders).forEach(([id, { key, rebuild }]) => {
    const slider = document.getElementById(id);
    const valEl = document.getElementById("sv-" + id.slice(2));
    if (!slider) return;

    slider.addEventListener("input", () => {
      const v = parseFloat(slider.value);
      cfg[key] = v;
      if (valEl) {
        if (key === "audioDelay") valEl.textContent = Math.round(v * 1000) + "ms";
        else valEl.textContent = v % 1 === 0 ? v : v.toFixed(v < 0.01 ? 4 : v < 1 ? 2 : 1);
      }

      if (rebuild) {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => viz.rebuildCurrentTheme(), 150);
      }
    });
  });

  /* ===== Theme defaults ===== */

  const themeDefaults = {
    wavestation: {
      orbitRadius: 20, orbitHeight: 5, orbitSpeed: 0.15, fov: 50,
      bands: 24, peakHeight: 2.0, chartSize: 16, histW: 250,
      smoothPasses: 12, fftSmooth: 0.95,
      decay: 0.10, avgRate: 0.003, peakDecay: 0.0005, floorFactor: 0.99,
      lineWidth: 1, lineOpacity: 1.0, fillOpacity: 0.10,
      colorMix: 0, colorDecay: 0.03, colorBase: 0,
      bgBrightness: 0,
      waveFlowStrength: 0, waveFlowFreq: 0.15, waveFlowSpeed: 0.1,
      audioDelay: 0.10, minDb: -80, maxDb: 0,
    },
    perlinstation: {
      orbitRadius: 25, orbitHeight: 16, orbitSpeed: 0.10, fov: 50,
      bands: 48, peakHeight: 3, chartSize: 16, histW: 200,
      smoothPasses: 20, fftSmooth: 0.75,
      decay: 0.60, avgRate: 0.05, peakDecay: 0.0005, floorFactor: 0.90,
      lineWidth: 1, lineOpacity: 0.20, fillOpacity: 0.15,
      colorMix: 0.70, colorDecay: 0.20, colorBase: 0,
      bgBrightness: 0, envelopeSteep: 1.0,
      audioDelay: 0.10, minDb: -80, maxDb: 0,
      flowPerBand: 20, flowSteps: 30, flowNoiseFreq: 0.03, flowNoiseSpeed: 0.10,
      flowOctaves: 2, flowEdgeFade: 0.20, flowStartDrift: 0.8,
      flowStepSizeLo: 0.02, flowStepSizeHi: 0.03, flowStepSizeReact: 0.50,
      flowStagger: 0.10, flowHistWindow: 0.10, flowHistFade: 0.30, flowHistBlend: 0.10, flowBandSpread: 0, flowSmooth: 3,
    },
  };

  function applyThemeDefaults(themeName) {
    const defs = themeDefaults[themeName];
    if (!defs) return;
    Object.assign(cfg, defs);

    Object.entries(sliders).forEach(([id, { key }]) => {
      const slider = document.getElementById(id);
      const valEl = document.getElementById("sv-" + id.slice(2));
      if (!slider || !(key in defs)) return;
      slider.value = defs[key];
      if (valEl) {
        if (key === "audioDelay") valEl.textContent = Math.round(defs[key] * 1000) + "ms";
        else {
          const v = defs[key];
          valEl.textContent = v % 1 === 0 ? v : v.toFixed(v < 0.01 ? 4 : v < 1 ? 2 : 1);
        }
      }
    });

    const cbEl = document.getElementById("s-color-base");
    if (cbEl && "colorBase" in defs) cbEl.checked = defs.colorBase > 0.5;
    const invEl = document.getElementById("s-invert");
    if (invEl && "invert" in defs) invEl.checked = defs.invert > 0.5;
  }

  const themeBtn = document.getElementById("theme-btn");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const name = viz.switchTheme();
      themeBtn.title = name === "wavestation" ? "Theme: WaveStation" : "Theme: PerlinStation";
      applyThemeDefaults(name);
      updateThemeSettings();
      viz.rebuildCurrentTheme();
    });
  }

  /* ===== Preset system ===== */

  const PRESET_STORAGE_KEY = "ws_presets";

  function getPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY)) || {}; }
    catch { return {}; }
  }

  function savePreset(name) {
    const presets = getPresets();
    const snap = {};
    Object.keys(cfg).forEach(k => snap[k] = cfg[k]);
    snap._theme = THEMES[currentTheme];
    presets[name] = snap;
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    renderPresetList();
  }

  function loadPreset(name) {
    const presets = getPresets();
    const snap = presets[name];
    if (!snap) return;

    if (snap._theme && snap._theme !== THEMES[currentTheme]) {
      const idx = THEMES.indexOf(snap._theme);
      if (idx >= 0) {
        currentTheme = idx;
        if (themeBtn) themeBtn.title = snap._theme === "wavestation" ? "Theme: WaveStation" : "Theme: PerlinStation";
        updateThemeSettings();
      }
    }

    Object.keys(snap).forEach(k => {
      if (k === "_theme") return;
      cfg[k] = snap[k];
    });

    Object.entries(sliders).forEach(([id, { key }]) => {
      const slider = document.getElementById(id);
      const valEl = document.getElementById("sv-" + id.slice(2));
      if (!slider || !(key in snap)) return;
      slider.value = snap[key];
      if (valEl) {
        if (key === "audioDelay") valEl.textContent = Math.round(snap[key] * 1000) + "ms";
        else {
          const v = snap[key];
          valEl.textContent = v % 1 === 0 ? v : v.toFixed(v < 0.01 ? 4 : v < 1 ? 2 : 1);
        }
      }
    });

    const colorBaseEl = document.getElementById("s-color-base");
    if (colorBaseEl) colorBaseEl.checked = snap.colorBase > 0.5;
    const invertEl = document.getElementById("s-invert");
    if (invertEl) invertEl.checked = (snap.invert || 0) > 0.5;

    viz.rebuildCurrentTheme();
  }

  function deletePreset(name) {
    const presets = getPresets();
    delete presets[name];
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    renderPresetList();
  }

  function renderPresetList() {
    const list = document.getElementById("preset-list");
    if (!list) return;
    list.innerHTML = "";
    const presets = getPresets();
    Object.keys(presets).sort().forEach(name => {
      const row = document.createElement("div");
      row.className = "preset-row";

      const label = document.createElement("span");
      label.className = "preset-name";
      label.textContent = name;
      label.addEventListener("click", () => loadPreset(name));

      const del = document.createElement("button");
      del.className = "preset-del";
      del.textContent = "\u00d7";
      del.title = "Delete preset";
      del.addEventListener("click", (e) => { e.stopPropagation(); deletePreset(name); });

      row.appendChild(label);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  const presetSaveBtn = document.getElementById("preset-save");
  const presetNameInput = document.getElementById("preset-name");
  if (presetSaveBtn && presetNameInput) {
    presetSaveBtn.addEventListener("click", () => {
      const name = presetNameInput.value.trim();
      if (!name) return;
      savePreset(name);
      presetNameInput.value = "";
    });
    presetNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { presetSaveBtn.click(); e.preventDefault(); }
    });
  }

  renderPresetList();

  const colorBaseCheck = document.getElementById("s-color-base");
  if (colorBaseCheck) {
    colorBaseCheck.addEventListener("change", () => {
      cfg.colorBase = colorBaseCheck.checked ? 1 : 0;
    });
  }

  const invertCheck = document.getElementById("s-invert");
  if (invertCheck) {
    invertCheck.addEventListener("change", () => {
      cfg.invert = invertCheck.checked ? 1 : 0;
    });
  }

  /* ===== Randomize ===== */

  const randomizeBtn = document.getElementById("randomize-btn");
  if (randomizeBtn) {
    randomizeBtn.addEventListener("click", () => {
      const rr = (lo, hi, step) => {
        const steps = Math.round((hi - lo) / step);
        return lo + Math.round(Math.random() * steps) * step;
      };

      Object.entries(sliders).forEach(([id, { key, rebuild }]) => {
        const slider = document.getElementById(id);
        if (!slider) return;
        const lo = parseFloat(slider.min);
        const hi = parseFloat(slider.max);
        const step = parseFloat(slider.step) || 1;
        const v = rr(lo, hi, step);
        cfg[key] = v;
        slider.value = v;
        const valEl = document.getElementById("sv-" + id.slice(2));
        if (valEl) {
          if (key === "audioDelay") valEl.textContent = Math.round(v * 1000) + "ms";
          else valEl.textContent = v % 1 === 0 ? v : v.toFixed(v < 0.01 ? 4 : v < 1 ? 2 : 1);
        }
      });

      cfg.colorBase = Math.random() > 0.5 ? 1 : 0;
      if (colorBaseCheck) colorBaseCheck.checked = cfg.colorBase > 0.5;

      cfg.invert = Math.random() > 0.7 ? 1 : 0;
      if (invertCheck) invertCheck.checked = cfg.invert > 0.5;

      viz.rebuildCurrentTheme();
    });
  }

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
