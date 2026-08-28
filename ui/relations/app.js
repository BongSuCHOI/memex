/**
 * app.js — Memex Knowledge Galaxy 렌더 엔진
 *
 * data.json(domains/cats/facts/rel) 을 Three.js 3D galaxy 로 그린다.
 *   - 도메인 = 색상 클러스터 (fibonacci sphere 배치, fact 수 비례 크기)
 *   - fact  = THREE.Points 파티클 (도메인 색, 관계수 비례 크기, ShaderMaterial)
 *   - 관계  = 타입별 THREE.LineSegments (SUPPORTS/INFLUENCES/SUPERSEDES/CONTRADICTS 토글)
 * 인터랙션: hover(raycaster)→카드, click→우측 상세패널(관계 목록), 검색, 도메인 브라우저.
 * upstream galaxy의 디자인/카메라/오버레이 패턴을 Memex 구조로 재구성.
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => (n == null ? "–" : n.toLocaleString("en-US"));
  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  // innerHTML 프로퍼티 대신 DOMParser 조립을 쓴다 — 동적 데이터는 esc()로 이스케이프되고
  // 파싱 결과는 inert 노드이므로 스크립트 실행 없이 동일한 렌더링 결과를 얻는다.
  const parseHtml = (html) =>
    Array.from(
      new DOMParser().parseFromString(html, "text/html").body.childNodes,
    );
  const setHtml = (el, html) => el.replaceChildren(...parseHtml(html));
  const appendHtml = (el, html) => el.append(...parseHtml(html));
  function mulberry32(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const REL_COLORS = ["#4ade80", "#35e0c2", "#f5b74e", "#ff5c7f"]; // SUPPORTS INFLUENCES SUPERSEDES CONTRADICTS
  const hexToRGB = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  let DATA = null;
  let scene, camera, renderer, controls, raycaster;
  let factPoints = null; // THREE.Points (전 facts)
  const edgeLines = []; // [THREE.LineSegments] × 4 (타입별)
  let selEdges = null; // 선택 fact 의 관계 하이라이트
  let factPos = null; // Float32Array positions
  const domCenters = []; // [{x,y,z,r}] 도메인 중심
  const relOn = [false, false, true, true]; // 엣지 타입 표시 (기본 SUPERSEDES+CONTRADICTS)
  let showLabels = true;
  let hovered = -1;
  const mouse = new THREE.Vector2(-2, -2);
  const labelEls = []; // 도메인 라벨 오버레이
  let factRels = null; // factIdx → [{o:otherIdx, ty, dir}]  인접 관계
  // perf: raycast 는 마우스 이동(dirty) 또는 150ms 주기로만 (매 프레임 24k 검사 방지)
  let rayDirty = false,
    lastRayAt = 0;
  const RAY_INTERVAL_MS = 150;
  const _labelV = new THREE.Vector3(); // updateLabels 재사용 (per-frame 할당 제거)

  const GALAXY_R = 420;
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  // CX-06: default is the LIVE read-only API. Scope comes from the URL:
  //   ?project=/abs/path&scope=project | ?scope=global | ?scope=all
  // A static data.json is used only when the API route does not exist
  // (plain static hosting of an explicitly exported file).
  const qs = new URLSearchParams(location.search);
  const apiParams = new URLSearchParams();
  const scope = qs.get("scope") || (qs.get("project") ? "project" : "global");
  apiParams.set("scope", scope);
  if (qs.get("project")) apiParams.set("project", qs.get("project"));
  const API_URL = "/api/graph-data?" + apiParams.toString();

  function bootError(msg) {
    setHtml(
      $("#boot"),
      '<div class="bl" style="color:#ff5c7f">로드 실패</div><div class="bs">' +
        esc(msg) +
        "</div>",
    );
  }

  /**
   * 그래프 데이터 스키마 검증 (VISUALIZATION.md:28-29,45-47).
   * malformed 는 명시적 오류로, empty 는 정상 빈 상태로 구분된다.
   * 검증 없이 넘어가면 cats 누락 시 buildDomainBrowser 에서 TypeError 로 죽고,
   * facts/rel 의 범위 밖 인덱스는 렌더링 도중 크래시를 낸다.
   */
  function validateGraphData(d) {
    if (!d || typeof d !== "object") return "graph data is not an object";
    for (const key of ["domains", "cats", "facts", "rel", "relTypes"]) {
      if (!Array.isArray(d[key])) return "missing or malformed array: " + key;
    }
    if (
      !d.meta ||
      typeof d.meta !== "object" ||
      typeof d.meta.domains !== "number" ||
      typeof d.meta.categories !== "number" ||
      typeof d.meta.facts !== "number" ||
      typeof d.meta.relations !== "number" ||
      typeof d.meta.generated !== "string"
    )
      return "missing or malformed meta";
    for (let i = 0; i < d.cats.length; i++) {
      const c = d.cats[i];
      if (
        !c ||
        typeof c !== "object" ||
        !Number.isInteger(c.dom) ||
        c.dom < 0 ||
        c.dom >= d.domains.length
      ) {
        return "cats[" + i + "] has out-of-range domain index";
      }
    }
    for (let i = 0; i < d.facts.length; i++) {
      const f = d.facts[i];
      if (
        !Array.isArray(f) ||
        !Number.isInteger(f[0]) ||
        f[0] < 0 ||
        f[0] >= d.domains.length ||
        !Number.isInteger(f[1]) ||
        f[1] < 0 ||
        f[1] >= d.cats.length ||
        typeof f[2] !== "string" ||
        typeof f[3] !== "number"
      ) {
        return (
          "facts[" + i + "] is malformed or references out-of-range indices"
        );
      }
    }
    for (let i = 0; i < d.rel.length; i++) {
      const r = d.rel[i];
      if (
        !Array.isArray(r) ||
        !Number.isInteger(r[0]) ||
        r[0] < 0 ||
        r[0] >= d.facts.length ||
        !Number.isInteger(r[1]) ||
        r[1] < 0 ||
        r[1] >= d.facts.length ||
        !Number.isInteger(r[2]) ||
        r[2] < 0 ||
        r[2] >= d.relTypes.length
      ) {
        return "rel[" + i + "] references out-of-range indices";
      }
    }
    for (const t of d.relTypes) {
      if (typeof t !== "string") return "relTypes contains a non-string";
    }
    return null;
  }

  fetch(API_URL)
    .then((r) => {
      if (r.status === 404)
        throw Object.assign(new Error("live-api-unavailable"), {
          code: "fallback",
        });
      if (!r.ok)
        return r.json().then((j) => {
          throw new Error(j.error || "HTTP " + r.status);
        });
      return r.json();
    })
    .then((d) => {
      // Validate API response schema at entry: missing arrays -> error, empty arrays -> normal empty state
      const schemaError = validateGraphData(d);
      if (schemaError) throw new Error("Invalid graph data: " + schemaError);
      DATA = d;
      init();
    })
    .catch((e) => {
      if (e && e.code === "fallback") {
        // Explicitly exported static file only — never a silent default.
        fetch("data.json")
          .then((r2) => r2.json())
          .then((d2) => {
            const se = validateGraphData(d2);
            if (se) throw new Error("Invalid static data.json: " + se);
            DATA = d2;
            init();
          })
          .catch((e2) => bootError(e2.message));
      } else bootError(e.message);
    });

  function buildEmptyState() {
    // Empty graph is a normal initial state — show starfield scene with meaningful empty message, no crash
    buildScene();
    // Header still shows counts (0)
    try {
      buildHeader();
    } catch {}
    const ov = $("#overlay");
    if (ov) {
      setHtml(
        ov,
        '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:#9aa4b2;text-align:center;padding:24px">' +
          '<div style="font-size:18px;color:#e6e8eb">아직 표시할 active fact가 없습니다.</div>' +
          '<div style="font-size:13px;max-width:520px;line-height:1.6">첫 동기화 및 fact extraction 상태를 Pipeline Health에서 확인하세요.<br>프로젝트 필터 결과가 없거나 아직 추출된 사실이 없습니다.</div>' +
          '<a href="/pipeline" style="margin-top:8px;color:#35e0c2;text-decoration:none;border:1px solid #35e0c244;padding:8px 14px;border-radius:8px">Pipeline Health 보기</a></div>',
      );
      ov.style.display = "";
    }
    updateStats();
    try {
      buildDomainBrowser();
    } catch {}
    wireEvents();
    animate();
    setTimeout(() => $("#boot").classList.add("hide"), 400);
  }

  function init() {
    // Empty state invariant: domains.length===0 or facts.length===0 must not crash — render empty state
    if (!DATA.domains.length || !DATA.facts.length) {
      buildEmptyState();
      return;
    }
    buildHeader();
    buildScene();
    computeLayout();
    buildFactPoints();
    buildEdges();
    buildLabels();
    buildAdjacency();
    wireEvents();
    updateStats();
    buildDomainBrowser();
    animate();
    setTimeout(() => $("#boot").classList.add("hide"), 400);
  }
  // ── 상단 도메인 탭 (상위 8) ──────────────────
  function buildHeader() {
    const tabs = $("#tabs");
    DATA.domains.slice(0, 8).forEach((d, i) => {
      const b = document.createElement("button");
      b.className = "tab" + (i === 0 ? " on" : "");
      setHtml(
        b,
        '<span class="sw" style="background:' +
          esc(d.hue) +
          '"></span>' +
          esc(d.name),
      );
      b.onclick = () => {
        document
          .querySelectorAll("#tabs .tab")
          .forEach((t) => t.classList.remove("on"));
        b.classList.add("on");
        focusDomain(i);
      };
      tabs.appendChild(b);
    });
    $("#stDomains").textContent = fmt(DATA.meta.domains);
    $("#stCats").textContent = fmt(DATA.meta.categories);
    $("#stFacts").textContent = fmt(DATA.meta.facts);
    $("#stRels").textContent = fmt(DATA.meta.relations);
    $("#ftMeta").textContent =
      new Date(DATA.meta.generated).toISOString().slice(0, 10) +
      " · " +
      fmt(DATA.meta.facts) +
      " facts";
  }

  // ── Three.js 씬 ─────────────────────────────
  function buildScene() {
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.00055);
    const st = $("#stage");
    camera = new THREE.PerspectiveCamera(
      58,
      st.clientWidth / st.clientHeight,
      1,
      6000,
    );
    camera.position.set(0, 120, 900);
    // perf: glow galaxy 는 전부 소프트 스프라이트라 dpr>1.25 에서 MSAA 시각 이득이 없다 —
    // retina 백버퍼 + MSAA 동시 비용 제거. GPU 힌트도 명시.
    const maxDpr = Math.min(devicePixelRatio, 2);
    renderer = new THREE.WebGLRenderer({
      antialias: maxDpr <= 1.25,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(maxDpr);
    renderer.setSize(st.clientWidth, st.clientHeight);
    renderer.setClearColor(0x000000, 1);
    st.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.minDistance = 60;
    controls.maxDistance = 2600;

    raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 6 };

    window.addEventListener("resize", () => {
      camera.aspect = st.clientWidth / st.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(st.clientWidth, st.clientHeight);
    });
    renderer.domElement.addEventListener("pointermove", (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      rayDirty = true; // raycast 는 실제 이동 시에만 즉시
    });
    renderer.domElement.addEventListener("click", () => {
      if (hovered >= 0) openPanel(hovered);
    });
    // starfield 배경
    addStars();
  }

  function addStars() {
    const N = 1400,
      p = new Float32Array(N * 3),
      rng = mulberry32(7);
    for (let i = 0; i < N; i++) {
      const r = 2400 + rng() * 2200,
        th = rng() * Math.PI * 2,
        ph = Math.acos(rng() * 2 - 1);
      p[i * 3] = r * Math.sin(ph) * Math.cos(th);
      p[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      p[i * 3 + 2] = r * Math.cos(ph);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    scene.add(
      new THREE.Points(
        g,
        new THREE.PointsMaterial({
          color: 0x5b6472,
          size: 1.4,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.5,
        }),
      ),
    );
  }

  // ── 레이아웃: 도메인 중심(fibonacci sphere) + fact 클라우드 ──
  function computeLayout() {
    const D = DATA.domains.length,
      rng = mulberry32(42);
    if (D === 0) {
      factPos = new Float32Array(0);
      return;
    }
    const maxF = Math.max(...DATA.domains.map((d) => d.facts || 0), 1);
    for (let i = 0; i < D; i++) {
      const y = 1 - (i / Math.max(1, D - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = GOLDEN_ANGLE * i;
      const scale = GALAXY_R * (0.62 + 0.5 * (DATA.domains[i].facts / maxF));
      domCenters.push({
        x: Math.cos(th) * rad * scale,
        y: y * scale * 0.82,
        z: Math.sin(th) * rad * scale,
        r: 34 + 66 * Math.sqrt(DATA.domains[i].facts / maxF), // 클라우드 반경
      });
    }
    // 카테고리별 각오프셋(서브클러스터) — 같은 카테고리 fact 를 뭉치게
    const catOff = new Map();
    const F = DATA.facts.length;
    factPos = new Float32Array(F * 3);
    for (let i = 0; i < F; i++) {
      const f = DATA.facts[i],
        dc = domCenters[f[0]] || domCenters[0],
        cat = f[1];
      let off = catOff.get(cat);
      if (!off) {
        const a = rng() * Math.PI * 2,
          b = rng() * Math.PI,
          m = dc.r * 0.5;
        off = [
          Math.cos(a) * Math.sin(b) * m,
          Math.cos(b) * m,
          Math.sin(a) * Math.sin(b) * m,
        ];
        catOff.set(cat, off);
      }
      // 카테고리 중심 + 가우시안 산포
      const g1 = (rng() + rng() + rng() - 1.5) * dc.r * 0.42;
      const g2 = (rng() + rng() + rng() - 1.5) * dc.r * 0.42;
      const g3 = (rng() + rng() + rng() - 1.5) * dc.r * 0.42;
      factPos[i * 3] = dc.x + off[0] + g1;
      factPos[i * 3 + 1] = dc.y + off[1] + g2;
      factPos[i * 3 + 2] = dc.z + off[2] + g3;
    }
  }

  // ── fact 파티클 (ShaderMaterial: per-point 색/크기, 원형 스프라이트) ──
  function buildFactPoints() {
    const F = DATA.facts.length;
    const col = new Float32Array(F * 3),
      size = new Float32Array(F);
    const domRGB = DATA.domains.map((d) => hexToRGB(d.hue));
    let maxDeg = 1;
    for (let i = 0; i < F; i++) maxDeg = Math.max(maxDeg, DATA.facts[i][3]);
    for (let i = 0; i < F; i++) {
      const f = DATA.facts[i],
        c = domRGB[f[0]] || [0.6, 0.6, 0.6];
      col[i * 3] = c[0];
      col[i * 3 + 1] = c[1];
      col[i * 3 + 2] = c[2];
      size[i] = 3.2 + 7.5 * Math.sqrt(f[3] / maxDeg); // 관계 많을수록 큼
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(factPos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: renderer.getSize(new THREE.Vector2()).height * 0.5 },
      },
      vertexShader: `
        attribute float size; attribute vec3 color; varying vec3 vColor; uniform float uScale;
        void main(){ vColor=color; vec4 mv=modelViewMatrix*vec4(position,1.0);
          // 상한 26px: 줌인 시 스프라이트 fill-rate 폭발(버벅임 주범) 차단
          gl_PointSize=min(size*(uScale/-mv.z), 26.0); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `
        varying vec3 vColor;
        void main(){ vec2 uv=gl_PointCoord-0.5; float d=length(uv);
          if(d>0.5) discard; float a=smoothstep(0.5,0.12,d);
          float core=smoothstep(0.34,0.0,d)*0.6;
          gl_FragColor=vec4(vColor+core, a); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    factPoints = new THREE.Points(g, mat);
    factPoints.frustumCulled = false;
    scene.add(factPoints);
  }

  // ── 관계 엣지 (타입별 LineSegments) ──────────
  function buildEdges() {
    const buckets = [[], [], [], []];
    for (const [s, t, ty] of DATA.rel) buckets[ty].push(s, t);
    buckets.forEach((idxs, ty) => {
      const pos = new Float32Array(idxs.length * 3);
      for (let k = 0; k < idxs.length; k++) {
        const fi = idxs[k];
        pos[k * 3] = factPos[fi * 3];
        pos[k * 3 + 1] = factPos[fi * 3 + 1];
        pos[k * 3 + 2] = factPos[fi * 3 + 2];
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const line = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({
          color: new THREE.Color(REL_COLORS[ty]),
          transparent: true,
          opacity: ty >= 2 ? 0.26 : 0.13,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      line.frustumCulled = false;
      line.visible = relOn[ty];
      edgeLines.push(line);
      scene.add(line);
    });
  }

  // ── 인접 관계 인덱스 (패널/하이라이트용) ──────
  function buildAdjacency() {
    const F = DATA.facts.length;
    factRels = Array.from({ length: F }, () => []);
    for (const [s, t, ty] of DATA.rel) {
      factRels[s].push({ o: t, ty, dir: "out" });
      factRels[t].push({ o: s, ty, dir: "in" });
    }
  }

  // ── 도메인 라벨 오버레이 (상위 16) ───────────
  function buildLabels() {
    const ov = $("#overlay");
    if (!DATA.domains.length) return;
    const maxF = Math.max(...DATA.domains.map((d) => d.facts || 0), 1);
    DATA.domains.slice(0, 16).forEach((d, i) => {
      const el = document.createElement("div");
      el.className = "clabel";
      el.style.fontSize = 12 + 7 * Math.sqrt((d.facts || 0) / maxF) + "px";
      el.style.color = d.hue;
      el.style.textShadow =
        "0 0 20px " + d.hue + "66, 0 0 46px " + d.hue + "33";
      setHtml(
        el,
        esc(d.name) + '<span class="cnt">' + fmt(d.facts) + " facts</span>",
      );
      ov.appendChild(el);
      labelEls.push({ el, i });
    });
  }

  // ── 이벤트 배선 ─────────────────────────────
  function wireEvents() {
    $("#railHome").onclick = () => resetView();
    $("#railDomains").onclick = () => toggleMenu();
    $("#navMenu").onclick = () => toggleMenu();
    $("#mpClose").onclick = () => toggleMenu(false);
    $("#railRel").onclick = () => {
      relOn.forEach((_, i) => setRel(i, true));
    };
    $("#rpClose").onclick = () => closePanel();
    $("#dimmer").onclick = () => closePanel();
    $("#tgLabels").onclick = (e) => {
      showLabels = !showLabels;
      e.currentTarget.classList.toggle("on", showLabels);
      e.currentTarget.querySelector(".state").textContent = showLabels
        ? "ON"
        : "OFF";
      $("#overlay").style.display = showLabels ? "" : "none";
    };
    $("#tgLabels").classList.add("on");
    document.querySelectorAll(".reltog").forEach((t) => {
      const ty = +t.dataset.ty;
      t.onclick = () => setRel(ty, !relOn[ty]);
    });
    $("#vtGalaxy").onclick = () => setView("galaxy");
    $("#vtClusters").onclick = () => setView("clusters");
    // rail tooltip
    document.querySelectorAll("#rail [data-tip]").forEach((b) => {
      b.addEventListener("mouseenter", () => {
        const tip = $("#railTip");
        tip.textContent = b.dataset.tip;
        tip.style.top = b.getBoundingClientRect().top + "px";
        tip.classList.add("show");
      });
      b.addEventListener("mouseleave", () =>
        $("#railTip").classList.remove("show"),
      );
    });
    // 검색 (perf: 키스트로크마다 24k 스캔 방지 — 300ms 디바운스 + 최소 2자)
    let searchT = null;
    $("#searchInput").addEventListener("input", (e) => {
      clearTimeout(searchT);
      const q = e.target.value;
      if (q.trim().length < 2) return;
      searchT = setTimeout(() => runSearch(q), 300);
    });
    $("#mpSearch").addEventListener("input", () =>
      renderDomainList($("#mpSearch").value),
    );
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        $("#searchInput").focus();
      }
      if (e.key === "Escape") {
        closePanel();
        toggleMenu(false);
      }
    });
  }

  function setRel(ty, on) {
    relOn[ty] = on;
    edgeLines[ty].visible = on;
    document
      .querySelector('.reltog[data-ty="' + ty + '"]')
      .classList.toggle("on", on);
  }
  function setView(v) {
    $("#vtGalaxy").classList.toggle("on", v === "galaxy");
    $("#vtClusters").classList.toggle("on", v === "clusters");
    // clusters: 엣지 숨김 + 라벨만 강조 / galaxy: 기본
    if (v === "clusters") {
      edgeLines.forEach((l) => (l.visible = false));
    } else {
      edgeLines.forEach((l, i) => (l.visible = relOn[i]));
    }
  }
  function resetView() {
    clearSelEdges();
    camera.position.set(0, 120, 900);
    controls.target.set(0, 0, 0);
    controls.autoRotate = true;
  }

  // ── hover / raycast ─────────────────────────
  function updateHover(now) {
    if (!factPoints) return;
    // 마우스가 움직였거나(즉시) 150ms 주기(자동회전 보정)에만 24k 검사 실행
    if (!rayDirty && now - lastRayAt < RAY_INTERVAL_MS) return;
    const moved = rayDirty;
    rayDirty = false;
    lastRayAt = now;
    raycaster.setFromCamera(mouse, camera);
    const hit = raycaster.intersectObject(factPoints, false)[0];
    const idx = hit ? hit.index : -1;
    if (idx === hovered) {
      if (idx >= 0 && moved) positionHover();
      return;
    }
    hovered = idx;
    const hc = $("#hover");
    if (idx < 0) {
      hc.classList.remove("show");
      renderer.domElement.style.cursor = "";
      return;
    }
    renderer.domElement.style.cursor = "pointer";
    const f = DATA.facts[idx],
      dom = DATA.domains[f[0]],
      cat = DATA.cats[f[1]];
    setHtml(
      hc,
      '<div class="kind"><i style="background:' +
        esc(dom.hue) +
        '"></i>' +
        esc(dom.name) +
        "</div>" +
        '<div class="name">' +
        esc(f[2]) +
        "</div>" +
        '<div class="row"><span>카테고리</span><b>' +
        esc(cat ? cat.name : "–") +
        "</b></div>" +
        '<div class="row"><span>관계 수</span><b>' +
        fmt(f[3]) +
        "</b></div>",
    );
    hc.classList.add("show");
    positionHover();
  }
  function positionHover() {
    const hc = $("#hover"),
      r = renderer.domElement.getBoundingClientRect();
    let x = ((mouse.x + 1) / 2) * r.width + r.left + 16;
    let y = ((1 - mouse.y) / 2) * r.height + r.top + 16;
    if (x + hc.offsetWidth > innerWidth - 8) x -= hc.offsetWidth + 32;
    if (y + hc.offsetHeight > innerHeight - 8) y -= hc.offsetHeight + 32;
    hc.style.left = x + "px";
    hc.style.top = y + "px";
  }

  // ── 우측 상세 패널 ──────────────────────────
  function openPanel(idx) {
    controls.autoRotate = false;
    const f = DATA.facts[idx],
      dom = DATA.domains[f[0]],
      cat = DATA.cats[f[1]];
    const rels = factRels[idx] || [];
    const byType = [0, 0, 0, 0];
    rels.forEach((r) => byType[r.ty]++);
    const TNAME = DATA.relTypes;
    let html =
      '<div class="rp-badges"><span class="rp-badge hi" style="border-color:' +
      dom.hue +
      "66;color:" +
      dom.hue +
      '"><i style="background:' +
      dom.hue +
      '"></i>' +
      esc(dom.name) +
      "</span>" +
      '<span class="rp-badge">' +
      esc(cat ? cat.name : "Uncategorized") +
      "</span></div>" +
      '<div class="rp-fact">' +
      esc(f[2]) +
      "</div>" +
      '<div class="rp-meta"><span>관계 ' +
      fmt(f[3]) +
      "</span><span>domain #" +
      (f[0] + 1) +
      "</span></div>" +
      '<div class="rp-trio">' +
      '<div class="cell"><div class="l">Supports</div><div class="v" style="color:var(--rel0)">' +
      byType[0] +
      "</div></div>" +
      '<div class="cell"><div class="l">Influences</div><div class="v" style="color:var(--rel1)">' +
      byType[1] +
      "</div></div>" +
      '<div class="cell"><div class="l">Super/Contra</div><div class="v" style="color:var(--rel3)">' +
      (byType[2] + byType[3]) +
      "</div></div>" +
      "</div>";
    // 관계 목록 (타입 순: CONTRADICTS > SUPERSEDES > INFLUENCES > SUPPORTS, 최대 60)
    const order = [3, 2, 1, 0];
    const sorted = rels
      .slice()
      .sort((a, b) => order.indexOf(a.ty) - order.indexOf(b.ty))
      .slice(0, 60);
    html +=
      '<div class="rp-sect"><div class="sh"><span>관계 (' +
      rels.length +
      ")</span><span>연결된 fact</span></div>";
    if (!sorted.length)
      html += '<div class="rp-empty">이 fact 에 연결된 관계가 없습니다.</div>';
    for (const r of sorted) {
      const of = DATA.facts[r.o];
      html +=
        '<div class="rp-item" data-go="' +
        r.o +
        '">' +
        '<span class="rt" style="background:' +
        REL_COLORS[r.ty] +
        '"></span>' +
        '<span class="nm">' +
        esc(of[2]) +
        "</span>" +
        '<span class="ty">' +
        (r.dir === "out" ? "→" : "←") +
        " " +
        TNAME[r.ty].slice(0, 4) +
        "</span></div>";
    }
    html += "</div>";
    setHtml($("#rpInner"), html);
    $("#rpInner")
      .querySelectorAll(".rp-item")
      .forEach(
        (el) =>
          (el.onclick = () => {
            flyTo(+el.dataset.go);
            openPanel(+el.dataset.go);
          }),
      );
    $("#rpanel").classList.add("show");
    $("#dimmer").classList.add("show");
    loadProvenance(idx);
    highlightSelEdges(idx);
    flyTo(idx);
  }
  async function loadProvenance(idx) {
    const f = DATA.facts[idx];
    if (!f || !f[4]) return;
    try {
      const r = await fetch(
        "/api/fact-provenance?id=" + encodeURIComponent(f[4]),
      );
      if (!r.ok) return;
      const j = await r.json();
      if (j.error) return;
      let html = '<div class="rp-sec">PROVENANCE</div>';
      html +=
        '<div class="rp-item" style="cursor:default"><span class="nm" style="font-size:11px;opacity:.8">fact id</span><span class="ty">' +
        esc(String(f[4]).slice(0, 8)) +
        "</span></div>";
      for (const src of j.sources || []) {
        html +=
          '<div class="rp-item" style="cursor:default"><span class="nm">' +
          esc((src.user_message || "").slice(0, 60)) +
          '</span><span class="ty">' +
          esc(src.project || "") +
          "</span></div>";
      }
      for (const rev of j.revisions || []) {
        html +=
          '<div class="rp-item" style="cursor:default"><span class="nm">' +
          esc((rev.previous_fact || "").slice(0, 60)) +
          " → " +
          esc((rev.new_fact || "").slice(0, 40)) +
          '</span><span class="ty">REV</span></div>';
      }
      appendHtml($("#rpInner"), html);
    } catch (err) {
      void err;
    }
  }
  function closePanel() {
    $("#rpanel").classList.remove("show");
    $("#dimmer").classList.remove("show");
    clearSelEdges();
    if ($("#hover") && hovered < 0) controls.autoRotate = true;
  }
  function clearSelEdges() {
    if (selEdges) {
      scene.remove(selEdges);
      selEdges.geometry.dispose();
      selEdges.material.dispose();
      selEdges = null;
    }
  }
  function highlightSelEdges(idx) {
    clearSelEdges();
    const rels = factRels[idx] || [];
    if (!rels.length) return;
    const pos = new Float32Array(rels.length * 6),
      col = new Float32Array(rels.length * 6);
    rels.forEach((r, k) => {
      const c = hexToRGB(REL_COLORS[r.ty]);
      pos.set(
        [
          factPos[idx * 3],
          factPos[idx * 3 + 1],
          factPos[idx * 3 + 2],
          factPos[r.o * 3],
          factPos[r.o * 3 + 1],
          factPos[r.o * 3 + 2],
        ],
        k * 6,
      );
      col.set([c[0], c[1], c[2], c[0], c[1], c[2]], k * 6);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    selEdges = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    selEdges.frustumCulled = false;
    scene.add(selEdges);
  }
  function flyTo(idx) {
    const tx = factPos[idx * 3],
      ty = factPos[idx * 3 + 1],
      tz = factPos[idx * 3 + 2];
    controls.autoRotate = false;
    animateCam({ x: tx, y: ty, z: tz }, 180);
  }
  let camAnim = null;
  function animateCam(target, dist) {
    const dir = new THREE.Vector3()
      .subVectors(camera.position, controls.target)
      .normalize();
    const toPos = new THREE.Vector3(target.x, target.y, target.z).add(
      dir.multiplyScalar(dist),
    );
    camAnim = {
      fromT: controls.target.clone(),
      toT: new THREE.Vector3(target.x, target.y, target.z),
      fromP: camera.position.clone(),
      toP: toPos,
      t: 0,
    };
  }

  // ── 도메인 → 카테고리 브라우저 ───────────────
  function buildDomainBrowser() {
    $("#mpTotal").textContent = fmt(DATA.domains.length);
    $("#mpFacts").textContent = fmt(DATA.meta.facts);
    // 도메인별 카테고리 목록 사전 계산
    DATA._catsByDom = Array.from({ length: DATA.domains.length }, () => []);
    DATA.cats.forEach((c, i) => {
      if (DATA._catsByDom[c.dom]) DATA._catsByDom[c.dom].push(i);
    });
    DATA._catsByDom.forEach((arr) =>
      arr.sort((a, b) => DATA.cats[b].facts - DATA.cats[a].facts),
    );
    renderDomainList("");
  }
  function renderDomainList(q) {
    q = (q || "").trim().toLowerCase();
    const list = $("#mpList");
    let html = "";
    DATA.domains.forEach((d, di) => {
      const catIdxs = DATA._catsByDom[di] || [];
      const matchDom = d.name.toLowerCase().includes(q);
      const matchCats = q
        ? catIdxs.filter((ci) => DATA.cats[ci].name.toLowerCase().includes(q))
        : catIdxs.slice(0, 40);
      if (q && !matchDom && !matchCats.length) return;
      const shownCats =
        matchDom && !q
          ? catIdxs.slice(0, 40)
          : q
            ? matchCats.slice(0, 40)
            : catIdxs.slice(0, 40);
      html +=
        '<div class="mp-mod' +
        (q ? " open" : "") +
        '">' +
        '<div class="mp-mod-head"><span class="code" style="background:' +
        d.hue +
        '"></span>' +
        '<span class="nm">' +
        esc(d.name) +
        '</span><span class="cnt">' +
        fmt(d.facts) +
        "</span>" +
        '<span class="chev">▶</span></div>' +
        '<div class="mp-items">';
      for (const ci of shownCats) {
        const c = DATA.cats[ci];
        html +=
          '<div class="mp-item" data-dom="' +
          di +
          '"><span class="dot"></span><span style="flex:1">' +
          esc(c.name) +
          '</span><span class="cnt">' +
          fmt(c.facts) +
          "</span></div>";
      }
      html += "</div></div>";
    });
    setHtml(list, html || '<div class="mp-empty">검색 결과 없음</div>');
    list
      .querySelectorAll(".mp-mod-head")
      .forEach(
        (h) => (h.onclick = () => h.parentElement.classList.toggle("open")),
      );
    list.querySelectorAll(".mp-item").forEach(
      (it) =>
        (it.onclick = () => {
          focusDomain(+it.dataset.dom);
          toggleMenu(false);
        }),
    );
  }
  function toggleMenu(force) {
    const p = $("#menuPanel");
    const show = force === undefined ? !p.classList.contains("show") : force;
    p.classList.toggle("show", show);
  }

  // ── 검색 / 포커스 ──────────────────────────
  function runSearch(q) {
    q = (q || "").trim().toLowerCase();
    if (!q) return;
    let best = -1;
    for (let i = 0; i < DATA.facts.length; i++) {
      if (DATA.facts[i][2].toLowerCase().includes(q)) {
        best = i;
        break;
      }
    }
    if (best >= 0) {
      flyTo(best);
      openPanel(best);
    }
  }
  function focusDomain(di) {
    const c = domCenters[di];
    if (!c) return;
    closePanel();
    controls.autoRotate = false;
    animateCam({ x: c.x, y: c.y, z: c.z }, c.r * 3.2 + 160);
  }

  function updateStats() {
    /* stats 는 buildHeader 에서 채움 */
  }

  // ── 라벨 위치 갱신 (3D→2D 투영) ──────────────
  // perf: 대형 blur text-shadow 라벨을 left/top 으로 옮기면 매 프레임 repaint —
  // transform(translate3d)은 compositor 전용이라 블러 래스터가 레이어 텍스처로 캐시된다.
  function updateLabels() {
    if (!showLabels) return;
    const w = renderer.domElement.clientWidth,
      h = renderer.domElement.clientHeight;
    for (const { el, i } of labelEls) {
      const c = domCenters[i];
      _labelV.set(c.x, c.y + c.r * 0.9, c.z).project(camera);
      if (_labelV.z > 1) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      const x = ((_labelV.x + 1) / 2) * w,
        y = ((1 - _labelV.y) / 2) * h;
      el.style.transform =
        "translate3d(" +
        x.toFixed(1) +
        "px," +
        y.toFixed(1) +
        "px,0) translate(-50%,-50%)";
      el.style.opacity = Math.max(
        0.15,
        1 - Math.max(0, _labelV.z - 0.9) * 8,
      ).toFixed(3);
    }
  }

  // ── 렌더 루프 (+ eco-mode: 느린 기기에서 pixelRatio 단계 강등, nagix 패턴) ──
  let _ecoPrev = 0,
    _ecoAcc = 0,
    _ecoN = 0,
    _ecoDpr = 0;
  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    if (camAnim) {
      camAnim.t = Math.min(1, camAnim.t + 0.045);
      const e = 1 - (1 - camAnim.t) ** 3;
      controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e);
      camera.position.lerpVectors(camAnim.fromP, camAnim.toP, e);
      if (camAnim.t >= 1) camAnim = null;
    }
    controls.update();
    updateHover(now);
    updateLabels();
    renderer.render(scene, camera);
    // eco-mode: 90프레임 롤링 평균 > 28ms → dpr 0.25 강등 (degrade-only, oscillation 방지)
    if (_ecoDpr === 0) _ecoDpr = renderer.getPixelRatio();
    if (_ecoPrev > 0) {
      const dt = Math.min(now - _ecoPrev, 100); // 탭 비활성 gap 클램프
      _ecoAcc += dt;
      _ecoN++;
      if (_ecoN >= 90) {
        const avg = _ecoAcc / _ecoN;
        _ecoAcc = 0;
        _ecoN = 0;
        if (avg > 28 && _ecoDpr > 1) {
          _ecoDpr = Math.max(1, _ecoDpr - 0.25);
          const st = renderer.domElement.parentElement;
          renderer.setPixelRatio(_ecoDpr);
          renderer.setSize(st.clientWidth, st.clientHeight);
        }
      }
    }
    _ecoPrev = now;
  }
})();
