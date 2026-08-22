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

    // ── Canvas (created dynamically, z-index 160, above audio-sys 150) ─
    var canvas = document.createElement('canvas');
    canvas.id  = 'ascii-vis-canvas';
    canvas.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;' +
        'z-index:160;display:none;pointer-events:none;background:#000;';
    document.body.appendChild(canvas);

    var ctx2d = canvas.getContext('2d');
    var CW = 10, CH = 17;
    var COLS = 0, ROWS = 0;
    var rowShifts = [];

    function resize() {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx2d.font = '14px "Courier New",Courier,monospace';
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

    // ── Animation state ───────────────────────────────────────────────
    var running    = false;
    var rafId      = null;
    var t          = 0;
    var colorPhase = 0;
    var glitchAmt  = 0;
    var flashAmt   = 0;
    var lastBass   = 0;
    var artIdx     = 0;
    var artX       = 0, artY = 0;
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

        // ── Beat detection → glitch trigger ──────────────────────────
        var delta = bass - lastBass;
        if (delta > 0.12) {
            flashAmt  = Math.min(1.0, flashAmt  + delta * 2.0);
            glitchAmt = Math.min(1.0, glitchAmt + delta * 3.0);
            for (var ri = 0; ri < 4; ri++) {
                var rr = Math.floor(Math.random() * ROWS);
                if (rr < rowShifts.length) {
                    rowShifts[rr] = (Math.random() < 0.5 ? 1 : -1) *
                                    (Math.floor(Math.random() * 5) + 1);
                }
            }
            if (--artCooldown <= 0) {
                artIdx = (artIdx + 1) % ART.length;
                var art = ART[artIdx];
                artX = Math.floor(Math.random() * Math.max(1, COLS - art[0].length - 2)) + 1;
                artY = Math.floor(Math.random() * Math.max(1, ROWS - art.length  - 4)) + 2;
                artCooldown = 7 + Math.floor(Math.random() * 9);
            }
        }
        lastBass = bass * 0.55 + lastBass * 0.45;

        // Decay
        flashAmt  = Math.max(0, flashAmt  - 0.07);
        glitchAmt = Math.max(0, glitchAmt - 0.035);
        for (var j = 0; j < rowShifts.length; j++) {
            if (rowShifts[j] !== 0 && Math.random() < 0.22) rowShifts[j] = 0;
        }
        colorPhase += 0.0025 + energy * 0.007;
        scanY = (scanY + 2 + Math.floor(energy * 4)) % (ROWS + 4);
        t += 0.018;

        // ── Render ────────────────────────────────────────────────────
        ctx2d.fillStyle = 'rgba(0,0,0,0.82)';
        ctx2d.fillRect(0, 0, canvas.width, canvas.height);
        ctx2d.font = '14px "Courier New",Courier,monospace';
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
        ctx2d.fillStyle = 'rgba(255,255,255,0.18)';
        ctx2d.font = '11px "Courier New",Courier,monospace';
        ctx2d.textBaseline = 'bottom';
        ctx2d.fillText('// TYPE ASCII + ENTER TO STOP   ESC TO EXIT', 10, canvas.height - 4);
    }

    function getChar(col, row, bass, mid, high, energy, art) {
        // ── Art scene overlay ──
        var ar = row - artY, ac = col - artX;
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

        if (glitchAmt > 0.25 && Math.random() < glitchAmt * 0.10) {
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
        running    = true;
        t          = 0;
        colorPhase = 0;
        glitchAmt  = 0;
        flashAmt   = 0;
        lastBass   = 0;
        artIdx     = 0;
        var a0     = ART[0];
        artX       = Math.floor((COLS - a0[0].length) / 2);
        artY       = Math.floor((ROWS - a0.length)    / 2);
        artCooldown = 12;
        scanY      = 0;
        lastTs     = 0;
        canvas.style.display = 'block';
        rafId = requestAnimationFrame(loop);
    }

    function stop() {
        running = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        canvas.style.display = 'none';
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    }

    return {
        start:     start,
        stop:      stop,
        isRunning: function () { return running; },
    };
})();
