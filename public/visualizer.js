(function () {
  "use strict";

  if (typeof THREE === "undefined") return;

  /* ===== Config ===== */
  const BAR_COUNT = 160;
  const BOKEH_COUNT = 28;
  const FFT_SIZE = 2048;
  const SMOOTH = 0.18;
  const AMBIENT_SMOOTH = 0.05;
  const DECAY = 0.06;
  const FREQ_LO = 30;
  const FREQ_HI = 18000;
  const NM_RED = 780;
  const NM_VIOLET = 380;

  /* ===== Hz ↔ Wavelength ↔ RGB =====
   *
   *  Unified formula mapping audio frequency to light wavelength:
   *
   *    λ(nm) = 780 − 400 · log(f / 30) / log(600)
   *
   *  30 Hz  → 780 nm  (deep red)
   *  18 kHz → 380 nm  (violet)
   *
   *  Logarithmic scaling matches musical pitch perception (equal
   *  visual distance per octave).  The nm→RGB step uses the CIE
   *  spectral locus piecewise approximation (Bruton).
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

  /* ===== Shaders ===== */

  const barVert = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

  const barFrag = `
    uniform float uOpacity;
    uniform float uSoftness;
    uniform vec3  uColor;
    varying vec2 vUv;
    void main() {
      float dx = abs(vUv.x - 0.5) * 2.0;
      float a = 1.0 - smoothstep(1.0 - uSoftness, 1.0, dx);
      float dy = vUv.y;
      a *= 1.0 - smoothstep(0.7, 1.0, dy);
      gl_FragColor = vec4(uColor, a * uOpacity);
    }`;

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
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      this.camera.position.z = 5;

      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      this.renderer.setClearColor(0x0a0a0a, 1);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      this.audioCtx = null;
      this.analyser = null;
      this.rawData = null;
      this.sampleRate = 44100;
      this.binCount = FFT_SIZE / 2;
      this.smoothed = new Float32Array(this.binCount);
      this.connected = false;
      this.isPlaying = false;

      this.time = 0;
      this.lastTime = performance.now() / 1000;
      this.aspect = 1;

      this.bokeh = [];
      this.bars = [];
      this.binMap = [];
      this.barHz = new Float32Array(BAR_COUNT);
      this.displayAmp = new Float32Array(BAR_COUNT);

      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._buildBinMap(this.sampleRate);
      this._buildBokeh();
      this._buildBars();
      this._loop();
    }

    _resize() {
      const p = this.canvas.parentElement;
      const w = p.clientWidth;
      const h = p.clientHeight;
      this.aspect = w / h;
      this.renderer.setSize(w, h);
      this.camera.left = -this.aspect;
      this.camera.right = this.aspect;
      this.camera.top = 1;
      this.camera.bottom = -1;
      this.camera.updateProjectionMatrix();
    }

    _buildBinMap(sr) {
      this.sampleRate = sr;
      const hzPerBin = sr / FFT_SIZE;
      this.binMap = [];
      for (let i = 0; i < BAR_COUNT; i++) {
        const f0 = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, i / BAR_COUNT);
        const f1 = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, (i + 1) / BAR_COUNT);
        const b0 = Math.max(0, Math.floor(f0 / hzPerBin));
        const b1 = Math.min(this.binCount, Math.max(Math.ceil(f1 / hzPerBin), b0 + 1));
        this.binMap.push([b0, b1]);
        this.barHz[i] = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, (i + 0.5) / BAR_COUNT);
      }
    }

    /* --- audio --- */

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

    /* --- frequency --- */

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
        const target = Math.max(0, Math.min(1, v));
        this.smoothed[i] += (target - this.smoothed[i]) * AMBIENT_SMOOTH;
      }
    }

    _barAmp(idx) {
      const [lo, hi] = this.binMap[idx];
      let s = 0;
      for (let i = lo; i < hi && i < this.binCount; i++) s += this.smoothed[i];
      return s / (hi - lo);
    }

    /* --- build --- */

    _buildBokeh() {
      const geo = new THREE.PlaneGeometry(1, 1);
      for (let i = 0; i < BOKEH_COUNT; i++) {
        const bHz = FREQ_LO * Math.pow(FREQ_HI / FREQ_LO, Math.random());
        const [cr, cg, cb] = hzToRGB(bHz);
        const baseAlpha = rand(0.015, 0.14);
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uAlpha: { value: baseAlpha },
            uColor: { value: new THREE.Vector3(cr * 0.6, cg * 0.6, cb * 0.6) },
          },
          vertexShader: bokehVert,
          fragmentShader: bokehFrag,
          transparent: true,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        const sz = rand(0.12, 1.6);
        mesh.scale.set(sz, sz, 1);
        const d = {
          mesh, baseAlpha, sz,
          baseX: rand(-2.2, 2.2),
          baseY: rand(-1.1, 1.1),
          phase: rand(0, Math.PI * 2),
          sX: rand(0.08, 0.35) * (Math.random() < 0.5 ? -1 : 1),
          sY: rand(0.06, 0.25) * (Math.random() < 0.5 ? -1 : 1),
          drift: rand(0.04, 0.2),
        };
        mesh.position.set(d.baseX, d.baseY, -0.1);
        this.scene.add(mesh);
        this.bokeh.push(d);
      }
    }

    _buildBars() {
      const sharedGeo = new THREE.PlaneGeometry(1, 1);
      for (let i = 0; i < BAR_COUNT; i++) {
        const freq = i / BAR_COUNT;
        const hz = this.barHz[i];
        const [cr, cg, cb] = hzToRGB(hz);

        const softness = 0.55 * (1 - freq * 0.6);
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uOpacity: { value: 0 },
            uSoftness: { value: softness },
            uColor: { value: new THREE.Vector3(cr, cg, cb) },
          },
          vertexShader: barVert,
          fragmentShader: barFrag,
          transparent: true,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(sharedGeo, mat);
        mesh.position.set(0, -1, 0);
        mesh.scale.set(0, 0, 1);
        this.scene.add(mesh);
        this.bars.push({ mesh, mat, freq });
      }
    }

    /* --- update --- */

    _updBokeh() {
      let en = 0;
      for (let i = 0; i < this.binCount; i++) en += this.smoothed[i];
      en /= this.binCount;

      this.bokeh.forEach((b) => {
        b.mesh.position.x = b.baseX + Math.sin(this.time * b.sX + b.phase) * b.drift;
        b.mesh.position.y = b.baseY + Math.cos(this.time * b.sY + b.phase * 1.3) * b.drift;
        const s = b.sz * (1 + en * 0.25);
        b.mesh.scale.set(s, s, 1);
        b.mesh.material.uniforms.uAlpha.value = b.baseAlpha + en * 0.04;
      });
    }

    _updBars() {
      const w = this.aspect * 2;
      const barSpacing = w / BAR_COUNT;

      for (let i = 0; i < BAR_COUNT; i++) {
        const bar = this.bars[i];
        const raw = this._barAmp(i);

        if (raw > this.displayAmp[i]) {
          this.displayAmp[i] = raw;
        } else {
          this.displayAmp[i] += (raw - this.displayAmp[i]) * DECAY;
        }
        const amp = this.displayAmp[i];

        const x = -this.aspect + barSpacing * (i + 0.5);
        bar.mesh.position.x = x;

        const height = amp * 1.9;
        bar.mesh.scale.y = Math.max(0.001, height);
        bar.mesh.position.y = -1 + height * 0.5;

        const baseW = barSpacing * (0.9 - bar.freq * 0.6);
        bar.mesh.scale.x = baseW * (1 + amp * 0.4);

        const opBase = 1 - bar.freq * 0.5;
        bar.mat.uniforms.uOpacity.value = opBase * amp * 2.5;
      }
    }

    /* --- loop --- */

    _loop() {
      requestAnimationFrame(() => this._loop());
      const now = performance.now() / 1000;
      const dt = Math.min(now - this.lastTime, 0.06);
      this.lastTime = now;
      this.time += dt;

      this._freq();
      this._updBokeh();
      this._updBars();
      this.renderer.render(this.scene, this.camera);
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
