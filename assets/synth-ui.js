// ── SYNTH control panel ────────────────────────────────────────────
// ASCII mixer rendered as DOM inside the AUDIO.SYS output pane. Each row
// is a click-and-drag bar; values write straight through to music.js's
// param API. Built from PARAM_DEFS so the panel and the audio engine can
// never drift out of sync.
window.__synthUI = (function () {
    'use strict';

    var BAR_W    = 18;            // track width in characters
    var FILL     = '█';
    var EMPTY    = '░';
    var container = document.getElementById('audio-sys-out');

    var panel   = null;           // root element while open, else null
    var rows    = {};             // id → { fill, val } spans
    var drag    = null;           // { id, def, track } while dragging

    function music() { return window.__music; }

    // ── Formatting ─────────────────────────────────────────────────
    function fmtVal(def, v) {
        if (def.fmt === 'hz') {
            return v >= 1000 ? (v / 1000).toFixed(2) + 'k' : Math.round(v) + '';
        }
        if (def.fmt === 'i') return String(Math.round(v));
        return v.toFixed(3);
    }

    function bar(frac) {
        var n = Math.round(frac * BAR_W), s = '';
        for (var i = 0; i < BAR_W; i++) s += (i < n ? FILL : EMPTY);
        return s;
    }

    function fracOf(def, v) {
        return Math.max(0, Math.min(1, (v - def.min) / (def.max - def.min)));
    }

    function valueAt(def, frac) {
        var v = def.min + frac * (def.max - def.min);
        if (def.fmt === 'i') v = Math.round(v);
        return Math.max(def.min, Math.min(def.max, v));
    }

    // ── Row rendering ──────────────────────────────────────────────
    function paintRow(def) {
        var r = rows[def.id];
        if (!r) return;
        var v = music().getParam(def.id);
        r.fill.textContent = bar(fracOf(def, v));
        r.val.textContent  = fmtVal(def, v);
    }

    function paintAll() {
        var defs = music().getParamDefs();
        for (var i = 0; i < defs.length; i++) paintRow(defs[i]);
    }

    // ── Drag / click handling ──────────────────────────────────────
    // The track is monospace text, so pointer-x within its bounding box
    // maps linearly onto the parameter range.
    function applyFromPointer(clientX) {
        if (!drag) return;
        var rect = drag.track.getBoundingClientRect();
        if (rect.width <= 0) return;
        var frac = (clientX - rect.left) / rect.width;
        frac = Math.max(0, Math.min(1, frac));
        music().setParam(drag.id, valueAt(drag.def, frac));
        paintRow(drag.def);
    }

    function onPointerMove(e) {
        if (!drag) return;
        e.preventDefault();
        var x = e.touches ? e.touches[0].clientX : e.clientX;
        applyFromPointer(x);
    }

    function onPointerUp() {
        if (!drag) return;
        drag.track.classList.remove('synth-track-active');
        drag = null;
    }

    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup',   onPointerUp);
    document.addEventListener('touchmove', onPointerMove, { passive: false });
    document.addEventListener('touchend',  onPointerUp);
    document.addEventListener('touchcancel', onPointerUp);

    function beginDrag(def, track, e) {
        e.preventDefault();
        drag = { id: def.id, def: def, track: track };
        track.classList.add('synth-track-active');
        applyFromPointer(e.touches ? e.touches[0].clientX : e.clientX);
    }

    // ── Build ──────────────────────────────────────────────────────
    function makeRow(def) {
        var row = document.createElement('div');
        row.className = 'synth-row';

        var label = document.createElement('span');
        label.className = 'synth-label';
        label.textContent = def.label;

        var track = document.createElement('span');
        track.className = 'synth-track';
        track.title = def.hint || '';

        var open = document.createElement('span');
        open.className = 'synth-bracket';
        open.textContent = '[';
        var fill = document.createElement('span');
        fill.className = 'synth-fill';
        var close = document.createElement('span');
        close.className = 'synth-bracket';
        close.textContent = ']';
        track.appendChild(open); track.appendChild(fill); track.appendChild(close);

        var val = document.createElement('span');
        val.className = 'synth-val';

        var hint = document.createElement('span');
        hint.className = 'synth-hint';
        hint.textContent = def.hint ? '// ' + def.hint : '';

        track.addEventListener('mousedown',  function (e) { beginDrag(def, track, e); });
        track.addEventListener('touchstart', function (e) { beginDrag(def, track, e); },
                               { passive: false });

        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(val);
        row.appendChild(hint);

        rows[def.id] = { fill: fill, val: val };
        return row;
    }

    function build() {
        var defs = music().getParamDefs();

        panel = document.createElement('div');
        panel.className = 'synth-panel';

        var head = document.createElement('div');
        head.className = 'synth-head';
        head.textContent = '┌─ SYNTH ─ drag any bar to adjust ─┐';
        panel.appendChild(head);

        var lastGroup = null;
        for (var i = 0; i < defs.length; i++) {
            if (defs[i].g !== lastGroup) {
                lastGroup = defs[i].g;
                var g = document.createElement('div');
                g.className = 'synth-group';
                g.textContent = '│ ' + lastGroup;
                panel.appendChild(g);
            }
            panel.appendChild(makeRow(defs[i]));
        }

        var foot = document.createElement('div');
        foot.className = 'synth-foot';

        var reset = document.createElement('button');
        reset.className = 'synth-btn';
        reset.textContent = '[ RESET ALL ]';
        reset.addEventListener('click', function () {
            music().resetParams();
            paintAll();
        });

        var close = document.createElement('button');
        close.className = 'synth-btn';
        close.textContent = '[ CLOSE ]';
        close.addEventListener('click', function () { hide(); });

        foot.appendChild(reset);
        foot.appendChild(close);
        panel.appendChild(foot);

        if (!music().isReady()) {
            var warn = document.createElement('div');
            warn.className = 'synth-warn';
            warn.textContent = '// AUDIO OFFLINE — SETTINGS APPLY WHEN SOUND STARTS';
            panel.appendChild(warn);
        }

        return panel;
    }

    // ── Public API ─────────────────────────────────────────────────
    function isOpen() {
        return !!panel && document.body.contains(panel);
    }

    function show() {
        if (!music() || !music().getParamDefs) return false;
        if (isOpen()) return true;
        rows = {};
        container.appendChild(build());
        paintAll();
        // The output pane is `flex:1` (flex-basis:0%), so it collapses to its
        // content height unless pulled out of the flex algorithm — same fix
        // the ASCII visualiser needs. Give the panel real room to sit in.
        container.style.flex   = 'none';
        container.style.height = getComputedStyle(container).maxHeight;
        // Scroll the panel's top into view, not the pane's bottom — otherwise
        // opening SYNTH lands on the last group instead of the first.
        container.scrollTop    = panel.offsetTop;
        return true;
    }

    function hide() {
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        panel = null;
        rows  = {};
        drag  = null;
        // Only release the pinned height if the visualiser isn't using it.
        if (!(window.__asciiVis && window.__asciiVis.isRunning())) {
            container.style.flex   = '';
            container.style.height = '';
        }
    }

    function toggle() {
        if (isOpen()) { hide(); return false; }
        return show();
    }

    return { show: show, hide: hide, toggle: toggle, isOpen: isOpen,
             refresh: paintAll };
})();
