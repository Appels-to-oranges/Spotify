(function () {
  "use strict";

  if (typeof THREE === "undefined") return;

  const BOKEH_COUNT = 24;
  const PARTICLE_COUNT = 80;
  const SMOOTH = 0.14;
  const AMBIENT_SMOOTH = 0.06;

  const PALETTE = [
    0xd4622b, 0xe8a951, 0xc73e3a, 0xe07a5f, 0xf4a261, 0x81b29a, 0xf5e6cc,
  ];

  const BOKEH_COLORS = PALETTE.map((c) => new THREE.Color(c));

  /* ========== Shaders ========== */

  const bokehVert = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

  const bokehFrag = `
    uniform vec3 uColor;
    uniform float uAlpha;
    varying vec2 vUv;
    void main() {
      float d = length(vUv - 0.5) * 2.0;
      float a = 1.0 - smoothstep(0.0, 1.0, d);
      a = pow(a, 2.2);
      gl_FragColor = vec4(uColor, a * uAlpha);
    }`;

  /* ========== Helpers ========== */

  function circleTexture(sz) {
    const c = document.createElement("canvas");
    c.width = c.height = sz || 64;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(
      sz / 2, sz / 2, 0,
      sz / 2, sz / 2, sz / 2
    );
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.2, "rgba(255,255,255,0.6)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sz, sz);
    return new THREE.CanvasTexture(c);
  }

  function rand(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  /* ========== Visualizer ========== */

  class Visualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      this.camera.position.z = 5;

      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
      });
      this.renderer.setClearColor(0x0a0a0f, 1);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      this.audioCtx = null;
      this.analyser = null;
      this.sourceNode = null;
      this.rawData = null;
      this.smoothed = new Float32Array(128);
      this.connected = false;
      this.hasRealData = false;
      this.zeroFrames = 0;
      this.isPlaying = false;

      this.time = 0;
      this.lastTime = performance.now() / 1000;
      this.aspect = 1;

      this.bokeh = [];
      this.rings = [];
      this.centerOrb = null;
      this.particles = null;
      this.pData = [];

      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._buildBokeh();
      this._buildRings();
      this._buildOrb();
      this._buildParticles();
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

    /* ----- audio connection ----- */
    connectAudio(el) {
      if (this.connected) return;
      try {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.sourceNode = this.audioCtx.createMediaElementSource(el);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.8;
        this.sourceNode.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);
        this.rawData = new Uint8Array(this.analyser.frequencyBinCount);
        this.connected = true;
      } catch (e) {
        console.warn("Visualizer: audio connect failed", e);
      }
    }

    resumeCtx() {
      if (this.audioCtx && this.audioCtx.state === "suspended") {
        this.audioCtx.resume();
      }
    }

    /* ----- frequency data ----- */
    _freq() {
      if (this.connected && this.analyser && this.isPlaying) {
        this.analyser.getByteFrequencyData(this.rawData);
        let sum = 0;
        for (let i = 0; i < this.rawData.length; i++) sum += this.rawData[i];
        if (sum > 200) {
          this.hasRealData = true;
          this.zeroFrames = 0;
          for (let i = 0; i < 128; i++) {
            const r = this.rawData[i] / 255;
            this.smoothed[i] += (r - this.smoothed[i]) * SMOOTH;
          }
          return;
        }
        this.zeroFrames++;
        if (this.zeroFrames > 60) this.hasRealData = false;
      }

      // Ambient fallback — always runs, stronger when playing
      const t = this.time;
      const boost = this.isPlaying ? 1.8 : 1.0;
      for (let i = 0; i < 128; i++) {
        const f = i / 128;
        const fall = Math.pow(1 - f, 1.4);
        const v =
          (0.35 +
            Math.sin(t * 0.5 + f * 4.5) * 0.2 +
            Math.sin(t * 0.8 + f * 9 + 1.4) * 0.15 +
            Math.sin(t * 0.3 + f * 2.5 - 0.8) * 0.12 +
            Math.cos(t * 1.2) * 0.1 * (1 - f) +
            Math.sin(t * 0.15 + f * 1.5) * 0.08) *
          fall *
          boost;
        const target = Math.max(0, Math.min(1, v));
        this.smoothed[i] += (target - this.smoothed[i]) * AMBIENT_SMOOTH;
      }
    }

    _band(lo, hi) {
      let s = 0;
      for (let i = lo; i < hi; i++) s += this.smoothed[i];
      return s / (hi - lo);
    }

    /* ----- build layers ----- */

    _buildBokeh() {
      const geo = new THREE.PlaneGeometry(1, 1);
      for (let i = 0; i < BOKEH_COUNT; i++) {
        const col = BOKEH_COLORS[i % BOKEH_COLORS.length].clone();
        const baseAlpha = rand(0.06, 0.16);
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: col },
            uAlpha: { value: baseAlpha },
          },
          vertexShader: bokehVert,
          fragmentShader: bokehFrag,
          transparent: true,
          depthWrite: false,
        });

        const mesh = new THREE.Mesh(geo, mat);
        const sz = rand(0.3, 0.85);
        mesh.scale.set(sz, sz, 1);

        const d = {
          mesh,
          baseX: rand(-1.6, 1.6),
          baseY: rand(-0.95, 0.95),
          sz,
          baseAlpha,
          phase: rand(0, Math.PI * 2),
          sX: rand(0.3, 0.8) * (Math.random() < 0.5 ? -1 : 1),
          sY: rand(0.2, 0.6) * (Math.random() < 0.5 ? -1 : 1),
          drift: rand(0.08, 0.3),
        };
        mesh.position.set(d.baseX, d.baseY, 0);
        this.scene.add(mesh);
        this.bokeh.push(d);
      }
    }

    _buildRings() {
      const defs = [
        { r: 0.1, th: 0.004, arc: Math.PI * 2, spd: 0.2 },
        { r: 0.2, th: 0.005, arc: Math.PI * 1.5, spd: -0.15 },
        { r: 0.31, th: 0.004, arc: Math.PI * 1.7, spd: 0.12 },
        { r: 0.43, th: 0.006, arc: Math.PI * 1.3, spd: -0.18 },
        { r: 0.56, th: 0.005, arc: Math.PI * 1.8, spd: 0.1 },
        { r: 0.7, th: 0.005, arc: Math.PI * 1.5, spd: -0.08 },
      ];
      const bands = [
        [0, 5],
        [5, 14],
        [14, 32],
        [32, 58],
        [58, 90],
        [90, 128],
      ];

      defs.forEach((d, i) => {
        const geo = new THREE.RingGeometry(d.r, d.r + d.th, 128, 1, 0, d.arc);
        const mat = new THREE.MeshBasicMaterial({
          color: PALETTE[i % PALETTE.length],
          transparent: true,
          opacity: 0.08,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = 0.1;
        mesh.rotation.z = rand(0, Math.PI * 2);
        this.scene.add(mesh);
        this.rings.push({
          mesh,
          mat,
          baseR: d.r,
          spd: d.spd,
          lo: bands[i][0],
          hi: bands[i][1],
        });
      });
    }

    _buildOrb() {
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xf5e6cc) },
          uAlpha: { value: 0.1 },
        },
        vertexShader: bokehVert,
        fragmentShader: bokehFrag,
        transparent: true,
        depthWrite: false,
      });
      this.centerOrb = new THREE.Mesh(geo, mat);
      this.centerOrb.scale.set(0.18, 0.18, 1);
      this.centerOrb.position.z = 0.05;
      this.scene.add(this.centerOrb);
    }

    _buildParticles() {
      const pos = new Float32Array(PARTICLE_COUNT * 3);
      this.pData = [];
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const a = rand(0, Math.PI * 2);
        const dist = rand(0.02, 0.8);
        pos[i * 3] = Math.cos(a) * dist;
        pos[i * 3 + 1] = Math.sin(a) * dist;
        pos[i * 3 + 2] = 0.15;
        this.pData.push({ a, dist, spd: rand(0.02, 0.06) });
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        size: 3,
        color: 0xf5e6cc,
        transparent: true,
        opacity: 0.35,
        map: circleTexture(64),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: false,
      });
      this.particles = new THREE.Points(geo, mat);
      this.scene.add(this.particles);
    }

    /* ----- update layers ----- */

    _updBokeh(dt) {
      const bass = this._band(0, 14);
      const en = this._band(0, 64);
      this.bokeh.forEach((b) => {
        b.mesh.position.x =
          b.baseX + Math.sin(this.time * b.sX + b.phase) * b.drift;
        b.mesh.position.y =
          b.baseY + Math.cos(this.time * b.sY + b.phase * 1.3) * b.drift;
        const s = b.sz * (1 + bass * 0.5);
        b.mesh.scale.set(s, s, 1);
        b.mesh.material.uniforms.uAlpha.value = b.baseAlpha + en * 0.12;
      });
    }

    _updRings(dt) {
      this.rings.forEach((r) => {
        const en = this._band(r.lo, r.hi);
        r.mesh.rotation.z += r.spd * dt;
        const sc = 1 + en * 0.35;
        r.mesh.scale.set(sc, sc, 1);
        r.mat.opacity = 0.06 + en * 0.7;
      });
    }

    _updOrb() {
      const en = this._band(0, 50);
      const s = 0.15 + en * 0.35;
      this.centerOrb.scale.set(s, s, 1);
      this.centerOrb.material.uniforms.uAlpha.value = 0.08 + en * 0.25;
    }

    _updParticles(dt) {
      const treble = this._band(64, 128);
      const en = this._band(0, 128);
      const arr = this.particles.geometry.attributes.position.array;
      this.pData.forEach((p, i) => {
        p.dist += p.spd * (0.4 + treble * 3.0) * dt;
        if (p.dist > 1.4) {
          p.dist = rand(0.01, 0.05);
          p.a = rand(0, Math.PI * 2);
        }
        arr[i * 3] = Math.cos(p.a) * p.dist;
        arr[i * 3 + 1] = Math.sin(p.a) * p.dist;
      });
      this.particles.geometry.attributes.position.needsUpdate = true;
      this.particles.material.opacity = 0.2 + en * 0.6;
    }

    /* ----- render loop ----- */
    _loop() {
      requestAnimationFrame(() => this._loop());
      const now = performance.now() / 1000;
      const dt = Math.min(now - this.lastTime, 0.06);
      this.lastTime = now;
      this.time += dt;

      this._freq();
      this._updBokeh(dt);
      this._updRings(dt);
      this._updOrb();
      this._updParticles(dt);
      this.renderer.render(this.scene, this.camera);
    }
  }

  /* ========== Bootstrap ========== */

  const canvas = document.getElementById("visualizer-canvas");
  if (!canvas) return;

  const viz = new Visualizer(canvas);

  function hookAudio() {
    const audio = window.__wsAudio;
    if (!audio) {
      requestAnimationFrame(hookAudio);
      return;
    }

    const connect = () => {
      viz.connectAudio(audio);
      viz.resumeCtx();
      viz.isPlaying = true;
    };

    audio.addEventListener("play", connect);
    audio.addEventListener("pause", () => {
      viz.isPlaying = false;
    });

    if (!audio.paused) connect();
  }
  hookAudio();
})();
