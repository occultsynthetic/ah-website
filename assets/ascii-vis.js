window.__asciiVis = (function () {
    'use strict';

    // ── Character palettes ────────────────────────────────────────────
    var BLOCK = '█▓▒░▄▀▌▐■◆';
    var LINES = '┼┤├┬┴─│║═╔╗╚╝╬╪┌┐└┘';
    var LIGHT = '.·:;,\'"`^-_+~';
    var NOISE = '@#$%&!?*=<>{}[]|/\\~^';

    // ── ASCII art scenes ──────────────────────────────────────────────
    var ART = [
        // 0: eye / radial
        [
            '   ╔══════════╗   ',
            ' ╔═╝ ▄▄████▄▄ ╚═╗ ',
            '╔╝  ██▓▓██▓▓██  ╚╗',
            '║  ███▓████▓███  ║',
            '╚╗  ██▓▓██▓▓██  ╔╝',
            ' ╚═╗ ▀▀████▀▀ ╔═╝ ',
            '   ╚══════════╝   ',
        ],
        // 1: circuit board
        [
            '┌───┬───┬───┬───┐',
            '│   └─┐ └─┐ │   │',
            '├──   └─┐ └──   ┤',
            '│  ┌───  └─  ┌  │',
            '└──┴──────────┴──┘',
        ],
        // 2: spectrum bars
        [
            '▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▃',
            '▂▃▄▅▆▇██▇▆▅▄▃▂▃▄▅',
            '▃▄▅▆▇█████▇▆▅▄▅▆▇',
            '▄▅▆▇████████▇▆▇██',
            '▃▄▅▆▇█████▇▆▅▄▅▆▇',
            '▂▃▄▅▆▇██▇▆▅▄▃▂▃▄▅',
            '▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▃',
        ],
        // 3: data grid
        [
            '╔═══╤═══╤═══╤═══╗',
            '║░▒▓│▓▒░│░▒▓│▓▒░║',
            '╠═══╪═══╪═══╪═══╣',
            '║▓▒░│░▒▓│▓▒░│░▒▓║',
            '╠═══╪═══╪═══╪═══╣',
            '║░▒▓│▓▒░│░▒▓│▓▒░║',
            '╚═══╧═══╧═══╧═══╝',
        ],
        // 4: signal / pulse trace
        [
            '────────┐    ┌──────',
            '        └────┘      ',
            '  ──┐   ┌────────┐  ',
            '    └───┘        └──',
        ],
        // 5: geometric diamond
        [
            '        ╱╲        ',
            '      ╱╱  ╲╲      ',
            '    ╱╱ ████ ╲╲    ',
            '  ╱╱ ████████ ╲╲  ',
            '  ╲╲ ████████ ╱╱  ',
            '    ╲╲ ████ ╱╱    ',
            '      ╲╲  ╱╱      ',
            '        ╲╱        ',
        ],
    ];

    // ── Pre-built colour lookup arrays (8 brightness steps) ──────────
    // Avoids string allocation per cell per frame
    var REDS   = ['#300','#511','#722','#933','#b44','#d55','#f66','#f99'];
    var GREENS = ['#030','#151','#272','#393','#4b4','#5d5','#6f6','#8f8'];
    var BLUES  = ['#003','#115','#227','#339','#44b','#55d','#66f','#99f'];

    // ── Canvases (live inside the audio-sys terminal's output pane) ───
    // `canvas`     — crisp characters, own trail/decay pass.
    // `glowCanvas` — blurred, screen-blended copy of the frame above it,
    //                giving the same soft halo as the terminal's text-shadow
    //                plus a CRT-phosphor bleed between neighbouring glyphs.
    var container = document.getElementById('audio-sys-out');

    // `position:fixed` + a rect synced from getBoundingClientRect(), rather
    // than `position:absolute` inset to the container: #audio-sys-out
    // scrolls (overflow-y:auto) and auto-scrolls to bottom on every new
    // line, which would carry an absolutely-positioned (i.e. scrolls-with-
    // content) canvas pinned at the top of that content out of view.
    // Viewport-fixed coordinates are immune to the container's own scroll.
    var canvas = document.createElement('canvas');
    canvas.id  = 'ascii-vis-canvas';
    canvas.style.cssText =
        'position:fixed;z-index:5;display:none;pointer-events:none;background:#000;';
    container.appendChild(canvas);

    var glowCanvas = document.createElement('canvas');
    glowCanvas.id  = 'ascii-vis-glow';
    glowCanvas.style.cssText =
        'position:fixed;z-index:6;display:none;pointer-events:none;' +
        'mix-blend-mode:screen;opacity:0.9;filter:blur(3px) saturate(1.35);';
    container.appendChild(glowCanvas);

    var ctx2d = canvas.getContext('2d');
    var glowCtx = glowCanvas.getContext('2d');
    var CW = 10, CH = 17;
    var COLS = 0, ROWS = 0;
    var rowShifts = [];

    function syncRect() {
        var rect = container.getBoundingClientRect();
        var top  = Math.round(rect.top)  + 'px';
        var left = Math.round(rect.left) + 'px';
        canvas.style.top  = top;
        canvas.style.left = left;
        glowCanvas.style.top  = top;
        glowCanvas.style.left = left;
        return rect;
    }

    function resize() {
        var rect = syncRect();
        var w = Math.max(1, Math.round(rect.width));
        var h = Math.max(1, Math.round(rect.height));
        canvas.style.width  = w + 'px';
        canvas.style.height = h + 'px';
        glowCanvas.style.width  = w + 'px';
        glowCanvas.style.height = h + 'px';
        canvas.width  = w;
        canvas.height = h;
        glowCanvas.width  = w;
        glowCanvas.height = h;
        ctx2d.font = '14px "IBMPlexMonoText","Courier New",Courier,monospace';
        var mw = ctx2d.measureText('M').width;
        CW   = Math.max(8, Math.ceil(mw));
        CH   = Math.round(CW * 1.72);
        COLS = Math.floor(canvas.width  / CW);
        ROWS = Math.floor(canvas.height / CH);
        var need = ROWS + 4;
        rowShifts = [];
        for (var i = 0; i < need; i++) rowShifts.push(0);
    }
    resize();
    window.addEventListener('resize', resize);
    if (window.ResizeObserver) {
        new ResizeObserver(resize).observe(container);
    }

    // ── Animation state ───────────────────────────────────────────────
    var running    = false;
    var rafId      = null;
    var t          = 0;
    var colorPhase = 0;
    var glitchAmt  = 0;
    var flashAmt   = 0;
    var lastBass   = 0;
    var lastMid    = 0;
    var lastHigh   = 0;
    var artIdx     = 0;
    var artX       = 0, artY = 0;
    var artShakeX  = 0, artShakeY = 0;
    var artCooldown = 0;
    var scanY      = 0;
    var freqBuf    = null;  // reused Uint8Array, avoids GC per frame

    // ── Band averages ─────────────────────────────────────────────────
    function bandAvg(lo, hi) {
        var s = 0, n = 0;
        var cap = Math.min(hi, freqBuf.length);
        for (var i = lo; i < cap; i++) { s += freqBuf[i]; n++; }
        return n > 0 ? s / n / 255 : 0;
    }

    // ── 24fps limiter ─────────────────────────────────────────────────
    var FRAME_MS = 1000 / 24;
    var lastTs   = 0;

    function loop(ts) {
        if (!running) return;
        rafId = requestAnimationFrame(loop);
        if (ts - lastTs < FRAME_MS) return;
        lastTs = ts;

        syncRect();

        // ── Fetch audio frequency data ────────────────────────────────
        var an   = window.__music && window.__music.getAnalyser
                    ? window.__music.getAnalyser() : null;
        var bass = 0, mid = 0, high = 0, energy = 0;

        if (an) {
            var binCount = an.frequencyBinCount;
            if (!freqBuf || freqBuf.length !== binCount) {
                freqBuf = new Uint8Array(binCount);
            }
            an.getByteFrequencyData(freqBuf);
            bass   = bandAvg(0,  4);
            mid    = bandAvg(4,  32);
            high   = bandAvg(32, 96);
            energy = bass * 0.50 + mid * 0.33 + high * 0.17;
        }

        // ── Transient detection (bass+mid+high) → glitch trigger ──────
        var transient = Math.max(0, bass - lastBass) +
                         Math.max(0, mid  - lastMid)  * 0.6 +
                         Math.max(0, high - lastHigh) * 0.5;

        if (transient > 0.035) {
            flashAmt  = Math.min(1.0, flashAmt  + transient * 1.8);
            glitchAmt = Math.min(1.0, glitchAmt + transient * 2.6);
            var shiftCount = 2 + Math.floor(transient * 14);
            for (var ri = 0; ri < shiftCount; ri++) {
                var rr = Math.floor(Math.random() * ROWS);
                if (rr < rowShifts.length) {
                    rowShifts[rr] = (Math.random() < 0.5 ? 1 : -1) *
                                    (Math.floor(Math.random() * 6) + 1);
                }
            }
            if (transient > 0.08 && --artCooldown <= 0) {
                artIdx = (artIdx + 1) % ART.length;
                var art = ART[artIdx];
                artX = Math.floor(Math.random() * Math.max(1, COLS - art[0].length - 2)) + 1;
                artY = Math.floor(Math.random() * Math.max(1, ROWS - art.length  - 4)) + 2;
                artCooldown = 4 + Math.floor(Math.random() * 7);
            }
        }
        lastBass = bass * 0.55 + lastBass * 0.45;
        lastMid  = mid  * 0.55 + lastMid  * 0.45;
        lastHigh = high * 0.55 + lastHigh * 0.45;

        // Ambient floor — keeps a baseline flicker alive through loud
        // passages instead of only reacting to sharp onsets.
        glitchAmt = Math.max(glitchAmt, energy * 0.22);

        // Decay
        flashAmt  = Math.max(0, flashAmt  - 0.07);
        glitchAmt = Math.max(0, glitchAmt - 0.028);
        for (var j = 0; j < rowShifts.length; j++) {
            if (rowShifts[j] !== 0 && Math.random() < 0.22) rowShifts[j] = 0;
        }
        colorPhase += 0.004 + energy * 0.014;
        scanY = (scanY + 2 + Math.floor(energy * 6)) % (ROWS + 4);
        t += 0.02 + energy * 0.05;

        artShakeX = glitchAmt > 0.3 ? Math.round((Math.random() - 0.5) * 3) : 0;
        artShakeY = glitchAmt > 0.3 ? Math.round((Math.random() - 0.5) * 2) : 0;

        // ── Render (crisp pass) ─────────────────────────────────────────
        var trailAlpha = 0.88 - Math.min(0.34, energy * 0.30 + flashAmt * 0.22);
        ctx2d.fillStyle = 'rgba(0,0,0,' + trailAlpha.toFixed(3) + ')';
        ctx2d.fillRect(0, 0, canvas.width, canvas.height);
        ctx2d.font = '14px "IBMPlexMonoText","Courier New",Courier,monospace';
        ctx2d.textBaseline = 'top';

        var curArt = ART[artIdx];

        for (var row = 0; row < ROWS; row++) {
            var shift = row < rowShifts.length ? rowShifts[row] : 0;
            for (var col = 0; col < COLS; col++) {
                var sc = col + shift;
                if (sc < 0 || sc >= COLS) continue;
                var ch = getChar(sc, row, bass, mid, high, energy, curArt);
                if (!ch || ch === ' ') continue;
                var scanBoost = (Math.abs(row - scanY) < 2) ? 1 : 0;
                ctx2d.fillStyle = getColor(sc, row, energy, scanBoost);
                ctx2d.fillText(ch, col * CW, row * CH);
            }
        }

        // hint text so the user knows how to close
        ctx2d.fillStyle = 'rgba(255,255,255,0.22)';
        ctx2d.font = '10px "IBMPlexMonoText","Courier New",Courier,monospace';
        ctx2d.textBaseline = 'bottom';
        ctx2d.fillText('// ESC TO STOP', 6, canvas.height - 3);

        // ── Glow pass — blurred, screen-blended copy = phosphor bloom ──
        glowCtx.clearRect(0, 0, glowCanvas.width, glowCanvas.height);
        glowCtx.globalCompositeOperation = 'source-over';
        glowCtx.globalAlpha = Math.min(1, 0.55 + energy * 0.35 + flashAmt * 0.5);
        glowCtx.drawImage(canvas, 0, 0);

        // Chromatic fringing on hard hits — RGB bleed, like CRT edge tear
        if (glitchAmt > 0.1) {
            var off = 1 + Math.floor(glitchAmt * 3);
            glowCtx.globalCompositeOperation = 'lighter';
            glowCtx.globalAlpha = Math.min(0.6, glitchAmt * 0.55);
            glowCtx.drawImage(canvas, -off, 0);
            glowCtx.drawImage(canvas, off, 0);
        }
        glowCtx.globalAlpha = 1;
        glowCanvas.style.filter = 'blur(' + (2.5 + flashAmt * 3.5).toFixed(1) +
                                   'px) saturate(1.35)';
    }

    function getChar(col, row, bass, mid, high, energy, art) {
        // ── Art scene overlay ──
        var ar = row - artY - artShakeY, ac = col - artX - artShakeX;
        if (ar >= 0 && ar < art.length &&
            ac >= 0 && ac < art[ar].length) {
            var artCh = art[ar].charAt(ac);
            if (artCh !== ' ') {
                if (Math.random() < glitchAmt * 0.45) {
                    return NOISE.charAt(Math.floor(Math.random() * NOISE.length));
                }
                return artCh;
            }
        }

        // ── Spectrum bars — bottom 6 rows ──
        if (freqBuf && row >= ROWS - 6) {
            var bin    = Math.floor(col * 80 / COLS);
            var binVal = (freqBuf[bin] || 0) / 255;
            var barRow = ROWS - 1 - row;  // 0 = bottom, 5 = top
            if (barRow < Math.floor(binVal * 6)) {
                var barChars = '▁▂▃▄▅▆▇█';
                return barChars.charAt(Math.min(7, Math.floor(binVal * 8)));
            }
            return ' ';
        }

        // ── Wave interference field ──
        var nx = col / COLS;
        var ny = row / ROWS;
        var w1 = Math.sin(nx * 16 + t * 1.0)  * Math.cos(ny * 10 - t * 0.65);
        var w2 = Math.sin(nx *  7 - t * 0.55  + bass * 2.8) * 0.6;
        var w3 = Math.cos(nx * 22 + ny * 14   + t * 0.80)   * 0.3;
        var wave = ((w1 + w2 + w3) / 1.9 + 1.0) * 0.5;  // 0..1

        var density = wave * (0.15 + energy * 0.60);

        if (glitchAmt > 0.12 && Math.random() < glitchAmt * 0.14) {
            return NOISE.charAt(Math.floor(Math.random() * NOISE.length));
        }
        if (density > 0.70) return BLOCK.charAt(Math.floor(wave * BLOCK.length) % BLOCK.length);
        if (density > 0.50) return LINES.charAt(Math.floor(wave * LINES.length) % LINES.length);
        if (density > 0.34) return LIGHT.charAt(Math.floor(wave * LIGHT.length) % LIGHT.length);
        return ' ';
    }

    function getColor(col, row, energy, scanBoost) {
        var fBin   = freqBuf ? Math.floor(col * 64 / COLS) : 0;
        var fVal   = freqBuf ? (freqBuf[fBin] || 0) / 255 : energy;
        var cp     = (colorPhase + col * 0.018 + row * 0.030) % (Math.PI * 2);
        var phase3 = (cp / (Math.PI * 2)) * 3;  // 0..3

        var bright = Math.min(7, Math.floor(
            fVal * 5.5 + energy * 1.5 + flashAmt * 2.5 + scanBoost * 2
        ));

        if (phase3 < 1) return REDS  [bright];
        if (phase3 < 2) return GREENS[bright];
        return                BLUES  [bright];
    }

    // ── Public API ────────────────────────────────────────────────────
    function start() {
        if (running) return;
        // #audio-sys-out is `flex:1`, which expands to flex-basis:0% — an
        // explicit height on a flex item is only honoured as its basis
        // when flex-basis is `auto`, so setting height alone here is a
        // no-op under flex-basis:0%. Take it out of the flex algorithm
        // entirely so height applies as normal block sizing.
        container.style.flex = 'none';
        container.style.height = getComputedStyle(container).maxHeight;
        resize();
        running    = true;
        t          = 0;
        colorPhase = 0;
        glitchAmt  = 0;
        flashAmt   = 0;
        lastBass   = 0;
        lastMid    = 0;
        lastHigh   = 0;
        artIdx     = 0;
        var a0     = ART[0];
        artX       = Math.floor((COLS - a0[0].length) / 2);
        artY       = Math.floor((ROWS - a0.length)    / 2);
        artShakeX  = 0;
        artShakeY  = 0;
        artCooldown = 8;
        scanY      = 0;
        lastTs     = 0;
        canvas.style.display = 'block';
        glowCanvas.style.display = 'block';
        rafId = requestAnimationFrame(loop);
    }

    function stop() {
        running = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        canvas.style.display = 'none';
        glowCanvas.style.display = 'none';
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        glowCtx.clearRect(0, 0, glowCanvas.width, glowCanvas.height);
        container.style.flex = '';
        container.style.height = '';
    }

    return {
        start:     start,
        stop:      stop,
        isRunning: function () { return running; },
    };
})();
