(function () {
  "use strict";

  if (typeof THREE === "undefined") return;

  /* ===== Config ===== */
  const BANDS = 40;
  const HIST_W = 280;
  const BOKEH_COUNT = 18;
  const FFT_SIZE = 2048;
  const FREQ_LO = 30;
  const FREQ_HI = 18000;
  const NM_RED = 780;
  const NM_VIOLET = 380;
  const SMOOTH = 1.0;
  const AMBIENT_SMOOTH = 0.04;

  /* ===== Hz → nm → RGB ===== */

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

  /* ===== Color-map texture (256×1) ===== */

  function buildColorMap() {
    const d = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const [r, g, b] = hzToRGB(FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, t));
      d[i * 4] = Math.round(r * 255);
      d[i * 4 + 1] = Math.round(g * 255);
      d[i * 4 + 2] = Math.round(b * 255);
      d[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(d, 256, 1, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /* ===== Shaders ===== */

  const quadVert = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

  const specFrag = [
    "#define BANDS 40",
    "precision highp float;",
    "uniform sampler2D uHistory;",
    "uniform sampler2D uColors;",
    "uniform float uWritePos;",
    "varying vec2 vUv;",
    "",
    "void main() {",
    "  float y = (vUv.y - 0.5) * 2.0;",
    "  float slotH = 2.0 / float(BANDS);",
    "  float bandH = slotH * 0.85;",
    "  int slot = int(floor((y + 1.0) / slotH));",
    "",
    "  vec3 acc = vec3(0.0);",
    "  float occlude = 0.0;",
    "",
    "  float histX = mod(vUv.x + uWritePos, 1.0);",
    "",
    "  for (int di = -4; di <= 4; di++) {",
    "    int idx = slot + di;",
    "    if (idx < 0 || idx >= BANDS) continue;",
    "",
    "    float ft = (float(idx) + 0.5) / float(BANDS);",
    "    vec3 col = texture2D(uColors, vec2(ft, 0.5)).rgb;",
    "",
    "    float bandBase = -1.0 + float(idx) * slotH;",
    "    float bandT = (float(idx) + 0.5) / float(BANDS);",
    "    float amp = texture2D(uHistory, vec2(histX, bandT)).r;",
    "",
    "    float ridgeY = bandBase + amp * slotH * 3.0;",
    "    float dist = y - ridgeY;",
    "",
    "    float glow = exp(-dist * dist / 0.00005);",
    "",
    "    float fill = 0.0;",
    "    if (y >= bandBase && y < ridgeY) {",
    "      fill = smoothstep(bandBase, ridgeY, y) * 0.25;",
    "    }",
    "",
    "    acc += col * (glow * 2.5 + fill);",
    "",
    "    if (idx < slot && y < ridgeY) {",
    "      occlude = max(occlude, smoothstep(ridgeY, bandBase, y) * 0.8);",
    "    }",
    "  }",
    "",
    "  vec3 result = vec3(0.039) + acc;",
    "  result *= 1.0 - occlude;",
    "  gl_FragColor = vec4(result, 1.0);",
    "}",
  ].join("\n");

  const bokehVert = quadVert;

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
      this.bokehCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      this.bokehCam.position.z = 5;
      this.lineCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.lineCam.position.z = 0.5;

      this.bokehScene = new THREE.Scene();
      this.lineScene = new THREE.Scene();

      this.audioCtx = null;
      this.analyser = null;
      this.rawData = null;
      this.sampleRate = 44100;
      this.binCount = FFT_SIZE / 2;
      this.smoothed = new Float32Array(this.binCount);
      this.connected = false;
      this.isPlaying = false;

      /*  Per-band adaptive tracking:
       *  bandAvg  — slow-moving average (the "flat" baseline)
       *  bandPeak — slow-decaying ceiling
       *  bandDisplay — fast-attack / slow-decay output for history  */
      this.bandAvg = new Float32Array(BANDS).fill(0.15);
      this.bandPeak = new Float32Array(BANDS).fill(0.3);
      this.bandDisplay = new Float32Array(BANDS);
      this.bandBinMap = [];

      this.time = 0;
      this.lastTime = performance.now() / 1000;
      this.bokeh = [];

      this.histPixels = new Uint8Array(HIST_W * BANDS * 4);
      this.histTex = new THREE.DataTexture(
        this.histPixels, HIST_W, BANDS, THREE.RGBAFormat
      );
      this.histTex.magFilter = THREE.LinearFilter;
      this.histTex.minFilter = THREE.LinearFilter;
      this.histTex.wrapS = THREE.RepeatWrapping;
      this.histTex.wrapT = THREE.ClampToEdgeWrapping;
      this.histTex.needsUpdate = true;
      this.writeCol = 0;

      this.colorMap = buildColorMap();

      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._buildBandMap(this.sampleRate);
      this._buildBokeh();
      this._buildQuad();
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

    /* ---- history with per-band normalization ---- */

    _updateHistory() {
      for (let b = 0; b < BANDS; b++) {
        const [lo, hi] = this.bandBinMap[b];
        let s = 0;
        for (let j = lo; j < hi && j < this.binCount; j++) s += this.smoothed[j];
        const raw = s / (hi - lo);

        /* Adaptive baseline: very slow EMA (~8s to converge).
         * This represents the band's "resting" energy level.   */
        this.bandAvg[b] += (raw - this.bandAvg[b]) * 0.003;

        /* Adaptive ceiling: instant rise, very slow decay.     */
        if (raw > this.bandPeak[b]) this.bandPeak[b] = raw;
        else this.bandPeak[b] += (raw - this.bandPeak[b]) * 0.0008;

        const floor = this.bandAvg[b] * 0.92;
        const range = Math.max(this.bandPeak[b] - floor, 0.01);
        const norm = Math.min(1, Math.max(0, (raw - floor) / range));

        if (norm > this.bandDisplay[b]) {
          this.bandDisplay[b] = norm;
        } else {
          this.bandDisplay[b] *= 0.55;
        }

        const v = Math.min(255, Math.round(this.bandDisplay[b] * 255));
        const idx = (b * HIST_W + this.writeCol) * 4;
        this.histPixels[idx] = v;
        this.histPixels[idx + 1] = v;
        this.histPixels[idx + 2] = v;
        this.histPixels[idx + 3] = 255;
      }
      this.writeCol = (this.writeCol + 1) % HIST_W;
      this.histTex.needsUpdate = true;
    }

    /* ---- build ---- */

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

    _buildQuad() {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uHistory: { value: this.histTex },
          uColors: { value: this.colorMap },
          uWritePos: { value: 0 },
        },
        vertexShader: quadVert,
        fragmentShader: specFrag,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.lineQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      this.lineScene.add(this.lineQuad);
    }

    /* ---- update ---- */

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

    /* ---- loop ---- */

    _loop() {
      requestAnimationFrame(() => this._loop());
      const now = performance.now() / 1000;
      const dt = Math.min(now - this.lastTime, 0.06);
      this.lastTime = now;
      this.time += dt;

      this._freq();
      this._updateHistory();
      this._updBokeh();

      this.lineQuad.material.uniforms.uWritePos.value = this.writeCol / HIST_W;

      this.renderer.clear();
      this.renderer.render(this.bokehScene, this.bokehCam);
      this.renderer.render(this.lineScene, this.lineCam);
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
