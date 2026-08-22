(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────────────
    var name   = 'MEGASTRUCTURE';
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
        var fn = EGGS[name.toUpperCase()];
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

    // ── Keyboard ─────────────────────────────────────────────────────

    document.addEventListener('keydown', function (e) {
        if (!active) return;

        var consumed = true;
        switch (e.key) {
            case 'ArrowLeft':
                pos = Math.max(0, pos - 1);
                break;
            case 'ArrowRight':
                pos = Math.min(name.length, pos + 1);
                break;
            case 'Home':
                pos = 0;
                break;
            case 'End':
                pos = name.length;
                break;
            case 'Backspace':
                if (pos > 0) {
                    name = name.slice(0, pos - 1) + name.slice(pos);
                    pos--;
                }
                break;
            case 'Delete':
                if (pos < name.length) {
                    name = name.slice(0, pos) + name.slice(pos + 1);
                }
                break;
            case 'Escape':
                deactivate();
                consumed = false;
                break;
            default:
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    var ch = e.key.toUpperCase();
                    if (/[A-Z0-9_\-]/.test(ch)) {
                        name = name.slice(0, pos) + ch + name.slice(pos);
                        pos++;
                        checkEgg();
                    }
                } else {
                    consumed = false;
                }
        }
        if (consumed) e.preventDefault();
        render();
    });

    // ── Activation ───────────────────────────────────────────────────

    function activate() {
        active = true;
        ['sys-title-splash', 'sys-title-nav'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.add('sys-focused');
        });
    }

    function deactivate() {
        active = false;
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

    document.addEventListener('click', function (e) {
        var inside = e.target.closest && e.target.closest('#sys-title-splash, #sys-title-nav');
        if (!inside) deactivate();
    });

    render();
})();
