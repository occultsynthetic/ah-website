(function () {
    'use strict';

    var el    = document.getElementById('audio-sys');
    var outEl = document.getElementById('audio-sys-out');
    var cmdEl = document.getElementById('audio-sys-cmd');
    var visible = false;

    var BOOT = [
        '// AUDIO.SYS — SUBSYSTEM INTERFACE',
        '// VERSION 0.1.0',
        '//',
        '// TYPE HELP FOR AVAILABLE COMMANDS',
        '//',
    ];

    var HELP = [
        '//',
        '//  AVAILABLE COMMANDS:',
        '//',
        '//  HELP    — display this list',
        '//  ASCII   — toggle audio-reactive ASCII visualiser',
        '//  SYNTH   — open the synthesiser control panel',
        '//  RESET   — restore all synth settings to defaults',
        '//  EXIT    — return to MEGASTRUCTURE.SYS',
        '//',
    ];

    function appendLines(lines) {
        lines.forEach(function (text) {
            var div = document.createElement('div');
            div.className = 'asys-line';
            div.textContent = text;
            outEl.appendChild(div);
        });
        outEl.scrollTop = outEl.scrollHeight;
    }

    var COMMANDS = {
        help: function () { appendLines(HELP); },
        ascii: function () {
            var vis = window.__asciiVis;
            if (!vis) { appendLines(['// VISUALISER NOT AVAILABLE']); return; }
            if (vis.isRunning()) {
                vis.stop();
                appendLines(['// ASCII VISUALISER — OFF']);
            } else {
                vis.start();
                appendLines(['// ASCII VISUALISER — ON', '// PRESS ESC OR TYPE ASCII + ENTER TO STOP']);
            }
            cmdEl.focus();
        },
        synth: function () {
            var ui = window.__synthUI;
            if (!ui) { appendLines(['// SYNTH PANEL NOT AVAILABLE']); return; }
            if (ui.isOpen()) {
                ui.hide();
                appendLines(['// SYNTH PANEL — CLOSED']);
            } else if (ui.show()) {
                appendLines(['// SYNTH PANEL — OPEN',
                             '// DRAG A BAR TO ADJUST · TYPE SYNTH OR ESC TO CLOSE']);
            } else {
                appendLines(['// SYNTH PANEL UNAVAILABLE — AUDIO ENGINE NOT LOADED']);
            }
            cmdEl.focus();
        },
        reset: function () {
            if (!window.__music || !window.__music.resetParams) {
                appendLines(['// NOTHING TO RESET']);
                return;
            }
            window.__music.resetParams();
            if (window.__synthUI && window.__synthUI.isOpen()) window.__synthUI.refresh();
            appendLines(['// SYNTH PARAMETERS RESTORED TO DEFAULTS']);
        },
        exit: function () { hide(); },
    };

    function runCmd(raw) {
        var trimmed = raw.trim();
        if (!trimmed) return;
        appendLines(['> ' + trimmed.toUpperCase()]);
        var fn = COMMANDS[trimmed.toLowerCase()];
        if (fn) {
            fn();
        } else {
            appendLines([
                '// UNKNOWN COMMAND: ' + trimmed.toUpperCase(),
                '// TYPE HELP FOR AVAILABLE COMMANDS',
            ]);
        }
    }

    function show() {
        if (visible) return;
        visible = true;

        document.body.click();
        document.body.classList.add('into-audio-sys');

        setTimeout(function () {
            document.body.classList.remove('into-audio-sys');
            document.body.classList.add('audio-sys-active');

            // Clearing outEl would orphan the synth panel's DOM while leaving
            // the pane's pinned height behind — close it properly first.
            if (window.__synthUI && window.__synthUI.isOpen()) window.__synthUI.hide();
            outEl.innerHTML = '';
            appendLines(BOOT);

            el.style.display = 'flex';
            requestAnimationFrame(function () {
                el.classList.add('asys-in');
            });

            setTimeout(function () { cmdEl.focus(); }, 80);
        }, 450);
    }

    function hide() {
        if (!visible) return;
        visible = false;

        el.classList.remove('asys-in');
        el.classList.add('asys-out');

        setTimeout(function () {
            el.style.display = 'none';
            el.classList.remove('asys-out');
            document.body.classList.remove('audio-sys-active');
            document.body.classList.add('from-audio-sys');
            setTimeout(function () {
                document.body.classList.remove('from-audio-sys');
            }, 500);
        }, 380);
    }

    cmdEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            var val = cmdEl.value;
            cmdEl.value = '';
            runCmd(val);
        } else if (e.key === 'Escape') {
            // Escape peels back one layer at a time: visualiser, then the
            // synth panel, then the terminal itself.
            if (window.__asciiVis && window.__asciiVis.isRunning()) {
                window.__asciiVis.stop();
                appendLines(['// ASCII VISUALISER — OFF']);
            } else if (window.__synthUI && window.__synthUI.isOpen()) {
                window.__synthUI.hide();
                appendLines(['// SYNTH PANEL — CLOSED']);
            } else {
                hide();
            }
        }
    });

    window.__audioSys = { show: show, hide: hide };
})();
