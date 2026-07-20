(function () {
  "use strict";

  if (typeof THREE === "undefined") return;

  /* ===== Config ===== */
  const LINE_COUNT = 128;
  const BOKEH_COUNT = 22;
  const FFT_SIZE = 2048;
  const TEX_W = 256;
  const FREQ_LO = 30;
  const FREQ_HI = 18000;
  const NM_RED = 780;
  const NM_VIOLET = 380;
  const SMOOTH = 0.18;
  const AMBIENT_SMOOTH = 0.05;
  const DECAY = 0.06;

  /* ===== Hz → nm → RGB =====
   *
   *   λ(nm) = 780 − 400 · log(f / 30) / log(600)
   *
   *   30 Hz  → 780 nm  (red)        →  bottom of canvas
   *   18 kHz → 380 nm  (violet)     →  top of canvas
   */

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

  /* ===== Static color-map texture (256×1) ===== */

  function buildColorMap() {
    const data = new Uint8Array(TEX_W * 4);
    for (let i = 0; i < TEX_W; i++) {
      const t = i / (TEX_W - 1);
      const hz = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, t);
      const [r, g, b] = hzToRGB(hz);
      data[i * 4]     = Math.round(r * 255);
      data[i * 4 + 1] = Math.round(g * 255);
      data[i * 4 + 2] = Math.round(b * 255);
      data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, TEX_W, 1, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /* ===== Shaders ===== */

  const lineVert = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

  /*  128 horizontal lines stacked bottom (bass/red) → top (treble/violet).
   *  Each line spans the full width and bends vertically with amplitude.
   *  Per-pixel: find the nearest lines, compute distance with bend offset,
   *  apply gaussian glow and spectral colour.                              */
  const lineFrag = [
    "#define LC 128",
    "#define PI 3.14159265",
    "precision highp float;",
    "uniform sampler2D uFreq;",
    "uniform sampler2D uColors;",
    "uniform float uTime;",
    "uniform float uAspect;",
    "varying vec2 vUv;",
    "",
    "void main() {",
    "  vec2 p = vec2((vUv.x - 0.5) * 2.0 * uAspect, (vUv.y - 0.5) * 2.0);",
    "  float sp = 2.0 / float(LC);",
    "  int ctr = int(floor((p.y + 1.0) / sp));",
    "  vec3 col = vec3(0.0);",
    "",
    "  for (int di = -4; di <= 4; di++) {",
    "    int idx = ctr + di;",
    "    if (idx < 0 || idx >= LC) continue;",
    "    float ft = (float(idx) + 0.5) / float(LC);",
    "    float amp = texture2D(uFreq, vec2(ft, 0.5)).r;",
    "    vec3  c   = texture2D(uColors, vec2(ft, 0.5)).rgb;",
    "",
    "    float baseY = -1.0 + sp * (float(idx) + 0.5);",
    "",
    "    float nx = p.x / uAspect;",
    "    float ph = ft * 7.0;",
    "    float t  = uTime;",
    "    float bend = 0.0;",
    "    bend += sin(nx * PI * 1.5 + t * 0.55 + ph)        * 0.014;",
    "    bend += sin(nx * PI * 3.8 + t * 1.05 + ph * 1.7)  * 0.007;",
    "    bend += sin(nx * PI * 0.6 + t * 0.25 + ph * 0.4)  * 0.010;",
    "    bend *= amp * (1.0 + amp * 2.5);",
    "",
    "    float lineY = baseY + bend;",
    "    float d = abs(p.y - lineY);",
    "",
    "    float bw = sp * (0.12 + 0.08 * (1.0 - ft));",
    "    float w  = bw * (1.0 + amp * 3.5);",
    "    float glow = exp(-d * d / (w * w));",
    "    float br = amp * (1.8 + amp * 1.2);",
    "    col += c * glow * br;",
    "  }",
    "  gl_FragColor = vec4(col, 1.0);",
    "}",
  ].join("\n");

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

      /* renderer */
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      this.renderer.setClearColor(0x0a0a0a, 1);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.autoClear = false;

      /* cameras */
      this.aspect = 1;
      this.bokehCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      this.bokehCam.position.z = 5;
      this.lineCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.lineCam.position.z = 0.5;

      /* scenes */
      this.bokehScene = new THREE.Scene();
      this.lineScene = new THREE.Scene();

      /* audio */
      this.audioCtx = null;
      this.analyser = null;
      this.rawData = null;
      this.sampleRate = 44100;
      this.binCount = FFT_SIZE / 2;
      this.smoothed = new Float32Array(this.binCount);
      this.connected = false;
      this.isPlaying = false;

      /* display */
      this.displayAmp = new Float32Array(TEX_W);
      this.texBinMap = [];
      this.time = 0;
      this.lastTime = performance.now() / 1000;
      this.bokeh = [];

      /* textures */
      this.freqPixels = new Uint8Array(TEX_W * 4);
      this.freqTex = new THREE.DataTexture(this.freqPixels, TEX_W, 1, THREE.RGBAFormat);
      this.freqTex.magFilter = THREE.LinearFilter;
      this.freqTex.minFilter = THREE.LinearFilter;
      this.colorMap = buildColorMap();

      /* build */
      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._buildBinMap(this.sampleRate);
      this._buildBokeh();
      this._buildLineQuad();
      this._loop();
    }

    /* ---- layout ---- */

    _resize() {
      const p = this.canvas.parentElement;
      const w = p.clientWidth;
      const h = p.clientHeight;
      this.aspect = w / h;
      this.renderer.setSize(w, h);
      this.bokehCam.left = -this.aspect;
      this.bokehCam.right = this.aspect;
      this.bokehCam.updateProjectionMatrix();
      if (this.lineQuad)
        this.lineQuad.material.uniforms.uAspect.value = this.aspect;
    }

    _buildBinMap(sr) {
      this.sampleRate = sr;
      const hzPerBin = sr / FFT_SIZE;
      this.texBinMap = [];
      for (let i = 0; i < TEX_W; i++) {
        const f0 = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, i / TEX_W);
        const f1 = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, (i + 1) / TEX_W);
        const b0 = Math.max(0, Math.floor(f0 / hzPerBin));
        const b1 = Math.min(this.binCount, Math.max(Math.ceil(f1 / hzPerBin), b0 + 1));
        this.texBinMap.push([b0, b1]);
      }
    }

    /* ---- audio ---- */

    connectAudio(el) {
      if (this.connected) return;
      try {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this._buildBinMap(this.audioCtx.sampleRate);
        const src = this.audioCtx.createMediaElementSource(el);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = FFT_SIZE;
        this.analyser.smoothingTimeConstant = 0.75;
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
      const boost = this.isPlaying ? 1.4 : 0.6;
      for (let i = 0; i < this.binCount; i++) {
        const f = i / this.binCount;
        const fall = Math.pow(1 - f, 1.6);
        const v =
          (0.18 +
            Math.sin(t * 0.45 + f * 5.5) * 0.12 +
            Math.sin(t * 0.75 + f * 11 + 1.2) * 0.09 +
            Math.cos(t * 1.1) * 0.07 * (1 - f)) *
          fall * boost;
        this.smoothed[i] += (Math.max(0, Math.min(1, v)) - this.smoothed[i]) * AMBIENT_SMOOTH;
      }
    }

    _updateFreqTex() {
      for (let i = 0; i < TEX_W; i++) {
        const [lo, hi] = this.texBinMap[i];
        let s = 0;
        for (let j = lo; j < hi && j < this.binCount; j++) s += this.smoothed[j];
        const amp = s / (hi - lo);
        if (amp > this.displayAmp[i]) this.displayAmp[i] = amp;
        else this.displayAmp[i] += (amp - this.displayAmp[i]) * DECAY;
        const v = Math.min(255, Math.round(this.displayAmp[i] * 255));
        this.freqPixels[i * 4]     = v;
        this.freqPixels[i * 4 + 1] = v;
        this.freqPixels[i * 4 + 2] = v;
        this.freqPixels[i * 4 + 3] = 255;
      }
      this.freqTex.needsUpdate = true;
    }

    /* ---- build ---- */

    _buildBokeh() {
      const geo = new THREE.PlaneGeometry(1, 1);
      for (let i = 0; i < BOKEH_COUNT; i++) {
        const bHz = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, Math.random());
        const [cr, cg, cb] = hzToRGB(bHz);
        const baseAlpha = rand(0.01, 0.09);
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uAlpha: { value: baseAlpha },
            uColor: { value: new THREE.Vector3(cr * 0.5, cg * 0.5, cb * 0.5) },
          },
          vertexShader: bokehVert,
          fragmentShader: bokehFrag,
          transparent: true,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        const sz = rand(0.15, 1.4);
        mesh.scale.set(sz, sz, 1);
        const d = {
          mesh, baseAlpha, sz,
          baseX: rand(-2.2, 2.2),
          baseY: rand(-1.1, 1.1),
          phase: rand(0, Math.PI * 2),
          sX: rand(0.06, 0.3) * (Math.random() < 0.5 ? -1 : 1),
          sY: rand(0.05, 0.2) * (Math.random() < 0.5 ? -1 : 1),
          drift: rand(0.04, 0.18),
        };
        mesh.position.set(d.baseX, d.baseY, 0);
        this.bokehScene.add(mesh);
        this.bokeh.push(d);
      }
    }

    _buildLineQuad() {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uFreq: { value: this.freqTex },
          uColors: { value: this.colorMap },
          uTime: { value: 0 },
          uAspect: { value: this.aspect },
        },
        vertexShader: lineVert,
        fragmentShader: lineFrag,
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
      for (let i = 0; i < TEX_W; i++) en += this.displayAmp[i];
      en /= TEX_W;
      this.bokeh.forEach((b) => {
        b.mesh.position.x = b.baseX + Math.sin(this.time * b.sX + b.phase) * b.drift;
        b.mesh.position.y = b.baseY + Math.cos(this.time * b.sY + b.phase * 1.3) * b.drift;
        const s = b.sz * (1 + en * 0.3);
        b.mesh.scale.set(s, s, 1);
        b.mesh.material.uniforms.uAlpha.value = b.baseAlpha + en * 0.03;
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
      this._updateFreqTex();
      this._updBokeh();

      this.lineQuad.material.uniforms.uTime.value = this.time;

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
    if (!audio) { requestAnimationFrame(hookAudio); return; }
    audio.addEventListener("play", () => {
      viz.connectAudio(audio);
      viz.resumeCtx();
      viz.isPlaying = true;
    });
    audio.addEventListener("pause", () => { viz.isPlaying = false; });
    if (!audio.paused) {
      viz.connectAudio(audio);
      viz.resumeCtx();
      viz.isPlaying = true;
    }
  }
  hookAudio();
})();
