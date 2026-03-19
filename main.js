
(function() {
  'use strict';

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    const canvas     = document.querySelector('[data-nw="canvas"]');
    const configEl   = document.querySelector('[data-nw="config"]');
    const canvasWrap = document.querySelector('[data-nw="canvas-wrap"]') || canvas?.parentElement;
    const debugEl    = document.querySelector('[data-nw="debug"]');

    if (!canvas || !configEl) return;

    function attr(name, fallback) {
      const val = configEl.getAttribute('data-nw-' + name);
      if (val === null) return fallback;
      const num = parseFloat(val);
      return isNaN(num) ? val : num;
    }

    const CONFIG = {
      particleCount:     attr('particle-count', 200),
      particleCountEnd:  attr('particle-count-end', 2500),
      particleBaseMult:  attr('particle-size', 300),
      particleSquare:    attr('particle-square', 'false') === 'true',
      sphereRadiusStart: attr('sphere-start', 10),
      sphereRadiusEnd:   attr('sphere-end', 5.5),
      nodeRadiusStart:   attr('node-radius-start', 70),
      bgDark:            new THREE.Color(attr('bg-dark', '#0a1628')),
      bgLight:           new THREE.Color(attr('bg-light', '#ffffff')),
      goldPrimary:       new THREE.Color(attr('color-primary', '#F5A623')).getHex(),
      goldLight:         new THREE.Color(attr('color-light', '#FFD876')).getHex(),
      bluePrimary:       new THREE.Color(attr('color-blue', '#4ABAFE')).getHex(),
      lineOpacityMax:    attr('line-opacity', 0.9),
      lineMaxActive:     attr('line-max', 20),
      lineSeed:          attr('line-seed', 42),
      rotationTurns:     attr('rotation-turns', 1.5),
      bgTrigger:         attr('bg-trigger', 0.12),
      yellowIntroStart:  attr('yellow-intro-start', 0.02),
      blueIntroStart:    attr('blue-intro-start', 0.28),
    };

    const nodeEls = configEl.querySelectorAll('[data-nw="node"]');
    const nodeConfigs = Array.from(nodeEls).map(el => ({
      size:    parseFloat(el.getAttribute('data-nw-node-size')) || null,
      image:   el.querySelector('img')?.src || null,
      type:    el.getAttribute('data-nw-node-type') || null,
      group:   el.getAttribute('data-nw-node-group') || 'yellow',
      initial: el.getAttribute('data-nw-node-initial') === 'true',
    }));
    const NODE_COUNT = Math.max(nodeConfigs.length, 1);

    /* ── Renderer ── */

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    scene.background = CONFIG.bgDark.clone();

    const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 200);
    camera.position.set(0, 0, 16);

    /* ── Seeded RNG ── */

    function mulberry32(seed) {
      let s = seed;
      return function() {
        s |= 0; s = s + 0x6D2B79F5 | 0;
        let t = Math.imul(s ^ s >>> 15, 1 | s);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    const rng  = mulberry32(CONFIG.lineSeed);
    const rng2 = mulberry32(CONFIG.lineSeed + 100);
    const rng3 = mulberry32(CONFIG.lineSeed + 200);

    /* ── Helpers ── */

    function randomInSphere(radius, thickness) {
      const u = Math.random(), v = Math.random(), w = Math.random();
      const theta = 2 * Math.PI * u;
      const phi   = Math.acos(2 * v - 1);
      const minR  = radius * (1 - thickness);
      const r     = minR + (radius - minR) * Math.cbrt(w);
      return new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
      );
    }

    function smoothstep(a, b, x) {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    }

    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

    /* ── Particles ── */

    const COUNT      = Math.max(CONFIG.particleCount, CONFIG.particleCountEnd || CONFIG.particleCount);
    const endScaleY  = attr('end-scale-y', 0.25);
    const startPositions = new Float32Array(COUNT * 3);
    const endPositions   = new Float32Array(COUNT * 3);
    const particleSizes  = new Float32Array(COUNT);
    const particleRandom = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      const sp = randomInSphere(CONFIG.sphereRadiusStart, 0.7);
      startPositions[i*3]   = sp.x; startPositions[i*3+1] = sp.y; startPositions[i*3+2] = sp.z;
      const ep = randomInSphere(CONFIG.sphereRadiusEnd, 0.55);
      endPositions[i*3]   = ep.x;
      endPositions[i*3+1] = ep.y * endScaleY;
      endPositions[i*3+2] = ep.z;
      particleSizes[i]  = 0.08 + Math.random() * 0.25;
      particleRandom[i] = Math.random();
    }

    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position',  new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    particleGeo.setAttribute('aStartPos', new THREE.BufferAttribute(startPositions, 3));
    particleGeo.setAttribute('aEndPos',   new THREE.BufferAttribute(endPositions, 3));
    particleGeo.setAttribute('aSize',     new THREE.BufferAttribute(particleSizes, 1));
    particleGeo.setAttribute('aRandom',   new THREE.BufferAttribute(particleRandom, 1));

    const particleVert = `
      attribute vec3 aStartPos;
      attribute vec3 aEndPos;
      attribute float aSize;
      attribute float aRandom;
      uniform float uProgress;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uBaseMult;
      uniform vec3 uMouse3D;
      uniform float uMouseInfluence;
      uniform float uVisibility;
      varying float vRandom;
      varying float vAlpha;
      varying float vMouseProximity;

      void main() {
        float visible = step(aRandom, uVisibility);
        if (visible < 0.5) {
          gl_PointSize = 0.0;
          gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
          vAlpha = 0.0; vRandom = aRandom; vMouseProximity = 0.0;
          return;
        }

        vec3 pos = mix(aStartPos, aEndPos, uProgress);
        float drift = 1.0 - uProgress;
        pos.x += sin(uTime * 0.4 + aRandom * 40.0) * drift * 0.6;
        pos.y += cos(uTime * 0.35 + aRandom * 30.0) * drift * 0.5;
        pos.z += sin(uTime * 0.3 + aRandom * 50.0) * drift * 0.4;
        pos *= 1.0 + sin(uTime * 0.8 + aRandom * 6.28) * 0.03;

        vec3 toMouse = pos - uMouse3D;
        float mouseDist = length(toMouse);
        float repulse = smoothstep(0.5, 0.0, mouseDist) * uMouseInfluence;
        pos += normalize(toMouse + vec3(0.001)) * repulse * 0.6;

        vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
        float depth = -mvPos.z;
        float size = aSize * uPixelRatio * (uBaseMult / depth);
        float dofFalloff = 1.0 - smoothstep(0.0, 8.0, abs(depth - 16.0));
        size *= 0.5 + dofFalloff * 0.5;
        size *= 1.0 + repulse * 0.5;
        gl_PointSize = max(size, 1.0);
        gl_Position = projectionMatrix * mvPos;

        vRandom = aRandom;
        vMouseProximity = repulse;
        vAlpha = 1.0;
      }
    `;

    const particleFragCircle = `
      uniform vec3 uColorInner;
      uniform vec3 uColorOuter;
      varying float vRandom;
      varying float vAlpha;
      varying float vMouseProximity;
      void main() {
        float dist = length(gl_PointCoord - vec2(0.5));
        if (dist > 0.5) discard;
        float edge = 1.0 - smoothstep(0.4, 0.5, dist);
        vec3 color = mix(uColorInner, uColorOuter, vRandom * 0.4);
        color = mix(color, vec3(1.0, 0.95, 0.8), vMouseProximity * 0.3);
        gl_FragColor = vec4(color, edge * vAlpha * (1.0 + vMouseProximity * 0.4));
      }
    `;

    const particleFragSquare = `
      uniform vec3 uColorInner;
      uniform vec3 uColorOuter;
      varying float vRandom;
      varying float vAlpha;
      varying float vMouseProximity;
      void main() {
        float boxDist = max(abs(gl_PointCoord.x - 0.5), abs(gl_PointCoord.y - 0.5));
        if (boxDist > 0.5) discard;
        float edge = 1.0 - smoothstep(0.4, 0.5, boxDist);
        vec3 color = mix(uColorInner, uColorOuter, vRandom * 0.4);
        color = mix(color, vec3(1.0, 0.95, 0.8), vMouseProximity * 0.3);
        gl_FragColor = vec4(color, edge * vAlpha * (1.0 + vMouseProximity * 0.4));
      }
    `;

    const particleMat = new THREE.ShaderMaterial({
      vertexShader: particleVert,
      fragmentShader: CONFIG.particleSquare ? particleFragSquare : particleFragCircle,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uProgress:       { value: 0 },
        uTime:           { value: 0 },
        uPixelRatio:     { value: renderer.getPixelRatio() },
        uBaseMult:       { value: CONFIG.particleBaseMult },
        uColorInner:     { value: new THREE.Color(CONFIG.goldPrimary) },
        uColorOuter:     { value: new THREE.Color(CONFIG.goldLight) },
        uMouse3D:        { value: new THREE.Vector3(100, 100, 0) },
        uMouseInfluence: { value: 0 },
        uVisibility:     { value: 1 },
      }
    });

    const particles = new THREE.Points(particleGeo, particleMat);
    scene.add(particles);

    /* ── Blue Particles ── */

    const BLUE_COUNT   = Math.round(COUNT * attr('blue-particle-ratio', 0.4));
    const blueStartPos = new Float32Array(BLUE_COUNT * 3);
    const blueEndPos   = new Float32Array(BLUE_COUNT * 3);
    const blueSizes    = new Float32Array(BLUE_COUNT);
    const blueRandom   = new Float32Array(BLUE_COUNT);

    for (let i = 0; i < BLUE_COUNT; i++) {
      const sp = randomInSphere(CONFIG.sphereRadiusStart, 0.7);
      blueStartPos[i*3]   = sp.x; blueStartPos[i*3+1] = sp.y; blueStartPos[i*3+2] = sp.z;
      const ep = randomInSphere(CONFIG.sphereRadiusEnd, 0.55);
      blueEndPos[i*3]   = ep.x;
      blueEndPos[i*3+1] = ep.y * endScaleY;
      blueEndPos[i*3+2] = ep.z;
      blueSizes[i]  = 0.12 + Math.random() * 0.32;
      blueRandom[i] = Math.random();
    }

    const blueGeo = new THREE.BufferGeometry();
    blueGeo.setAttribute('position',  new THREE.BufferAttribute(new Float32Array(BLUE_COUNT * 3), 3));
    blueGeo.setAttribute('aStartPos', new THREE.BufferAttribute(blueStartPos, 3));
    blueGeo.setAttribute('aEndPos',   new THREE.BufferAttribute(blueEndPos, 3));
    blueGeo.setAttribute('aSize',     new THREE.BufferAttribute(blueSizes, 1));
    blueGeo.setAttribute('aRandom',   new THREE.BufferAttribute(blueRandom, 1));

    const blueMat = new THREE.ShaderMaterial({
      vertexShader: particleVert,
      fragmentShader: CONFIG.particleSquare ? particleFragSquare : particleFragCircle,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uProgress:       { value: 0 },
        uTime:           { value: 0 },
        uPixelRatio:     { value: renderer.getPixelRatio() },
        uBaseMult:       { value: CONFIG.particleBaseMult },
        uColorInner:     { value: new THREE.Color(CONFIG.bluePrimary) },
        uColorOuter:     { value: new THREE.Color(CONFIG.bluePrimary) },
        uMouse3D:        { value: new THREE.Vector3(100, 100, 0) },
        uMouseInfluence: { value: 0 },
        uVisibility:     { value: 0 },
      }
    });

    const blueParticles = new THREE.Points(blueGeo, blueMat);
    scene.add(blueParticles);

    /* ── Nodes ── */

    const nodes     = [];
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);

    const nodeVert = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const nodeFragImage = `
      uniform float uOpacity;
      uniform vec3 uColor;
      uniform sampler2D uTexture;
      uniform float uAspect;
      varying vec2 vUv;
      void main() {
        vec2 center = vUv - 0.5;
        float dist = length(center);
        vec2 imgUv = center;
        if (uAspect > 1.0) { imgUv.x /= uAspect; } else { imgUv.y *= uAspect; }
        imgUv += 0.5;
        float borderOuter = 0.36, borderInner = 0.33;
        float border  = smoothstep(borderInner - 0.005, borderInner, dist) * (1.0 - smoothstep(borderOuter, borderOuter + 0.005, dist));
        float imgMask = 1.0 - smoothstep(borderInner - 0.005, borderInner, dist);
        vec4 img = texture2D(uTexture, imgUv);
        float halo = pow(1.0 - smoothstep(0.0, 0.5, dist), 5.0) * 0.1;
        vec3 col = uColor * border + img.rgb * imgMask * img.a;
        float alpha = (border * 0.95 + imgMask * img.a + halo) * uOpacity;
        if (dist > 0.5) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `;

    const nodeFragTarget = `
      uniform float uOpacity;
      uniform vec3 uColor;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vec2 center = vUv - 0.5;
        float dist = length(center);
        float inner = 1.0 - smoothstep(0.12, 0.14, dist);
        float cycle = fract(uTime * 0.25);
        float p1T = clamp(cycle * 2.5, 0.0, 1.0);
        float p1R = 0.14 + p1T * 0.35;
        float p1A = (1.0 - p1T) * 0.35 * step(cycle, 0.5);
        float p1  = smoothstep(p1R - 0.04, p1R - 0.01, dist) * (1.0 - smoothstep(p1R + 0.01, p1R + 0.04, dist));
        float p2T = clamp((cycle - 0.075) * 2.5, 0.0, 1.0);
        float p2R = 0.14 + p2T * 0.28;
        float p2A = (1.0 - p2T) * 0.28 * step(cycle, 0.5);
        float p2  = smoothstep(p2R - 0.03, p2R - 0.01, dist) * (1.0 - smoothstep(p2R + 0.01, p2R + 0.03, dist));
        float alpha = (inner * 0.5 + p1 * p1A + p2 * p2A) * uOpacity;
        if (dist > 0.5) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `;

    const nodeFragDot = `
      uniform float uOpacity;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float dist   = length(vUv - 0.5);
        float circle = 1.0 - smoothstep(0.30, 0.33, dist);
        float halo   = pow(1.0 - smoothstep(0.0, 0.5, dist), 5.0) * 0.08;
        float alpha  = (circle * 0.8 + halo) * uOpacity;
        if (dist > 0.5) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `;

    const textureLoader = new THREE.TextureLoader();
    textureLoader.crossOrigin = 'anonymous';

    let yellowIdx = 0, blueIdx = 0;
    const yellowNodes   = nodeConfigs.filter(n => n.group !== 'blue');
    const blueNodes     = nodeConfigs.filter(n => n.group === 'blue');
    const nodeEndScaleY = attr('node-end-scale-y', 0.15);

    for (let i = 0; i < NODE_COUNT; i++) {
      const nc        = nodeConfigs[i] || {};
      const isBlue    = nc.group === 'blue';
      const isInitial = nc.initial === true;
      const color     = isBlue ? new THREE.Color(CONFIG.bluePrimary) : new THREE.Color(CONFIG.goldPrimary);

      let size       = nc.size ? 0.18 + (nc.size / 10) * 0.6 : 0.18 + rng() * 0.3;
      const hasImage = nc.image && !nc.image.includes('placeholder');
      const type     = hasImage ? 'image' : (nc.type || 'target');
      const planeGeo = new THREE.PlaneGeometry(size * 2.2, size * 2.2);
      let mat;

      if (type === 'image' && hasImage) {
        const tex = textureLoader.load(nc.image, (loadedTex) => {
          const img = loadedTex.image;
          if (img && mat.uniforms.uAspect) mat.uniforms.uAspect.value = img.width / img.height;
        });
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        mat = new THREE.ShaderMaterial({
          vertexShader: nodeVert, fragmentShader: nodeFragImage,
          transparent: true, depthWrite: false, side: THREE.DoubleSide,
          uniforms: { uOpacity: { value: 0 }, uColor: { value: color }, uTexture: { value: tex }, uAspect: { value: 1.0 } }
        });
      } else if (type === 'dot') {
        mat = new THREE.ShaderMaterial({
          vertexShader: nodeVert, fragmentShader: nodeFragDot,
          transparent: true, depthWrite: false, side: THREE.DoubleSide,
          uniforms: { uOpacity: { value: 0 }, uColor: { value: color } }
        });
      } else {
        mat = new THREE.ShaderMaterial({
          vertexShader: nodeVert, fragmentShader: nodeFragTarget,
          transparent: true, depthWrite: false, side: THREE.DoubleSide,
          uniforms: { uOpacity: { value: 0 }, uColor: { value: color }, uTime: { value: 0 } }
        });
      }

      const mesh      = new THREE.Mesh(planeGeo, mat);
      const groupIdx  = isBlue ? blueIdx++ : yellowIdx++;
      const groupSize = isBlue ? blueNodes.length : yellowNodes.length;
      const introBase = isBlue ? CONFIG.blueIntroStart : CONFIG.yellowIntroStart;
      const stagger   = (groupIdx / Math.max(groupSize, 1)) * 0.18;

      let sp;
      if (isInitial) {
        sp = randomInSphere(CONFIG.sphereRadiusStart, 0.7);
      } else {
        const angle  = (i / NODE_COUNT) * Math.PI * 2 + rng() * 0.5;
        const startR = CONFIG.nodeRadiusStart;
        sp = new THREE.Vector3(
          Math.cos(angle) * startR * (1.0 + rng() * 0.4),
          Math.sin(angle) * startR * 0.35 * (0.5 + rng() * 0.5),
          (rng() - 0.5) * startR * 0.25
        );
      }

      const angle2  = Math.random() * Math.PI * 2;
      const radius2 = CONFIG.sphereRadiusEnd * (0.3 + Math.random() * 0.85);
      const ep = new THREE.Vector3(
        Math.cos(angle2) * radius2,
        (Math.random() - 0.5) * CONFIG.sphereRadiusEnd * nodeEndScaleY * 2,
        Math.sin(angle2) * radius2 * (0.6 + Math.random() * 0.5)
      );

      mesh.userData = {
        startPos: sp, endPos: ep, size,
        rand: rng(), isInitial, isBlue,
        entranceAt:   isInitial ? 0    : introBase + stagger,
        arriveAt:     isInitial ? 0.25 : introBase + stagger + 0.18,
        currentScale: 0,
      };

      mesh.position.copy(sp);
      nodeGroup.add(mesh);
      nodes.push(mesh);
    }

    /* ── Lines ── */

    const lineConnections = [];
    const yellowIndices   = nodes.map((n, i) => !n.userData.isBlue ? i : -1).filter(i => i >= 0);
    const blueIndices     = nodes.map((n, i) =>  n.userData.isBlue ? i : -1).filter(i => i >= 0);
    const srcYellow = yellowIndices.length > 0 ? yellowIndices : nodes.map((_, i) => i);
    const srcBlue   = blueIndices;

    function addPairs(indexList, colorGroup, rngFn, count) {
      if (indexList.length < 2) return;
      const used = new Set();
      for (let p = 0; p < count; p++) {
        let ai, bi, key, attempts = 0;
        do {
          ai = Math.floor(rngFn() * indexList.length);
          bi = Math.floor(rngFn() * indexList.length);
          key = Math.min(ai, bi) + '-' + Math.max(ai, bi);
          attempts++;
        } while ((ai === bi || used.has(key)) && attempts < 50);
        if (ai !== bi && !used.has(key)) {
          used.add(key);
          lineConnections.push({ group: colorGroup, a: indexList[ai], b: indexList[bi] });
        }
      }
    }

    addPairs(srcYellow, 'yellow', rng2, Math.min(Math.floor(srcYellow.length * 0.8), 12));
    if (srcBlue.length >= 2) addPairs(srcBlue, 'blue', rng3, Math.min(Math.floor(srcBlue.length * 0.8), 12));

    if (srcYellow.length > 0 && srcBlue.length > 0) {
      const crossCount = Math.min(Math.floor(Math.min(srcYellow.length, srcBlue.length) * 0.5), 5);
      const usedCross  = new Set();
      for (let c = 0; c < crossCount; c++) {
        let ai, bi, key, attempts = 0;
        do {
          ai = Math.floor(rng3() * srcYellow.length);
          bi = Math.floor(rng3() * srcBlue.length);
          key = srcYellow[ai] + 'x' + srcBlue[bi];
          attempts++;
        } while (usedCross.has(key) && attempts < 50);
        if (!usedCross.has(key)) {
          usedCross.add(key);
          lineConnections.push({ group: 'cross', a: srcYellow[ai], b: srcBlue[bi] });
        }
      }
    }

    const TOTAL_LINES = lineConnections.length;

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position',     new THREE.BufferAttribute(new Float32Array(TOTAL_LINES * 6), 3));
    lineGeo.setAttribute('aLineAlpha',   new THREE.BufferAttribute(new Float32Array(TOTAL_LINES * 2), 1));
    lineGeo.setAttribute('aPulsePhase',  new THREE.BufferAttribute(new Float32Array(TOTAL_LINES * 2), 1));
    lineGeo.setAttribute('aPulseOffset', new THREE.BufferAttribute(new Float32Array(TOTAL_LINES * 2), 1));
    lineGeo.setAttribute('aSignalColor', new THREE.BufferAttribute(new Float32Array(TOTAL_LINES * 6), 3));

    const lineMat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aLineAlpha;
        attribute float aPulsePhase;
        attribute float aPulseOffset;
        attribute vec3  aSignalColor;
        varying float vAlpha;
        varying float vPhase;
        varying float vOffset;
        varying vec3  vSignalColor;
        void main() {
          vAlpha       = aLineAlpha;
          vPhase       = aPulsePhase;
          vOffset      = aPulseOffset;
          vSignalColor = aSignalColor;
          gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uGlobalAlpha;
        uniform float uTime;
        varying float vAlpha;
        varying float vPhase;
        varying float vOffset;
        varying vec3  vSignalColor;
        void main() {
          vec3  baseCol = vec3(0.55, 0.55, 0.55);
          float pos     = mod(uTime * 0.35 + vOffset, 1.2) - 0.1;
          float env     = exp(-pow((vPhase - pos) * 14.0, 2.0));
          float ends    = smoothstep(0.0, 0.06, vPhase) * smoothstep(1.0, 0.94, vPhase);
          vec3  col     = mix(baseCol, vSignalColor, clamp(env * 3.0, 0.0, 1.0));
          float a       = clamp(vAlpha * ends * 0.4 + env * 0.95, 0.0, 1.0) * uGlobalAlpha;
          gl_FragColor  = vec4(col, a);
        }
      `,
      transparent: true, depthWrite: false,
      uniforms: {
        uGlobalAlpha: { value: 0 },
        uTime:        { value: 0 },
      },
    });

    const linesMesh = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(linesMesh);

    const lineStates = lineConnections.map(() => ({
      alive: false, alpha: 0, targetAlpha: 0,
      birthTime: 0, lifetime: 5 + Math.random() * 10,
      cooldown: Math.random() * 2, pulseOffset: Math.random(),
    }));

    const sigColorAttr = lineGeo.getAttribute('aSignalColor');
    for (let c = 0; c < TOTAL_LINES; c++) {
      const po  = lineStates[c].pulseOffset;
      const col = nodes[lineConnections[c].a].material.uniforms.uColor.value;
      sigColorAttr.setXYZ(c*2,   col.r, col.g, col.b);
      sigColorAttr.setXYZ(c*2+1, col.r, col.g, col.b);
      lineGeo.getAttribute('aPulseOffset').setX(c*2,   po);  lineGeo.getAttribute('aPulseOffset').setX(c*2+1, po);
      lineGeo.getAttribute('aPulsePhase').setX(c*2,  0.0);   lineGeo.getAttribute('aPulsePhase').setX(c*2+1, 1.0);
    }
    sigColorAttr.needsUpdate                         = true;
    lineGeo.getAttribute('aPulseOffset').needsUpdate = true;
    lineGeo.getAttribute('aPulsePhase').needsUpdate  = true;

    /* ── Logo ── */

    const logoCircleMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vPos;
        void main() { vPos = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: `
        varying vec2 vPos;
        void main() {
          float dist  = length(vPos);
          float edge  = fwidth(dist) * 1.5;
          float alpha = 1.0 - smoothstep(0.55 - edge, 0.55, dist);
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(1.0, 0.851, 0.0, alpha);
        }
      `,
      transparent: false, depthWrite: true, depthTest: true, side: THREE.DoubleSide, alphaTest: 0.5,
    });
    const logoCircle = new THREE.Mesh(new THREE.CircleGeometry(0.55, 256), logoCircleMat);
    scene.add(logoCircle);

    function createATexture() {
      const size = 1024, c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      const scale = size / 144, ox = (size - 142 * scale) / 2;
      ctx.save(); ctx.translate(ox, 0); ctx.scale(scale, scale);
      ctx.fillStyle = '#04112B';
      ctx.fill(new Path2D('M104.706 106.124H90.9384L90.9475 106.119L90.9384 106.124L70.7371 51.0923H70.7325H70.5199L55.6573 91.4785L50.2733 106.124L36.4648 106.133L45.2738 83.5036L45.2603 83.4206L45.2783 83.3791L45.2919 83.3422L64.6337 33.6858H76.5192L87.1742 61.077L100.784 96.0514L104.706 106.124Z'));
      ctx.restore();
      const tex = new THREE.CanvasTexture(c);
      tex.needsUpdate = true;
      return tex;
    }

    const logoA = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 256),
      new THREE.MeshBasicMaterial({ map: createATexture(), transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide })
    );
    const aurorLogo = new THREE.Group();
    aurorLogo.add(logoCircle);
    aurorLogo.add(logoA);
    logoA.position.set(0, 0, 0.001);
    scene.add(aurorLogo);

    /* ── Interaction ── */

    const mouse     = { screen: new THREE.Vector2(9999, 9999), world: new THREE.Vector3(100, 100, 0), isOver: false, influence: 0 };
    const drag      = { active: false, velocityX: 0, rotationY: 0, lastX: 0 };
    const raycaster = new THREE.Raycaster();
    const hitSphere = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 16), new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(hitSphere);

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      mouse.screen.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      mouse.screen.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
      mouse.isOver = true;
      if (drag.active) {
        const dx = e.clientX - drag.lastX;
        drag.velocityX = dx * 0.003;
        drag.rotationY += dx * 0.003;
        drag.lastX = e.clientX;
      }
    });
    canvas.addEventListener('mouseleave', () => { mouse.isOver = false; });
    canvas.addEventListener('mousedown', (e) => {
      drag.active = true; drag.lastX = e.clientX;
      drag.velocityX = 0; canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', () => { drag.active = false; canvas.style.cursor = 'grab'; });
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) { drag.active = true; drag.lastX = e.touches[0].clientX; drag.velocityX = 0; }
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (drag.active && e.touches.length === 1) {
        const dx = e.touches[0].clientX - drag.lastX;
        drag.velocityX = dx * 0.003;
        drag.rotationY += dx * 0.003;
        drag.lastX = e.touches[0].clientX;
      }
    }, { passive: true });
    canvas.addEventListener('touchend', () => { drag.active = false; });
    canvas.style.cursor = 'grab';

    /* ── Scroll ── */

    let scrollProgress = 0, targetProgress = 0;
    const section = canvas.closest('[data-nw="section"]') || canvas.closest('.nw_section') || document.querySelector('.nw_section');
    function updateScroll() {
      if (!section) return;
      const rect = section.getBoundingClientRect();
      targetProgress = Math.max(0, Math.min(1, -rect.top / (section.scrollHeight - window.innerHeight)));
    }
    window.addEventListener('scroll', updateScroll, { passive: true });
    updateScroll();

    /* ── Render Loop ── */

    const clock = new THREE.Clock();
    let bgT = 0;

    function animate() {
      requestAnimationFrame(animate);
      const time = clock.getElapsedTime();
      scrollProgress += (targetProgress - scrollProgress) * 0.06;
      const p = scrollProgress;

      const wantLight = p > CONFIG.bgTrigger;
      bgT += ((wantLight ? 1 : 0) - bgT) * 0.045;
      scene.background.copy(CONFIG.bgDark).lerp(CONFIG.bgLight, bgT);
      const isDark = bgT < 0.5;

      /* Particles */
      particleMat.uniforms.uProgress.value    = easeOut(p);
      particleMat.uniforms.uTime.value        = time;
      particleMat.uniforms.uVisibility.value  = Math.min(
        THREE.MathUtils.lerp(CONFIG.particleCount / COUNT, (CONFIG.particleCountEnd || CONFIG.particleCount) / COUNT, easeOut(p)), 1.0
      );
      if (isDark) {
        particleMat.uniforms.uColorInner.value.setHex(CONFIG.goldLight);
        particleMat.uniforms.uColorOuter.value.setHex(0xFFEBB0);
        particleMat.blending = THREE.AdditiveBlending;
      } else {
        particleMat.uniforms.uColorInner.value.setHex(CONFIG.goldPrimary);
        particleMat.uniforms.uColorOuter.value.setHex(0xE89920);
        particleMat.blending = THREE.NormalBlending;
      }

      /* Rotation */
      if (!drag.active) {
        drag.velocityX *= 0.95;
        drag.rotationY += drag.velocityX;
      }
      const quat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, p * Math.PI * 2 * CONFIG.rotationTurns + drag.rotationY, 0, 'YXZ')
      );
      particles.quaternion.copy(quat);
      blueParticles.quaternion.copy(quat);
      nodeGroup.quaternion.copy(quat);
      linesMesh.quaternion.copy(quat);

      /* Mouse */
      const mouseGate = smoothstep(0.7, 0.85, p);
      if (mouse.isOver && !drag.active && mouseGate > 0.01) {
        raycaster.setFromCamera(mouse.screen, camera);
        const hits = raycaster.intersectObject(hitSphere);
        if (hits.length > 0) mouse.world.copy(hits[0].point).applyQuaternion(quat.clone().invert());
        mouse.influence = Math.min(mouse.influence + 0.08, mouseGate);
      } else {
        mouse.influence *= 0.92;
      }
      particleMat.uniforms.uMouse3D.value.copy(mouse.world);
      particleMat.uniforms.uMouseInfluence.value = mouse.influence * 0.15;

      /* Blue particles */
      blueMat.uniforms.uProgress.value       = easeOut(p);
      blueMat.uniforms.uTime.value           = time;
      blueMat.uniforms.uVisibility.value     = attr('blue-particle-start', 0.15) + smoothstep(0, 0.5, p) * (1.0 - attr('blue-particle-start', 0.15));
      if (isDark) {
        blueMat.uniforms.uColorInner.value.setHex(CONFIG.bluePrimary);
        blueMat.uniforms.uColorOuter.value.setHex(0xA8D8FF);
        blueMat.blending = THREE.AdditiveBlending;
      } else {
        blueMat.uniforms.uColorInner.value.setHex(CONFIG.bluePrimary);
        blueMat.uniforms.uColorOuter.value.setHex(0x1A6FDD);
        blueMat.blending = THREE.NormalBlending;
      }
      blueMat.uniforms.uMouse3D.value.copy(mouse.world);
      blueMat.uniforms.uMouseInfluence.value = mouse.influence * 0.15;

      /* Nodes */
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const d = n.userData;

        if (d.isInitial) {
          const lerpT = easeOut(p);
          const drift = (1 - p) * 0.4;
          n.position.set(
            THREE.MathUtils.lerp(d.startPos.x, d.endPos.x, lerpT) + Math.sin(time * 0.3 + d.rand * 20) * drift,
            THREE.MathUtils.lerp(d.startPos.y, d.endPos.y, lerpT) + Math.cos(time * 0.25 + d.rand * 15) * drift,
            THREE.MathUtils.lerp(d.startPos.z, d.endPos.z, lerpT)
          );
          d.currentScale += (1.0 - d.currentScale) * 0.15;
          n.scale.setScalar(d.currentScale);
          n.material.uniforms.uOpacity.value = Math.min(d.currentScale, 1.0);
          if (n.material.uniforms.uTime) n.material.uniforms.uTime.value = time + d.rand * 6.28;
          n.visible = d.currentScale > 0.01;
          n.quaternion.copy(camera.quaternion.clone().premultiply(quat.clone().invert()));
          continue;
        }

        const flyIn    = smoothstep(d.entranceAt, d.arriveAt, p);
        const ft       = easeOut(flyIn);
        const driftAmt = 0.15 * (1 - flyIn * 0.8);
        n.position.set(
          THREE.MathUtils.lerp(d.startPos.x, d.endPos.x, ft) + Math.sin(time * 0.3 + d.rand * 20) * driftAmt,
          THREE.MathUtils.lerp(d.startPos.y, d.endPos.y, ft) + Math.cos(time * 0.25 + d.rand * 15) * driftAmt,
          THREE.MathUtils.lerp(d.startPos.z, d.endPos.z, ft)
        );

        let targetScale = 0;
        if (flyIn > 0.01) targetScale = flyIn < 0.7 ? (flyIn / 0.7) * 1.15 : 1.15 - (flyIn - 0.7) / 0.3 * 0.15;

        d.currentScale += (targetScale - d.currentScale) * 0.15;
        n.scale.setScalar(d.currentScale);
        n.material.uniforms.uOpacity.value = Math.min(d.currentScale, 1.0);
        if (n.material.uniforms.uTime) n.material.uniforms.uTime.value = time + d.rand * 6.28;
        n.visible = d.currentScale > 0.01;
        n.quaternion.copy(camera.quaternion.clone().premultiply(quat.clone().invert()));
      }

      /* Lines */
      const yellowGA = smoothstep(0.20, 0.40, p) * CONFIG.lineOpacityMax;
      const blueGA   = smoothstep(0.45, 0.65, p) * CONFIG.lineOpacityMax;
      const crossGA  = smoothstep(0.75, 0.90, p) * CONFIG.lineOpacityMax;

      lineMat.uniforms.uGlobalAlpha.value = 1.0;
      lineMat.uniforms.uTime.value        = time;

      const lPos   = lineGeo.getAttribute('position');
      const lAlpha = lineGeo.getAttribute('aLineAlpha');
      let alive    = lineStates.filter(s => s.alive).length;

      for (let c = 0; c < lineConnections.length; c++) {
        const conn  = lineConnections[c];
        const nodeA = nodes[conn.a];
        const nodeB = nodes[conn.b];
        const st    = lineStates[c];

        const groupGA = conn.group === 'yellow' ? yellowGA : conn.group === 'blue' ? blueGA : crossGA;
        const aVis    = nodeA.userData.currentScale > 0.95 && p > nodeA.userData.arriveAt;
        const bVis    = nodeB.userData.currentScale > 0.95 && p > nodeB.userData.arriveAt;
        const ok      = aVis && bVis && groupGA > 0.01;

        if (st.alive) {
          if (time - st.birthTime > st.lifetime || !ok) {
            st.alive = false; st.targetAlpha = 0; st.cooldown = 1 + Math.random() * 3; alive--;
          }
        } else if (ok && st.cooldown <= 0 && alive < CONFIG.lineMaxActive) {
          if (Math.random() < 0.04) {
            st.alive = true; st.birthTime = time;
            st.lifetime = 4 + Math.random() * 10; st.targetAlpha = 0.5 + Math.random() * 0.5; alive++;
          }
        }
        if (st.cooldown > 0) st.cooldown -= 0.016;
        st.alpha += (st.targetAlpha - st.alpha) * 0.08;

        const finalAlpha = st.alpha * groupGA;
        if (finalAlpha > 0.005 && ok) {
          lPos.setXYZ(c*2,   nodeA.position.x, nodeA.position.y, nodeA.position.z);
          lPos.setXYZ(c*2+1, nodeB.position.x, nodeB.position.y, nodeB.position.z);
        } else {
          lPos.setXYZ(c*2, 0,0,0); lPos.setXYZ(c*2+1, 0,0,0);
        }
        lAlpha.setX(c*2, finalAlpha); lAlpha.setX(c*2+1, finalAlpha);
      }

      lPos.needsUpdate   = true;
      lAlpha.needsUpdate = true;

      /* Logo */
      aurorLogo.quaternion.copy(camera.quaternion);
      aurorLogo.position.set(0, 0, 0);

      if (debugEl) {
        const stage  = Math.min(Math.floor(p * 5), 4);
        const labels = ['Scattered', 'Yellow Nodes', 'Blue Nodes', 'Network', 'Condensed'];
        debugEl.textContent = `Stage ${stage + 1}: ${labels[stage]} | ${Math.round(p * 100)}%`;
      }

      renderer.render(scene, camera);
    }

    animate();

    /* ── Resize ── */

    function onResize() {
      const w = canvasWrap?.clientWidth || window.innerWidth;
      const h = canvasWrap?.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      particleMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
      blueMat.uniforms.uPixelRatio.value     = renderer.getPixelRatio();
    }
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver !== 'undefined' && canvasWrap) new ResizeObserver(onResize).observe(canvasWrap);
  }
})();