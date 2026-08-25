// ── CTIGEN.SYS — procedural coherence-tomography imagery ───────────
// Models what actually makes an OCT scan look like an OCT scan:
//
//   · stratified tissue — layers of differing backscatter
//   · multiplicative speckle — the coherent-interference texture that is
//     the format's signature, not additive noise
//   · exponential attenuation with depth
//   · shadowing — anything highly attenuating casts a shadow through
//     every layer beneath it
//   · log compression — OCT is displayed in dB, which is why the noise
//     floor stays visible instead of crushing to black
//   · progressive acquisition — the frame is built A-scan by A-scan by a
//     sweeping beam, so it assembles rather than appearing
//
// Palette is the site's: greys and white for structure, with the theme
// red and green used where clinical OCT actually puts them — layer
// segmentation overlays and Doppler flow encoding.
window.__ctiGen = (function () {
    'use strict';

    var GREEN = [77, 255, 136];    // .online  — ILM boundary / flow toward
    var RED   = [255, 68, 85];     // .offline — RPE boundary / flow away

    var container = document.getElementById('audio-sys-out');

    // ── Parameters ────────────────────────────────────────────────
    var PARAM_DEFS = [
        {id:'mode',    label:'MODE',    min:0,   max:3,   dflt:0,    fmt:'mode',
         hint:'auto · b-scan · angio · catheter'},
        {id:'geom',    label:'TISSUE',  min:0,   max:4,   dflt:0,    fmt:'geom',
         hint:'retina · cornea · skin · vessel · lesion'},
        {id:'splice',  label:'SPLICE',  min:1,   max:6,   dflt:1,    fmt:'i',
         hint:'scans stitched in random columns'},
        {id:'pxw',     label:'WIDTH',   min:160, max:1600,dflt:720,  fmt:'px',
         hint:'output width in pixels'},
        {id:'pxh',     label:'HEIGHT',  min:120, max:900, dflt:260,  fmt:'px',
         hint:'output height in pixels'},
        {id:'speckle', label:'SPECKLE', min:0,   max:1.6, dflt:0.85, fmt:'n',
         hint:'coherent noise texture'},
        {id:'gain',    label:'GAIN',    min:0.2, max:3.0, dflt:1.35, fmt:'n',
         hint:'log display gain (dB)'},
        {id:'atten',   label:'DEPTH',   min:0.2, max:3.0, dflt:1.0,  fmt:'n',
         hint:'signal falloff with depth'},
        {id:'sweep',   label:'SWEEP',   min:0.1, max:5.0, dflt:1.6,  fmt:'n',
         hint:'beam acquisition speed'},
        {id:'layers',  label:'LAYERS',  min:3,   max:11,  dflt:7,    fmt:'i',
         hint:'stratified tissue bands'},
        {id:'flow',    label:'FLOW',    min:0,   max:1,   dflt:0.45, fmt:'n',
         hint:'doppler red/green encoding'},
        {id:'drift',   label:'MOTION',  min:0,   max:1,   dflt:0.35, fmt:'n',
         hint:'subject movement artifact'},
    ];
    var MODE_NAMES = ['AUTO', 'B-SCAN', 'ANGIO', 'CATHETER'];

    var P = {}, DEFAULTS = {};
    for (var _i = 0; _i < PARAM_DEFS.length; _i++) {
        P[PARAM_DEFS[_i].id]        = PARAM_DEFS[_i].dflt;
        DEFAULTS[PARAM_DEFS[_i].id] = PARAM_DEFS[_i].dflt;
    }

    // ── Fast noise ────────────────────────────────────────────────
    // Speckle in OCT is closer to Rayleigh/exponential than Gaussian —
    // long bright tails against a dark floor. Precomputed so the inner
    // pixel loop is a table lookup rather than a log() per pixel.
    var SPK_N = 8192, SPK = new Float32Array(SPK_N);
    (function () {
        var s = 22222;
        for (var i = 0; i < SPK_N; i++) {
            s = (s * 1664525 + 1013904223) >>> 0;
            var u = (s >>> 8) / 16777216;
            SPK[i] = -Math.log(1 - u * 0.9995);      // exponential tail
        }
    })();
    var spkPtr = 0;
    function spk() { spkPtr = (spkPtr + 7919) & (SPK_N - 1); return SPK[spkPtr]; }

    function lcg(seed) {
        var s = seed >>> 0;
        return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }

    // ── Canvas ────────────────────────────────────────────────────
    var wrap = null, canvas = null, ctx = null, img = null, buf = null;
    var W = 0, H = 0;
    var rTab = null, thTab = null;   // polar lookups for catheter mode

    function makeCanvas() {
        canvas = document.createElement('canvas');
        canvas.className = 'cti-canvas';
        ctx = canvas.getContext('2d', { alpha: false });
    }

    // Returns true when the backing store was reallocated (and is therefore
    // blank), so the caller knows it has to lay down a fresh frame.
    function resize() {
        if (!canvas) return false;
        // Backing store is exactly the requested pixel size — that's what
        // gets exported. CSS then scales it down to fit the pane if it's
        // wider than the panel, without changing the output resolution.
        var cw = Math.max(160, Math.round(P.pxw));
        var ch = Math.max(120, Math.round(P.pxh));
        if (cw === W && ch === H) return false;
        W = cw; H = ch;
        canvas.width = W; canvas.height = H;
        canvas.style.width  = W + 'px';
        canvas.style.height = 'auto';
        img = ctx.createImageData(W, H);
        buf = img.data;
        for (var i = 3; i < buf.length; i += 4) buf[i] = 255;   // opaque

        // Polar tables — atan2/sqrt per pixel per frame is far too slow
        rTab  = new Float32Array(W * H);
        thTab = new Float32Array(W * H);
        var cx = W / 2, cy = H / 2, norm = Math.min(cx, cy);
        for (var y = 0; y < H; y++) {
            for (var x = 0; x < W; x++) {
                var dx = x - cx, dy = y - cy, k = y * W + x;
                rTab[k]  = Math.sqrt(dx * dx + dy * dy) / norm;
                thTab[k] = Math.atan2(dy, dx);
            }
        }
        clearBuf();
        return true;
    }

    function clearBuf() {
        if (!buf) return;
        for (var i = 0; i < buf.length; i += 4) { buf[i] = 0; buf[i+1] = 0; buf[i+2] = 0; }
    }

    // ── Tissue geometries ─────────────────────────────────────────
    // What is being scanned, as distinct from how it's scanned. Each
    // supplies a stack of scattering bands, a surface shape, a bulk
    // attenuation and where its segmentation boundaries sit — the things
    // that actually distinguish one tissue's OCT signature from another.
    //   bands: {c: depth 0-1, amp: backscatter, w: band thickness}
    var GEOMS = [
        {
            name: 'RETINA',           // thin, many-layered, very bright outer band
            mu: 0.9, base: 0.05,
            bands: [{c:0.10,amp:0.62,w:0.020},{c:0.20,amp:0.16,w:0.026},
                    {c:0.30,amp:0.44,w:0.018},{c:0.41,amp:0.12,w:0.034},
                    {c:0.56,amp:0.30,w:0.020},{c:0.66,amp:1.05,w:0.016},
                    {c:0.74,amp:0.90,w:0.020},{c:0.86,amp:0.34,w:0.045}],
            surf: function (nx, tt, P) {
                // foveal pit — a depression in the inner surface
                return 0.17 + 0.10 * nx * nx + 0.16 * Math.exp(-Math.pow(nx / 0.20, 2))
                     + P.drift * (0.020 * Math.sin(tt * 0.7 + nx * 2) + 0.012 * Math.sin(tt * 1.9));
            }
        },
        {
            name: 'CORNEA',           // strongly curved, largely transparent stroma
            mu: 0.35, base: 0.02,
            bands: [{c:0.06,amp:1.00,w:0.014},{c:0.13,amp:0.34,w:0.014},
                    {c:0.42,amp:0.10,w:0.240},{c:0.80,amp:0.72,w:0.016},
                    {c:0.86,amp:0.44,w:0.012}],
            surf: function (nx, tt, P) {
                return 0.13 + 0.30 * nx * nx
                     + P.drift * 0.018 * Math.sin(tt * 0.8 + nx);
            }
        },
        {
            name: 'SKIN',             // rough surface, broad diffuse dermis
            mu: 1.9, base: 0.10,
            bands: [{c:0.05,amp:0.70,w:0.030},{c:0.16,amp:0.30,w:0.040},
                    {c:0.34,amp:0.52,w:0.090},{c:0.62,amp:0.26,w:0.150}],
            surf: function (nx, tt, P) {
                return 0.16 + 0.035 * Math.sin(nx * 9 + tt * 0.4)
                     + 0.022 * Math.sin(nx * 23 - tt * 0.7)
                     + P.drift * 0.02 * Math.sin(tt * 1.3);
            }
        },
        {
            name: 'VESSEL',           // intima / media / adventitia
            mu: 1.15, base: 0.06,
            bands: [{c:0.07,amp:0.85,w:0.016},{c:0.22,amp:0.18,w:0.070},
                    {c:0.46,amp:0.66,w:0.055},{c:0.72,amp:0.40,w:0.110}],
            surf: function (nx, tt, P) {
                return 0.20 + 0.045 * Math.sin(nx * 3.1 + tt * 0.5)
                     + P.drift * 0.02 * Math.sin(tt * 1.1 + nx * 4);
            }
        },
        {
            name: 'LESION',           // disrupted stratification, heterogeneous
            mu: 1.5, base: 0.12,
            bands: [{c:0.09,amp:0.55,w:0.030},{c:0.27,amp:0.85,w:0.075},
                    {c:0.44,amp:0.22,w:0.055},{c:0.58,amp:0.70,w:0.100},
                    {c:0.80,amp:0.30,w:0.070}],
            surf: function (nx, tt, P) {
                return 0.18 + 0.06 * Math.sin(nx * 5.7 + tt * 0.6)
                     + 0.04 * Math.sin(nx * 13.3 + tt * 1.1)
                     + P.drift * 0.03 * Math.sin(tt * 1.7);
            }
        }
    ];
    var GEOM_NAMES = GEOMS.map(function (g) { return g.name; });

    // One cached depth profile per geometry — splicing needs several live at
    // once, and it's a lookup table in the pixel loop either way.
    var profiles = [];
    function buildProfile(gi) {
        var G = GEOMS[gi % GEOMS.length];
        var p = profiles[gi];
        if (!p || p.length !== H) { p = new Float32Array(H); profiles[gi] = p; }
        var mu = G.mu * P.atten;
        // LAYERS thins or extends the stack rather than inventing bands
        var n = Math.max(1, Math.min(G.bands.length, Math.round(P.layers * G.bands.length / 7)));
        for (var d = 0; d < H; d++) {
            var dn = d / H, v = G.base;
            for (var L = 0; L < n; L++) {
                var b = G.bands[L];
                var g = (dn - b.c) / b.w;
                v += b.amp * Math.exp(-g * g);
            }
            p[d] = v * Math.exp(-mu * dn * 4.0);
        }
        return p;
    }
    function buildAllProfiles() {
        for (var i = 0; i < GEOMS.length; i++) buildProfile(i);
    }

    // ── Modes ─────────────────────────────────────────────────────
    var t = 0, sweepPos = 0, mode = 1, modeTimer = 0;
    var vessels = [], angioTree = [], treeSeed = 1;

    // ── Splice sources ────────────────────────────────────────────
    // Each source is an independent "scan": its own tissue, its own
    // vertical offset and its own phase through the surface function, so
    // stitched columns land at visibly different depths and shapes.
    var sources = [], spliceBands = [], spliceAge = 0;

    function rebuildSources() {
        var r = lcg(9001 + Math.floor(t * 3) * 7919);
        var n = Math.max(1, Math.round(P.splice));
        sources = [];
        for (var i = 0; i < n; i++) {
            sources.push({
                geom:  i === 0 ? Math.round(P.geom) % GEOMS.length
                               : Math.floor(r() * GEOMS.length),
                yOff:  (r() - 0.5) * 0.22,
                phase: r() * 12,
                scale: 0.85 + r() * 0.4
            });
        }
        // Random-width column runs, each assigned a source
        spliceBands = [];
        var x = 0;
        while (x < W) {
            var wdt = n === 1 ? W : Math.max(8, Math.floor((0.04 + r() * 0.22) * W));
            spliceBands.push({ x0: x, x1: Math.min(W, x + wdt),
                               src: sources[Math.floor(r() * sources.length)] });
            x += wdt;
        }
        spliceAge = 0;
    }

    function sourceForColumn(x) {
        for (var i = 0; i < spliceBands.length; i++) {
            if (x >= spliceBands[i].x0 && x < spliceBands[i].x1) return spliceBands[i].src;
        }
        return sources[0] || { geom: 0, yOff: 0, phase: 0, scale: 1 };
    }

    // Surface for a column, per its source's tissue and offset
    function surfaceAt(x, src) {
        var nx = (x / W) * 2 - 1;
        var G = GEOMS[src.geom % GEOMS.length];
        return (G.surf(nx * src.scale, t + src.phase, P) + src.yOff) * H;
    }

    function regenVessels() {
        vessels = [];
        var r = lcg(4242 + Math.floor(t * 0.05));
        var n = 4 + Math.floor(r() * 4);
        for (var i = 0; i < n; i++) {
            vessels.push({ x: r(), w: 0.006 + r() * 0.014, o: 0.55 + r() * 0.4 });
        }
    }

    // Columns of a B-scan. Only the freshly-swept band is regenerated each
    // frame, which is both cheaper and how the real instrument builds an
    // image — the trailing columns are last sweep's data until overwritten.
    function drawBScanBand(x0, x1) {
        for (var x = x0; x < x1; x++) {
            if (x < 0 || x >= W) continue;
            var src = sourceForColumn(x);
            var prof = profiles[src.geom] || buildProfile(src.geom);
            var s = surfaceAt(x, src);

            // Vessel shadowing — attenuates everything below the vessel
            var shadow = 1;
            for (var v = 0; v < vessels.length; v++) {
                var dx = Math.abs(x / W - vessels[v].x);
                if (dx < vessels[v].w) shadow *= 1 - vessels[v].o * (1 - dx / vessels[v].w);
            }

            var flowSign = Math.sin(x * 0.11 + t * 1.3);
            // Flow lives in the vessel lumen — a patch at the vessel's own
            // depth, not the full height of the shadow it casts
            var vesselDepth = H * (0.10 + 0.05 * Math.sin(x * 0.37));
            var lumen = 1 - shadow;
            for (var y = 0; y < H; y++) {
                var k = (y * W + x) * 4;
                var d = y - s;
                var sig;
                if (d < 0) {
                    sig = 0.012 * spk();                       // vitreous: noise floor only
                } else {
                    var di = d | 0;
                    sig = (di < H ? prof[di] : 0) * shadow;
                    sig *= (1 - P.speckle) + P.speckle * spk(); // multiplicative speckle
                }
                // Log compression — dB display, keeps the noise floor visible
                var g = Math.log(1 + sig * 42 * P.gain) * 62;
                if (g > 255) g = 255;

                var R = g, G = g, B = g;
                // Doppler: flow encoded red/green inside the vessel lumen,
                // falling off with distance from it
                if (P.flow > 0 && lumen > 0.06 && d > 0) {
                    var dv = (d - vesselDepth) / (H * 0.055);
                    var fa = P.flow * lumen * Math.exp(-dv * dv) * 0.95;
                    if (flowSign > 0) { R += (RED[0]   - R) * fa; G += (RED[1]   - G) * fa; B += (RED[2]   - B) * fa; }
                    else              { R += (GREEN[0] - R) * fa; G += (GREEN[1] - G) * fa; B += (GREEN[2] - B) * fa; }
                }
                buf[k] = R; buf[k+1] = G; buf[k+2] = B;
            }
        }
    }

    // En-face angiography — a branching vascular network with a foveal
    // avascular zone at centre, drawn over an en-face speckle field.
    function buildTree() {
        angioTree = [];
        var r = lcg(treeSeed);
        function branch(x, y, ang, len, wdt, depth) {
            if (depth > 5 || len < 0.02) return;
            var nx = x + Math.cos(ang) * len, ny = y + Math.sin(ang) * len;
            angioTree.push({ x1:x, y1:y, x2:nx, y2:ny, w:wdt, d:depth, ph: r() * 6.28 });
            var k = 2 + (r() < 0.3 ? 1 : 0);
            for (var i = 0; i < k; i++) {
                branch(nx, ny, ang + (r() - 0.5) * 1.25, len * (0.62 + r() * 0.22),
                       wdt * 0.68, depth + 1);
            }
        }
        var arms = 5 + Math.floor(r() * 3);
        for (var a = 0; a < arms; a++) {
            var ang = (a / arms) * 6.283 + r() * 0.5;
            branch(0.5 + Math.cos(ang) * 0.12, 0.5 + Math.sin(ang) * 0.12, ang,
                   0.13 + r() * 0.06, 2.6, 0);
        }
    }

    function drawAngioBand(y0, y1) {
        for (var y = y0; y < y1; y++) {
            if (y < 0 || y >= H) continue;
            for (var x = 0; x < W; x++) {
                var k = (y * W + x) * 4;
                // En-face substrate sits well down the greyscale — the
                // vessels are the subject, the choriocapillaris behind them
                // is texture. A bright field washes the network out.
                var sig = 0.022 * ((1 - P.speckle) + P.speckle * spk());
                var g = Math.log(1 + sig * 42 * P.gain) * 52;
                buf[k] = g; buf[k+1] = g; buf[k+2] = g;
            }
        }
    }

    function strokeTree() {
        ctx.lineCap = 'round';
        for (var i = 0; i < angioTree.length; i++) {
            var s = angioTree[i];
            // Flow pulse travelling outward through the tree
            var pulse = 0.5 + 0.5 * Math.sin(t * 2.4 - s.d * 0.9 + s.ph);
            var lit = 0.35 + 0.65 * pulse;
            var col = (i & 1) ? GREEN : RED;
            var a = P.flow * lit * 0.9 + 0.12;
            ctx.strokeStyle = 'rgba(' + Math.round(col[0]*lit + 200*(1-lit)) + ',' +
                                        Math.round(col[1]*lit + 200*(1-lit)) + ',' +
                                        Math.round(col[2]*lit + 200*(1-lit)) + ',' + a.toFixed(3) + ')';
            ctx.lineWidth = Math.max(1.1, s.w * (1.15 + 0.45 * pulse));
            ctx.beginPath();
            ctx.moveTo(s.x1 * W, s.y1 * H);
            ctx.lineTo(s.x2 * W, s.y2 * H);
            ctx.stroke();
        }
        // Foveal avascular zone — the vessel-free centre
        var grd = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.min(W,H) * 0.13);
        grd.addColorStop(0, 'rgba(0,0,0,0.92)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, W, H);
    }

    // Intravascular (catheter) OCT — polar acquisition, the vessel wall as
    // a ring, with the guidewire casting a radial shadow wedge.
    function drawCatheterWedge(a0, a1) {
        var gw = 2.2 + 0.25 * Math.sin(t * 0.3);      // guidewire angle
        for (var y = 0; y < H; y++) {
            for (var x = 0; x < W; x++) {
                var k = y * W + x;
                var th = thTab[k];
                // atan2 returns −π..π, so the offset has to be wrapped into
                // [0, 2π) — comparing it raw skips every negative angle,
                // which silently drops the whole upper half of the frame
                var da = Math.atan2(Math.sin(th - a0), Math.cos(th - a0));
                if (da < 0) da += 6.2831853;
                if (da > (a1 - a0)) continue;
                var r = rTab[k], k4 = k * 4;
                var sig;
                if (r < 0.16) {
                    sig = r < 0.10 ? 0.5 * spk() : 0.02 * spk();   // catheter body
                } else {
                    // Stretch the wall across the full radius so the ring
                    // fills the frame rather than sitting as a small disc,
                    // and lift it — a thin vessel wall doesn't attenuate
                    // like a full retinal stack, so the raw profile reads
                    // far too dark here.
                    var d = (r - 0.16) / 0.95;
                    var di = (d * H) | 0;
                    if (di >= H) di = H - 1;
                    sig = (profiles[Math.round(P.geom) % GEOMS.length] || buildProfile(Math.round(P.geom)))[di] * 2.2;
                    sig *= (1 - P.speckle) + P.speckle * spk();
                    // Guidewire shadow — a hard radial wedge, the classic artifact
                    var dg = Math.abs(Math.atan2(Math.sin(th - gw), Math.cos(th - gw)));
                    if (dg < 0.16) sig *= 0.05 + 0.95 * (dg / 0.16);
                }
                var g = Math.log(1 + sig * 42 * P.gain) * 62;
                if (g > 255) g = 255;
                var R = g, G = g, B = g;
                if (P.flow > 0 && r > 0.17 && r < 0.30) {
                    var fa = P.flow * 0.5;
                    var c = Math.sin(th * 3 + t) > 0 ? RED : GREEN;
                    R += (c[0]-R)*fa; G += (c[1]-G)*fa; B += (c[2]-B)*fa;
                }
                buf[k4] = R; buf[k4+1] = G; buf[k4+2] = B;
            }
        }
    }

    // ── Frame ─────────────────────────────────────────────────────
    var running = false, rafId = null, lastTs = 0;
    var FRAME_MS = 1000 / 30;

    function frame(ts) {
        if (!running) return;
        rafId = requestAnimationFrame(frame);
        if (ts - lastTs < FRAME_MS) return;
        lastTs = ts;

        var realloc = resize();
        if (!buf) return;
        t += 0.033;

        // A resize blanks the buffer — repaint a whole frame rather than
        // leaving everything black until the sweep has crossed it
        if (realloc) { buildAllProfiles(); rebuildSources(); primeFrame(); sweepPos = 0; return; }

        // AUTO cycles the modes so the page keeps moving
        if (Math.round(P.mode) === 0) {
            modeTimer += 0.033;
            if (modeTimer > 7.5) {
                modeTimer = 0;
                mode = mode % 3 + 1;
                clearBuf();
                if (mode === 2) { treeSeed = (treeSeed * 1103515245 + 12345) >>> 0; buildTree(); }
                if (mode === 1) regenVessels();
            }
        } else {
            var m = Math.round(P.mode);
            if (m !== mode) { mode = m; clearBuf(); if (mode === 2) buildTree(); if (mode === 1) regenVessels(); }
        }

        buildAllProfiles();

        // Re-cut the splice every few sweeps so the composite keeps changing
        if (P.splice > 1) {
            spliceAge += 0.033;
            if (spliceAge > 6.0) rebuildSources();
        }

        if (mode === 1) {
            var step = Math.max(1, (W * 0.012 * P.sweep) | 0);
            var x0 = sweepPos | 0;
            drawBScanBand(x0, x0 + step);
            sweepPos += step;
            if (sweepPos >= W) { sweepPos = 0; regenVessels(); }
            ctx.putImageData(img, 0, 0);
            drawSweepLine((sweepPos % W) / W, false);
        } else if (mode === 2) {
            var vstep = Math.max(1, (H * 0.02 * P.sweep) | 0);
            var y0 = sweepPos | 0;
            drawAngioBand(y0, y0 + vstep);
            sweepPos += vstep;
            if (sweepPos >= H) sweepPos = 0;
            ctx.putImageData(img, 0, 0);
            strokeTree();
            drawSweepLine((sweepPos % H) / H, true);
        } else {
            var aw = 0.10 * P.sweep + 0.03;
            drawCatheterWedge(sweepPos, sweepPos + aw);
            sweepPos += aw;
            if (sweepPos > 6.2832) sweepPos -= 6.2832;
            ctx.putImageData(img, 0, 0);
            drawRadialSweep(sweepPos);
        }

        drawHud();
    }

    function drawSweepLine(frac, horizontal) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        var g;
        if (horizontal) {
            g = ctx.createLinearGradient(0, frac * H - 10, 0, frac * H + 2);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(1, 'rgba(255,255,255,0.30)');
            ctx.fillStyle = g;
            ctx.fillRect(0, frac * H - 10, W, 12);
        } else {
            g = ctx.createLinearGradient(frac * W - 14, 0, frac * W + 2, 0);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(1, 'rgba(255,255,255,0.30)');
            ctx.fillStyle = g;
            ctx.fillRect(frac * W - 14, 0, 16, H);
        }
        ctx.restore();
    }

    function drawRadialSweep(ang) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(W/2, H/2);
        ctx.lineTo(W/2 + Math.cos(ang) * W, H/2 + Math.sin(ang) * W);
        ctx.stroke();
        ctx.restore();
    }

    function drawHud() {
        ctx.save();
        ctx.font = '9px "TerminalMono","Courier New",monospace';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(232,228,217,0.42)';
        ctx.fillText('CTIGEN.SYS · ' + MODE_NAMES[mode] +
                     ' · ' + GEOM_NAMES[Math.round(P.geom) % GEOM_NAMES.length] +
                     (P.splice > 1 ? ' · SPLICE×' + Math.round(P.splice) : '') +
                     ' · ' + W + '×' + H +
                     ' · ' + (P.gain * 20).toFixed(0) + 'dB', 6, 5);
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(232,228,217,0.22)';
        ctx.fillText('// ESC TO STOP', 6, H - 4);
        ctx.restore();
    }

    // ── Controls ──────────────────────────────────────────────────
    // Reuses the shared .synth-* control-panel language so the two
    // panels read as one system.
    var BAR_W = 16, rows = {}, drag = null;

    function fmtVal(def, v) {
        if (def.fmt === 'mode') return MODE_NAMES[Math.round(v)];
        if (def.fmt === 'geom') return GEOM_NAMES[Math.round(v) % GEOM_NAMES.length];
        if (def.fmt === 'px')   return Math.round(v) + 'px';
        if (def.fmt === 'i')    return String(Math.round(v));
        return v.toFixed(2);
    }
    function bar(f) {
        var n = Math.round(f * BAR_W), s = '';
        for (var i = 0; i < BAR_W; i++) s += (i < n ? '█' : '░');
        return s;
    }
    function paintRow(def) {
        var r = rows[def.id]; if (!r) return;
        var f = (P[def.id] - def.min) / (def.max - def.min);
        r.fill.textContent = bar(Math.max(0, Math.min(1, f)));
        r.val.textContent  = fmtVal(def, P[def.id]);
    }
    function paintAll() { for (var i = 0; i < PARAM_DEFS.length; i++) paintRow(PARAM_DEFS[i]); }

    function applyPointer(clientX) {
        if (!drag) return;
        var rect = drag.track.getBoundingClientRect();
        if (rect.width <= 0) return;
        var f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        var d = drag.def, v = d.min + f * (d.max - d.min);
        if (d.fmt === 'i' || d.fmt === 'mode' || d.fmt === 'geom' || d.fmt === 'px') v = Math.round(v);
        P[d.id] = v;
        if (d.id === 'layers' || d.id === 'atten' || d.id === 'geom') buildAllProfiles();
        // Anything that changes what the sources are has to rebuild them, or
        // the spliced bands keep pointing at the old tissue set
        if (d.id === 'splice' || d.id === 'geom') rebuildSources();
        // Dimension changes are picked up by resize() on the next frame,
        // which reallocates and re-primes; prime here too so a paused or
        // not-yet-running panel still updates
        if (d.id === 'pxw' || d.id === 'pxh') {
            if (resize()) { buildAllProfiles(); rebuildSources(); primeFrame(); sweepPos = 0; }
        }
        paintRow(d);
    }
    function onMove(e) {
        if (!drag) return;
        e.preventDefault();
        applyPointer(e.touches ? e.touches[0].clientX : e.clientX);
    }
    function onUp() {
        if (!drag) return;
        drag.track.classList.remove('synth-track-active');
        drag = null;
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);

    function makeRow(def) {
        var row = document.createElement('div'); row.className = 'synth-row';
        var label = document.createElement('span'); label.className = 'synth-label';
        label.textContent = def.label;
        var track = document.createElement('span'); track.className = 'synth-track';
        track.title = def.hint || '';
        var ob = document.createElement('span'); ob.className = 'synth-bracket'; ob.textContent = '[';
        var fill = document.createElement('span'); fill.className = 'synth-fill';
        var cb = document.createElement('span'); cb.className = 'synth-bracket'; cb.textContent = ']';
        track.appendChild(ob); track.appendChild(fill); track.appendChild(cb);
        var val = document.createElement('span'); val.className = 'synth-val';
        var hint = document.createElement('span'); hint.className = 'synth-hint';
        hint.textContent = def.hint ? '// ' + def.hint : '';

        function begin(e) {
            e.preventDefault();
            drag = { def: def, track: track };
            track.classList.add('synth-track-active');
            applyPointer(e.touches ? e.touches[0].clientX : e.clientX);
        }
        track.addEventListener('mousedown', begin);
        track.addEventListener('touchstart', begin, { passive: false });

        row.appendChild(label); row.appendChild(track);
        row.appendChild(val); row.appendChild(hint);
        rows[def.id] = { fill: fill, val: val };
        return row;
    }

    function build() {
        wrap = document.createElement('div');
        wrap.className = 'cti-panel';

        makeCanvas();
        wrap.appendChild(canvas);

        var head = document.createElement('div');
        head.className = 'synth-head';
        head.textContent = '┌─ CTIGEN ─ drag any bar to adjust ─┐';
        wrap.appendChild(head);

        for (var i = 0; i < PARAM_DEFS.length; i++) wrap.appendChild(makeRow(PARAM_DEFS[i]));

        var foot = document.createElement('div'); foot.className = 'synth-foot';
        var reset = document.createElement('button');
        reset.className = 'synth-btn'; reset.textContent = '[ RESET ]';
        reset.addEventListener('click', function () {
            for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) P[k] = DEFAULTS[k];
            mode = 1; sweepPos = 0; clearBuf(); buildAllProfiles(); rebuildSources(); paintAll();
        });
        // Export at the backing-store resolution, which is exactly the
        // WIDTH × HEIGHT set above regardless of how the canvas is displayed
        var save = document.createElement('button');
        save.className = 'synth-btn'; save.textContent = '[ EXPORT PNG ]';
        save.addEventListener('click', function () {
            if (!canvas) return;
            var a = document.createElement('a');
            a.download = 'ctigen_' + GEOM_NAMES[Math.round(P.geom) % GEOM_NAMES.length].toLowerCase() +
                         '_' + W + 'x' + H + '_' + Date.now() + '.png';
            a.href = canvas.toDataURL('image/png');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        });

        var reseed = document.createElement('button');
        reseed.className = 'synth-btn'; reseed.textContent = '[ RESEED ]';
        reseed.addEventListener('click', function () {
            treeSeed = (treeSeed * 1103515245 + 12345) >>> 0;
            t += 7.7;                       // shifts every seeded draw
            regenVessels(); buildTree(); rebuildSources();
            clearBuf(); primeFrame(); sweepPos = 0;
        });

        var close = document.createElement('button');
        close.className = 'synth-btn'; close.textContent = '[ CLOSE ]';
        close.addEventListener('click', function () { stop(); });
        foot.appendChild(save); foot.appendChild(reseed);
        foot.appendChild(reset); foot.appendChild(close);
        wrap.appendChild(foot);
        return wrap;
    }

    // Fill the whole frame in one pass. The sweep is the point of the
    // thing, but opening on a black rectangle and waiting for the beam to
    // cross is the wrong first impression — this lays down a complete scan
    // that the sweep then starts overwriting.
    function primeFrame() {
        if (!buf) return;
        buildAllProfiles();
        if (mode === 2) {
            drawAngioBand(0, H);
            ctx.putImageData(img, 0, 0);
            strokeTree();
        } else if (mode === 3) {
            drawCatheterWedge(0, 6.2832);
            ctx.putImageData(img, 0, 0);
        } else {
            drawBScanBand(0, W);
            ctx.putImageData(img, 0, 0);
        }
        drawHud();
    }

    // ── Public API ────────────────────────────────────────────────
    function isRunning() { return running && !!wrap && document.body.contains(wrap); }

    function start() {
        if (isRunning()) return true;
        rows = {};
        container.appendChild(build());
        // Pin the pane open and taller than usual — this is a page, not a line
        container.style.flex   = 'none';
        container.style.height = '68vh';
        container.scrollTop    = wrap.offsetTop;

        W = H = 0;
        resize();
        regenVessels(); buildTree(); buildAllProfiles(); rebuildSources();
        paintAll();
        mode = Math.round(P.mode) === 0 ? 1 : Math.round(P.mode);
        sweepPos = 0; modeTimer = 0; lastTs = 0;
        primeFrame();          // full scan up front, so it opens on an image
        running = true;
        rafId = requestAnimationFrame(frame);
        return true;
    }

    function stop() {
        running = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
        wrap = null; canvas = null; ctx = null; img = null; buf = null;
        rows = {}; drag = null;
        if (!(window.__synthUI && window.__synthUI.isOpen())) {
            container.style.flex   = '';
            container.style.height = '';
        }
    }

    window.addEventListener('resize', function () { if (running) { W = H = 0; resize(); } });

    return { start: start, stop: stop, isRunning: isRunning, refresh: paintAll };
})();
