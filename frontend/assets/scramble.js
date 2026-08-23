(function () {
    var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/-|><:.[]{}';

    function rndChar() {
        return CHARS[Math.floor(Math.random() * CHARS.length)];
    }

    // Collect leaf elements (no child elements) that have non-empty text.
    // Skips invisible/structural tags.
    function leafEls(root) {
        var skip = { SCRIPT:1, STYLE:1, INPUT:1, TEXTAREA:1, BR:1 };
        var out = [];
        (function walk(el) {
            if (skip[el.tagName]) return;
            var kids = Array.prototype.slice.call(el.children);
            if (kids.length === 0) {
                if (el.textContent.trim()) out.push(el);
            } else {
                kids.forEach(walk);
            }
        })(root);
        return out;
    }

    // Cancel flag per element — bump generation to abort a running animation.
    var gen = new WeakMap();

    function scrambleEl(el, delay, opts) {
        var original = el.textContent;
        if (!original.trim()) return;

        var myGen = (gen.get(el) || 0) + 1;
        gen.set(el, myGen);

        opts = opts || {};
        var mode = opts.mode || (Math.random() < 0.5 ? 'seq' : 'rand');
        var dur  = (opts.minDur || 1008) + Math.random() * (opts.maxDur || 1152);

        // Immediately fill with noise so original text never flashes visible.
        var noise = '';
        for (var k = 0; k < original.length; k++) {
            var oc = original[k];
            noise += (oc === ' ' || oc === ' ') ? oc : rndChar();
        }
        el.textContent = noise;

        setTimeout(function () {
            if (gen.get(el) !== myGen) return; // superseded
            var t0 = performance.now();

            (function frame(now) {
                if (gen.get(el) !== myGen) { el.textContent = original; return; }
                var t   = Math.min((now - t0) / dur, 1.0);
                var len = original.length;
                var out = '';

                if (mode === 'seq') {
                    var n = Math.round(t * len);
                    for (var i = 0; i < len; i++) {
                        var c = original[i];
                        out += (i < n || c === ' ' || c === ' ') ? c : rndChar();
                    }
                } else {
                    var thresh = Math.pow(t, 0.65);
                    for (var i = 0; i < len; i++) {
                        var c = original[i];
                        out += (c === ' ' || c === ' ' || Math.random() < thresh)
                             ? c : rndChar();
                    }
                }

                el.textContent = out;
                if (t < 1.0) requestAnimationFrame(frame);
                else el.textContent = original;
            })(performance.now());
        }, delay);
    }

    function scrambleAll(root, base, opts) {
        base = base || 0;
        var els = leafEls(root);
        els.forEach(function (el, i) {
            scrambleEl(el, base + Math.min(i, 18) * 84, opts);
        });
    }

    // ── content panels 0-2 ──────────────────────────────────────────
    for (var j = 0; j < 3; j++) {
        (function (id) {
            var panel = document.getElementById('panel-' + id);
            if (!panel) return;
            new MutationObserver(function () {
                if (!panel.classList.contains('panel-hidden')) scrambleAll(panel);
            }).observe(panel, { attributes: true, attributeFilter: ['class'] });
        })(j);
    }

    // ── notes panel: header on open, body when note loads ──────────
    var notesBody  = document.getElementById('notes-body');
    var notesTitle = document.getElementById('notes-title');

    var notesPanel = document.getElementById('notes-panel');
    if (notesPanel) {
        new MutationObserver(function () {
            if (!notesPanel.classList.contains('notes-hidden')) {
                var hdr = document.getElementById('notes-header');
                if (hdr) scrambleAll(hdr);
                var tree = document.getElementById('notes-tree');
                if (tree) scrambleAll(tree, 192);
            }
        }).observe(notesPanel, { attributes: true, attributeFilter: ['class'] });
    }

    // Expose for external callers (e.g. CIPHER egg in title.js).
    window.__scramble = { all: scrambleAll, el: scrambleEl };

    // Called directly from Rust (open_idx) via js_sys::eval — no MO race.
    window.__scrambleNotesBody = function () {
        if (notesTitle) scrambleEl(notesTitle, 0);
        if (notesBody)  scrambleAll(notesBody, 40, { mode: 'seq', minDur: 504, maxDur: 576 });
        if (window.__music && notesTitle) window.__music.setTextSeed(notesTitle.textContent || '');
    };

    // ── Mobile detection + audio status ──────────────────────────────
    var isMobile = /Mobi|Android/i.test(navigator.userAgent) || window.innerWidth <= 768;
    var audioInitialized = false;

    function setAudioStatus(online) {
        var el = document.getElementById('audio-status');
        if (!el) return;
        el.textContent = online ? 'ONLINE' : 'OFFLINE';
        el.className   = online ? 'online'  : 'offline';
    }

    // Mobile: override the HTML default of ONLINE
    if (isMobile) setAudioStatus(false);

    // Click audio-status to toggle play / pause
    (function () {
        var el = document.getElementById('audio-status');
        if (!el) return;
        el.addEventListener('click', function () {
            if (!audioInitialized) {
                if (window.__music) {
                    window.__music.init();
                    audioInitialized = true;
                    setAudioStatus(true);
                }
                return;
            }
            if (el.classList.contains('online')) {
                if (window.__music) window.__music.pause();
                setAudioStatus(false);
            } else {
                if (window.__music) window.__music.resume();
                setAudioStatus(true);
            }
        });
    })();

    // ── Splash screen ────────────────────────────────────────────────
    var splashEl    = document.getElementById('splash');
    var splashEnter = document.getElementById('splash-enter');
    var splashBack  = document.getElementById('splash-back');

    if (splashEl) {
        scrambleAll(splashEl, 0, { mode: 'seq', minDur: 350, maxDur: 460 });

        function dismissSplash() {
            if (!isMobile && window.__music) {
                window.__music.init();
                audioInitialized = true;
            }
            splashEl.classList.add('splash-out');
            setTimeout(function () { splashEl.style.display = 'none'; }, 540);

            // Resolve the landing statement out of noise as the splash clears,
            // so it arrives the same way the rest of the UI does.
            var mf = document.getElementById('manifesto');
            if (mf) {
                setTimeout(function () {
                    scrambleAll(mf, 0, { mode: 'rand', minDur: 900, maxDur: 1500 });
                }, 300);
            }
        }

        if (splashEnter) splashEnter.addEventListener('click', dismissSplash);
        if (splashBack)  splashBack.addEventListener('click', function () { history.back(); });
    }
})();
