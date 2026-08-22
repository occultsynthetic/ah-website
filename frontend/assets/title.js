(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────────────
    var name   = 'MEGASTRUCTURE.SYS';
    var pos    = name.length;
    var active = false;
    var currentBodyEgg = null;

    // ── Helpers ──────────────────────────────────────────────────────

    function triggerGlitch() {
        if (window.__music) window.__music.onGlitch();
    }

    function setBodyEgg(cls) {
        if (currentBodyEgg) document.body.classList.remove(currentBodyEgg);
        currentBodyEgg = cls;
        if (cls) document.body.classList.add(cls);
    }

    function flashTitle() {
        ['sys-title-splash', 'sys-title-nav'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.classList.add('sys-flash');
            setTimeout(function () { el.classList.remove('sys-flash'); }, 750);
        });
    }

    function showMsg(msg) {
        var el = document.getElementById('sys-egg-msg');
        if (!el) return;
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(el._t);
        el._t = setTimeout(function () { el.style.opacity = '0'; }, 4500);
    }

    // ── Easter eggs ──────────────────────────────────────────────────
    // Add more keys here to create new eggs. Key = uppercase name, value = function.
    var EGGS = {
        'VOID': function () {
            triggerGlitch();
            flashTitle();
            setBodyEgg('egg-void');
            showMsg('// ENTERING VOID SECTOR');
        },
        'NEXUS': function () {
            triggerGlitch();
            flashTitle();
            setBodyEgg('egg-nexus');
            showMsg('// NEXUS LINK ESTABLISHED');
        },
        'GENESIS': function () {
            triggerGlitch();
            flashTitle();
            setBodyEgg('egg-genesis');
            showMsg('// GENESIS PROTOCOL INITIATED');
        },
        'ORACLE': function () {
            flashTitle();
            showMsg('// ALL PATHS CONVERGE HERE — YOU WERE EXPECTED');
        },
        'CIPHER': function () {
            triggerGlitch();
            flashTitle();
            showMsg('// DECRYPTION IN PROGRESS...');
            if (window.__scramble) {
                var menuEl = document.getElementById('menu');
                if (menuEl) window.__scramble.all(menuEl, 0);
                for (var i = 0; i < 3; i++) {
                    var p = document.getElementById('panel-' + i);
                    if (p && !p.classList.contains('panel-hidden')) {
                        window.__scramble.all(p, 0);
                    }
                }
            }
        },
        'MEGASTRUCTURE': function () {
            if (!currentBodyEgg) return;
            triggerGlitch();
            flashTitle();
            setBodyEgg(null);
            showMsg('// MEGASTRUCTURE.SYS RESTORED');
        },
    };

    function checkEgg() {
        var upper = name.toUpperCase();
        var key   = upper.endsWith('.SYS') ? upper.slice(0, -4) : upper;
        var fn = EGGS[key];
        if (fn) fn();
    }

    // ── Render ───────────────────────────────────────────────────────

    function render() {
        var before = name.slice(0, pos);
        var after  = name.slice(pos);
        upd('sys-splash-before', before);
        upd('sys-splash-after',  after);
        upd('sys-nav-before',    before);
        upd('sys-nav-after',     after);
    }

    function upd(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    // ── Text entry ───────────────────────────────────────────────────
    // A real, standard <input> drives editing instead of a hand-rolled
    // document-level keydown listener. That gets native caret/selection,
    // physical AND mobile virtual keyboards, IME, and paste for free —
    // the previous approach only worked with a physical keyboard, since
    // mobile browsers only surface a virtual keyboard for a genuinely
    // focused, editable element. The input is visually invisible; the
    // existing before/cursor/after spans still do the on-page rendering.
    var shadowInput = document.createElement('input');
    shadowInput.type = 'text';
    shadowInput.autocomplete = 'off';
    shadowInput.autocapitalize = 'characters';
    shadowInput.spellcheck = false;
    shadowInput.setAttribute('aria-hidden', 'true');
    shadowInput.tabIndex = -1;
    // Off-screen + near-zero opacity (not exactly 0) + real dimensions,
    // rather than 1x1px/opacity:0 — some iOS Safari versions treat a
    // focused opacity:0/1px element as non-interactive and refuse to
    // raise the keyboard for it.
    shadowInput.style.cssText =
        'position:fixed;top:0;left:-9999px;width:200px;height:2em;opacity:0.01;' +
        'border:none;padding:0;margin:0;outline:none;background:transparent;' +
        'color:transparent;caret-color:transparent;font-size:16px;pointer-events:none;';
    document.body.appendChild(shadowInput);

    function sanitize(v) {
        return v.toUpperCase().replace(/[^A-Z0-9_\-]/g, '');
    }

    shadowInput.addEventListener('input', function () {
        var raw = shadowInput.value;
        var clean = sanitize(raw);
        if (clean !== raw) {
            var cleanUpToSel = sanitize(raw.slice(0, shadowInput.selectionStart)).length;
            shadowInput.value = clean;
            shadowInput.setSelectionRange(cleanUpToSel, cleanUpToSel);
        }
        name = shadowInput.value;
        pos  = shadowInput.selectionStart;
        checkEgg();
        render();
    });

    // Arrow/Home/End move the caret without firing 'input' — resync after.
    shadowInput.addEventListener('keyup', function () {
        pos = shadowInput.selectionStart;
        render();
    });

    shadowInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            var eUp  = name.toUpperCase();
            var eKey = eUp.endsWith('.SYS') ? eUp.slice(0, -4) : eUp;
            if (eKey === 'AUDIO' && window.__audioSys) {
                window.__audioSys.show();
            }
        } else if (e.key === 'Escape') {
            deactivate();
        }
    });

    shadowInput.addEventListener('blur', deactivate);

    // ── Activation ───────────────────────────────────────────────────

    function activate() {
        if (active) { shadowInput.focus(); return; }
        active = true;
        shadowInput.value = name;
        shadowInput.focus();
        shadowInput.setSelectionRange(pos, pos);
        ['sys-title-splash', 'sys-title-nav'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.add('sys-focused');
        });
    }

    function deactivate() {
        if (!active) return;
        active = false;
        shadowInput.blur();
        ['sys-title-splash', 'sys-title-nav'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.remove('sys-focused');
        });
    }

    ['sys-title-splash', 'sys-title-nav'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', function (e) {
            e.stopPropagation();
            activate();
        });
    });

    render();
})();
