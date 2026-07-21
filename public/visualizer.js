(function () {
  "use strict";

  if (typeof THREE === "undefined") return;

  /* ===== Config ===== */
  const BANDS = 12;
  const HIST_W = 400;
  const BOKEH_COUNT = 14;
  const FFT_SIZE = 2048;
  const FREQ_LO = 30;
  const FREQ_HI = 18000;
  const NM_RED = 780;
  const NM_VIOLET = 380;
  const SMOOTH = 1.0;
  const AMBIENT_SMOOTH = 0.04;

  const ORBIT_SPEED = 0.06;
  const ORBIT_RADIUS = 6;
  const ORBIT_HEIGHT = 3.5;
  const CHART_WIDTH = 8;
  const CHART_DEPTH = 5;
  const PEAK_HEIGHT = 2.5;

  /* ===== Hz helpers ===== */

  function hzToNm(hz) {
    const t = Math.log(hz / FREQ_LO) / Math.log(FREQ_HI / FREQ_LO);
    return NM_RED - t * (NM_RED - NM_VIOLET);
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
  function rand(a, b) { return a + Math.random() * (b - a); }

  /* ===== Bokeh shaders ===== */

  const bokehVert = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

  const bokehFrag = `
    uniform float uAlpha;
    uniform vec3  uColor;
    varying vec2 vUv;
    void main() {
      float d = length(vUv - 0.5) * 2.0;
      float a = 1.0 - smoothstep(0.0, 1.0, d);
      a = pow(a, 2.5);
      gl_FragColor = vec4(uColor, a * uAlpha);
    }`;

  /* ===== Visualizer ===== */

  class Visualizer {
    constructor(canvas) {
      this.canvas = canvas;

      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      this.renderer.setClearColor(0x0a0a0a, 1);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.autoClear = false;

      this.aspect = 1;

      /* Bokeh stays 2D */
      this.bokehCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      this.bokehCam.position.z = 5;
      this.bokehScene = new THREE.Scene();

      /* 3D scene for ridges */
      this.ridgeCam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      this.ridgeScene = new THREE.Scene();

      this.audioCtx = null;
      this.analyser = null;
      this.rawData = null;
      this.sampleRate = 44100;
      this.binCount = FFT_SIZE / 2;
      this.smoothed = new Float32Array(this.binCount);
      this.connected = false;
      this.isPlaying = false;

      this.bandAvg = new Float32Array(BANDS).fill(0.15);
      this.bandPeak = new Float32Array(BANDS).fill(0.3);
      this.bandDisplay = new Float32Array(BANDS);
      this.bandBinMap = [];

      /* Circular history buffer: BANDS rows × HIST_W columns */
      this.history = [];
      for (let b = 0; b < BANDS; b++) {
        this.history.push(new Float32Array(HIST_W));
      }
      this.writeCol = 0;

      this.time = 0;
      this.lastTime = performance.now() / 1000;
      this.bokeh = [];

      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._buildBandMap(this.sampleRate);
      this._buildBokeh();
      this._buildRidges();
      this._loop();
    }

    _resize() {
      const p = this.canvas.parentElement;
      const w = p.clientWidth;
      const h = p.clientHeight;
      this.aspect = w / h;
      this.renderer.setSize(w, h);

      this.bokehCam.left = -this.aspect;
      this.bokehCam.right = this.aspect;
      this.bokehCam.updateProjectionMatrix();

      this.ridgeCam.aspect = this.aspect;
      this.ridgeCam.updateProjectionMatrix();
    }

    _buildBandMap(sr) {
      this.sampleRate = sr;
      const hzPerBin = sr / FFT_SIZE;
      this.bandBinMap = [];
      for (let i = 0; i < BANDS; i++) {
        const f0 = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, i / BANDS);
        const f1 = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, (i + 1) / BANDS);
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
        this.analyser.fftSize = FFT_SIZE;
        this.analyser.minDecibels = -60;
        this.analyser.maxDecibels = -10;
        this.analyser.smoothingTimeConstant = 0.05;
        src.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);
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
        this.analyser.getByteFrequencyData(this.rawData);
        let sum = 0;
        for (let i = 0; i < this.rawData.length; i++) sum += this.rawData[i];
        if (sum > 200) {
          for (let i = 0; i < this.binCount; i++) {
            const r = this.rawData[i] / 255;
            this.smoothed[i] += (r - this.smoothed[i]) * SMOOTH;
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
          (Math.max(0, Math.min(1, v)) - this.smoothed[i]) * AMBIENT_SMOOTH;
      }
    }

    /* ---- history ---- */

    _updateHistory() {
      for (let b = 0; b < BANDS; b++) {
        const [lo, hi] = this.bandBinMap[b];
        let s = 0;
        for (let j = lo; j < hi && j < this.binCount; j++) s += this.smoothed[j];
        const raw = s / (hi - lo);

        this.bandAvg[b] += (raw - this.bandAvg[b]) * 0.003;

        if (raw > this.bandPeak[b]) this.bandPeak[b] = raw;
        else this.bandPeak[b] += (raw - this.bandPeak[b]) * 0.003;

        const floor = this.bandAvg[b] * 0.92;
        const range = Math.max(this.bandPeak[b] - floor, 0.01);
        const norm = Math.min(1, Math.max(0, (raw - floor) / range));

        if (norm > this.bandDisplay[b]) {
          this.bandDisplay[b] = norm;
        } else {
          this.bandDisplay[b] *= 0.55;
        }

        this.history[b][this.writeCol] = this.bandDisplay[b];
      }
      this.writeCol = (this.writeCol + 1) % HIST_W;
    }

    /* ---- build 3D ridges ---- */

    _buildRidges() {
      this.ridgeLines = [];

      for (let b = 0; b < BANDS; b++) {
        const positions = new Float32Array(HIST_W * 3);
        const z = -CHART_DEPTH / 2 + (b / (BANDS - 1)) * CHART_DEPTH;

        for (let i = 0; i < HIST_W; i++) {
          positions[i * 3] = -CHART_WIDTH / 2 + (i / (HIST_W - 1)) * CHART_WIDTH;
          positions[i * 3 + 1] = 0;
          positions[i * 3 + 2] = z;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.LineBasicMaterial({
          color: 0xffffff,
          linewidth: 1,
          transparent: true,
          opacity: 0.9,
        });

        const line = new THREE.Line(geo, mat);
        this.ridgeScene.add(line);
        this.ridgeLines.push({ line, geo, z });
      }
    }

    _updateRidges() {
      for (let b = 0; b < BANDS; b++) {
        const posAttr = this.ridgeLines[b].geo.getAttribute("position");
        const arr = posAttr.array;

        for (let i = 0; i < HIST_W; i++) {
          const histIdx = (this.writeCol + i) % HIST_W;
          const amp = this.history[b][histIdx];
          arr[i * 3 + 1] = amp * PEAK_HEIGHT;
        }

        posAttr.needsUpdate = true;
      }
    }

    /* ---- bokeh ---- */

    _buildBokeh() {
      const geo = new THREE.PlaneGeometry(1, 1);
      for (let i = 0; i < BOKEH_COUNT; i++) {
        const bHz = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, Math.random());
        const [cr, cg, cb] = hzToRGB(bHz);
        const baseAlpha = rand(0.008, 0.06);
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uAlpha: { value: baseAlpha },
            uColor: { value: new THREE.Vector3(cr * 0.4, cg * 0.4, cb * 0.4) },
          },
          vertexShader: bokehVert,
          fragmentShader: bokehFrag,
          transparent: true,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        const sz = rand(0.15, 1.3);
        mesh.scale.set(sz, sz, 1);
        const d = {
          mesh, baseAlpha, sz,
          baseX: rand(-2.2, 2.2),
          baseY: rand(-1.1, 1.1),
          phase: rand(0, Math.PI * 2),
          sX: rand(0.05, 0.25) * (Math.random() < 0.5 ? -1 : 1),
          sY: rand(0.04, 0.18) * (Math.random() < 0.5 ? -1 : 1),
          drift: rand(0.03, 0.15),
        };
        mesh.position.set(d.baseX, d.baseY, 0);
        this.bokehScene.add(mesh);
        this.bokeh.push(d);
      }
    }

    _updBokeh() {
      let en = 0;
      for (let b = 0; b < BANDS; b++) en += this.bandDisplay[b];
      en /= BANDS;
      this.bokeh.forEach((b) => {
        b.mesh.position.x =
          b.baseX + Math.sin(this.time * b.sX + b.phase) * b.drift;
        b.mesh.position.y =
          b.baseY + Math.cos(this.time * b.sY + b.phase * 1.3) * b.drift;
        const s = b.sz * (1 + en * 0.25);
        b.mesh.scale.set(s, s, 1);
        b.mesh.material.uniforms.uAlpha.value = b.baseAlpha + en * 0.02;
      });
    }

    /* ---- camera orbit ---- */

    _updateCamera() {
      const angle = this.time * ORBIT_SPEED;
      this.ridgeCam.position.set(
        Math.sin(angle) * ORBIT_RADIUS,
        ORBIT_HEIGHT,
        Math.cos(angle) * ORBIT_RADIUS
      );
      this.ridgeCam.lookAt(0, 0.5, 0);
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
      this._updBokeh();
      this._updateCamera();

      this.renderer.clear();
      this.renderer.render(this.bokehScene, this.bokehCam);
      this.renderer.render(this.ridgeScene, this.ridgeCam);
    }
  }

  /* ===== Bootstrap ===== */
  const canvas = document.getElementById("visualizer-canvas");
  if (!canvas) return;

  const viz = new Visualizer(canvas);

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
