// ── Procedural music engine ────────────────────────────────────────
// Lookahead scheduler, variable time signatures (12/8 · 5/4 · 7/8 · 9/8 ·
// 6/8 · 11/8 · 4/4), extended Holdsworth chord vocab, separate melody layer,
// polyrhythmic drums phase-locked to bar boundaries.
window.__music = (function () {
    'use strict';

    // ── Timing ─────────────────────────────────────────────────────
    var BPM   = 80;
    var STEP  = (60 / BPM) / 2;   // eighth note: 0.375 s
    var DSTEP = STEP / 2;          // 16th note:  0.1875 s  (drum subdivision)
    var AHEAD = 0.15;
    var POLL  = 30;

    // ── Bar templates ───────────────────────────────────────────────
    var TMPLS = [
        // 0: 12/8 compound doom  (4.5 s)
        {n:12,p:[0,3,5,8,10],  b:[0,4,7],    vp:[1.0,.68,.88,.60,.80],vb:[1.0,.80,.70]},
        // 1: 5/4 Brubeck         (3.75 s)
        {n:10,p:[0,3,5,8],     b:[0,4,7],    vp:[1.0,.72,.90,.65],    vb:[1.0,.75,.70]},
        // 2: 7/8 prog/math       (2.625 s)
        {n: 7,p:[0,2,4,6],     b:[0,3,5],    vp:[1.0,.70,.85,.65],    vb:[1.0,.80,.72]},
        // 3: 9/8 Blue Rondo      (3.375 s)
        {n: 9,p:[0,2,4,6,7],   b:[0,3,6],    vp:[1.0,.70,.85,.75,.60],vb:[1.0,.80,.70]},
        // 4: 6/8 ballad          (2.25 s)
        {n: 6,p:[0,3,4],       b:[0,3],      vp:[1.0,.75,.85],        vb:[1.0,.80]},
        // 5: 11/8 Holdsworth     (4.125 s)
        {n:11,p:[0,2,4,7,9],   b:[0,3,7,9],  vp:[1.0,.65,.85,.70,.80],vb:[1.0,.75,.65,.80]},
        // 6: 4/4 reference       (3.0 s)
        {n: 8,p:[0,2,4,6],     b:[0,2,5,6],  vp:[1.0,.70,.90,.70],    vb:[1.0,.75,.80,.65]},
    ];
    var TSEQ  = [0,1,0,3,2,0,4,6,0,5,0,2,3,1];
    var TBARS = [3,2,3,2,3,2,4,2,3,2,3,3,2,2];
    var BWALK = [0,7,10,0,5,12,3,7];

    // ── Scales ─────────────────────────────────────────────────────
    var SCALES = {
        dorian:    [0,2,3,5,7,9,10],
        phrygian:  [0,1,3,5,7,8,10],
        lydian:    [0,2,4,6,7,9,11],
        lyd_aug:   [0,2,4,6,8,9,11],
        locrian:   [0,1,3,5,6,8,10],
        mel_minor: [0,2,3,5,7,9,11],
        altered:   [0,1,3,4,6,8,10],
        suspended: [0,2,5,7,9,10],
    };

    // ── Chord vocabulary ────────────────────────────────────────────
    var CHORDS = [
        {r:38,iv:[0,3,7,10,14,17],sc:'dorian'   },
        {r:43,iv:[0,1,3,7,10],    sc:'phrygian'  },
        {r:36,iv:[0,3,7,11,14],   sc:'mel_minor' },
        {r:39,iv:[0,4,7,11,18],   sc:'lydian'    },
        {r:47,iv:[0,3,6,10],      sc:'locrian'   },
        {r:44,iv:[0,4,8,11],      sc:'lyd_aug'   },
        {r:41,iv:[0,5,7,12],      sc:'suspended' },
        {r:33,iv:[0,3,7,10,14,17],sc:'dorian'   },
        {r:40,iv:[0,4,8,11,14,18],sc:'lyd_aug'  },
        {r:35,iv:[0,4,6,10,13],   sc:'altered'  },
        {r:42,iv:[0,3,7,11,14],   sc:'mel_minor'},
        {r:37,iv:[0,1,5,7,10],    sc:'phrygian' },
        {r:45,iv:[0,3,6,10,14],   sc:'locrian'  },
    ];
    var PROGS = [
        [0,6,2,4],[0,3,2,5],[7,4,0,2],[1,5,3,6],[2,0,5,7],
        [8,10,5,12],[9,0,11,7],[2,8,10,4],
    ];

    // ── Drum grooves — one per TMPLS entry (index must match) ──────
    // Positions are 16th-note offsets from bar start (0 to curTmpl.n*2 - 1).
    // k=kick, s=snare/rim, h=hihat, g=ghost; each: [[pos, vel], ...]
    var DGRV = [
        // 0: 12/8 (24 sixteenths) — dotted-8th hats, doom kick with Tesseract push
        {k:[[0,0.88],[8,0.60],[15,0.72],[20,0.54]],
         s:[[12,0.78]],
         h:[[0,0.50],[3,0.34],[6,0.44],[9,0.34],[12,0.50],[15,0.34],[18,0.44],[21,0.34]],
         g:[[5,0.17],[11,0.17],[17,0.15],[23,0.17]]},

        // 1: 5/4 (20 sixteenths) — 3+2+3+2 kick grouping (Take Five influence)
        {k:[[0,0.88],[7,0.62],[13,0.68]],
         s:[[8,0.78],[18,0.65]],
         h:[[0,0.48],[2,0.34],[4,0.44],[6,0.34],[8,0.48],[10,0.34],[12,0.44],[14,0.34],[16,0.48],[18,0.34]],
         g:[[3,0.17],[11,0.17],[17,0.15]]},

        // 2: 7/8 (14 sixteenths) — 3+2+2 grouping, angular kick
        {k:[[0,0.88],[6,0.65],[10,0.68]],
         s:[[5,0.78]],
         h:[[0,0.48],[2,0.34],[4,0.44],[6,0.34],[8,0.48],[10,0.34],[12,0.44]],
         g:[[1,0.17],[7,0.17],[13,0.15]]},

        // 3: 9/8 (18 sixteenths) — 2+2+2+3 Blue Rondo grouping
        {k:[[0,0.88],[4,0.55],[8,0.62],[13,0.65]],
         s:[[9,0.78]],
         h:[[0,0.48],[2,0.34],[4,0.48],[6,0.34],[8,0.48],[10,0.34],[12,0.44],[14,0.34],[16,0.48]],
         g:[[3,0.17],[7,0.17],[11,0.17],[17,0.15]]},

        // 4: 6/8 (12 sixteenths) — Maiden Voyage sway, kick on 1 and 3+
        {k:[[0,0.88],[7,0.65]],
         s:[[4,0.78]],
         h:[[0,0.50],[2,0.34],[4,0.46],[6,0.34],[8,0.46],[10,0.34]],
         g:[[3,0.17],[9,0.17]]},

        // 5: 11/8 (22 sixteenths) — 3+3+3+2 Holdsworth grouping
        {k:[[0,0.88],[6,0.62],[12,0.68],[18,0.58]],
         s:[[10,0.78],[20,0.65]],
         h:[[0,0.48],[2,0.34],[4,0.44],[6,0.34],[8,0.48],[10,0.34],[12,0.44],[14,0.34],[16,0.48],[18,0.34],[20,0.44]],
         g:[[3,0.17],[9,0.17],[15,0.17],[21,0.15]]},

        // 6: 4/4 (16 sixteenths) — Tesseract 3+3+4+3+3 kick syncopation
        {k:[[0,0.88],[3,0.52],[6,0.68],[10,0.58],[13,0.62]],
         s:[[4,0.80],[12,0.72]],
         h:[[0,0.50],[2,0.36],[4,0.48],[6,0.36],[8,0.50],[10,0.36],[12,0.48],[14,0.36]],
         g:[[1,0.17],[5,0.15],[9,0.17],[13,0.15]]},
    ];

    // ── State ───────────────────────────────────────────────────────
    var ctx = null;
    var master, comp, verbSend, verb, verbRtn;
    var mFilt, mFiltLfo, mFiltLfoG;
    var subOsc, subGain, bassFilter, melFilt, melDry;
    var melDelay, melFbGain, melDelayOut;
    var nSrc, nFilt, nFiltLfo, nFiltLfoG, nGain;
    var running = false;

    var semis    = 0;
    var curProg  = PROGS[0];
    var progPos  = 0;
    var curChord = CHORDS[curProg[0]];
    var curRoot  = curChord.r;
    var padFreqs = [0, 0, 0];

    var stepInBar  = 0;
    var barCount   = 0;
    var tmplPos    = 0;
    var tmplBars   = 0;
    var curTmpl    = TMPLS[TSEQ[0]];
    var barsOnTmpl = TBARS[0];
    var bwalkI     = 0;

    var melNextT = 0;
    var melSeed  = 0x4a7c15;
    var nextStepT = 0;

    var drumBus, drumNoiseBuf;
    var drumActive = false;  // gates drum scheduling until fade-in begins

    function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
    function inArr(a, v) { for (var i=0;i<a.length;i++) if(a[i]===v)return i; return -1; }

    // ── Reverb IR ────────────────────────────────────────────────────
    function makeIR(sec, exp) {
        var n = Math.ceil(ctx.sampleRate * sec);
        var b = ctx.createBuffer(2, n, ctx.sampleRate);
        for (var ch = 0; ch < 2; ch++) {
            var d = b.getChannelData(ch);
            for (var i = 0; i < n; i++)
                d[i] = (Math.random()*2-1) * Math.pow(1-i/n, exp);
        }
        return b;
    }

    // ── Audio graph ───────────────────────────────────────────────────
    function buildGraph() {
        comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -12; comp.ratio.value = 5;
        comp.attack.value = 0.05;   comp.release.value = 0.5;
        master = ctx.createGain(); master.gain.value = 0;
        comp.connect(master); master.connect(ctx.destination);

        verb = ctx.createConvolver(); verb.buffer = makeIR(8.0, 2.5);
        verbRtn = ctx.createGain(); verbRtn.gain.value = 0.55;
        verb.connect(verbRtn); verbRtn.connect(comp);
        verbSend = ctx.createGain(); verbSend.connect(verb);

        mFilt = ctx.createBiquadFilter();
        mFilt.type = 'lowpass'; mFilt.frequency.value = 1800; mFilt.Q.value = 1.1;
        mFilt.connect(comp); mFilt.connect(verbSend);

        mFiltLfo = ctx.createOscillator(); mFiltLfo.frequency.value = 1/27;
        mFiltLfoG = ctx.createGain(); mFiltLfoG.gain.value = 650;
        mFiltLfo.connect(mFiltLfoG); mFiltLfoG.connect(mFilt.frequency); mFiltLfo.start();

        subOsc = ctx.createOscillator(); subOsc.frequency.value = mtof(curRoot-12);
        subGain = ctx.createGain(); subGain.gain.value = 0;
        subOsc.connect(subGain); subGain.connect(comp); subOsc.start();

        bassFilter = ctx.createBiquadFilter();
        bassFilter.type = 'lowpass'; bassFilter.frequency.value = 520; bassFilter.Q.value = 1.6;
        bassFilter.connect(comp); bassFilter.connect(verbSend);

        melFilt = ctx.createBiquadFilter();
        melFilt.type = 'lowpass'; melFilt.frequency.value = 4200;
        melDry = ctx.createGain(); melDry.gain.value = 0.55;
        melFilt.connect(melDry); melDry.connect(comp);
        melFilt.connect(verbSend);

        melDelay    = ctx.createDelay(3.0); melDelay.delayTime.value = 1.125;
        melFbGain   = ctx.createGain();     melFbGain.gain.value    = 0.0;
        melDelayOut = ctx.createGain();     melDelayOut.gain.value  = 0.0;
        melFilt.connect(melDelay);
        melDelay.connect(melFbGain); melFbGain.connect(melDelay);
        melDelay.connect(melDelayOut); melDelayOut.connect(verbSend);

        var nBuf = ctx.createBuffer(1, ctx.sampleRate*3, ctx.sampleRate);
        var nd = nBuf.getChannelData(0);
        for (var i = 0; i < nd.length; i++) nd[i] = Math.random()*2-1;
        nSrc = ctx.createBufferSource(); nSrc.buffer = nBuf; nSrc.loop = true;
        nFilt = ctx.createBiquadFilter();
        nFilt.type = 'bandpass'; nFilt.frequency.value = 600; nFilt.Q.value = 0.8;
        nGain = ctx.createGain(); nGain.gain.value = 0;
        nSrc.connect(nFilt); nFilt.connect(nGain);
        nGain.connect(verbSend); nGain.connect(comp); nSrc.start();
        nFiltLfo = ctx.createOscillator(); nFiltLfo.frequency.value = 1/19;
        nFiltLfoG = ctx.createGain(); nFiltLfoG.gain.value = 320;
        nFiltLfo.connect(nFiltLfoG); nFiltLfoG.connect(nFilt.frequency); nFiltLfo.start();

        // Drum bus — quiet; small reverb send to share the ambient space
        drumBus = ctx.createGain(); drumBus.gain.value = 0;
        drumBus.connect(comp);
        var dRvb = ctx.createGain(); dRvb.gain.value = 0.12;
        drumBus.connect(dRvb); dRvb.connect(verbSend);

        // Shared noise buffer reused by all snare / hat hits
        drumNoiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate), ctx.sampleRate);
        var dnd = drumNoiseBuf.getChannelData(0);
        for (var i = 0; i < dnd.length; i++) dnd[i] = Math.random() * 2 - 1;
    }

    // ── Chord state ──────────────────────────────────────────────────
    function setChordState(def) {
        curChord = def;
        curRoot  = def.r + semis;
        var iv = def.iv;
        for (var i = 0; i < 3; i++) padFreqs[i] = mtof(curRoot + iv[i % iv.length]);
        if (ctx) {
            subOsc.frequency.cancelScheduledValues(ctx.currentTime);
            subOsc.frequency.setTargetAtTime(mtof(curRoot-12), ctx.currentTime, 2.0);
        }
    }

    // ── Pad stab ─────────────────────────────────────────────────────
    var PTYP  = ['sawtooth','sawtooth','triangle'];
    var PDET  = [-7, +7, +2];
    var PBASE = [0.07, 0.07, 0.09];
    function triggerPad(when, vel) {
        for (var pi = 0; pi < 3; pi++) {
            (function (i) {
                var osc = ctx.createOscillator();
                osc.type = PTYP[i]; osc.detune.value = PDET[i];
                osc.frequency.value = padFreqs[i];
                var g = ctx.createGain();
                g.gain.setValueAtTime(0.001, when);
                g.gain.linearRampToValueAtTime(PBASE[i]*vel, when+0.016);
                g.gain.setTargetAtTime(0.001, when+0.016, 1.5);
                osc.connect(g); g.connect(mFilt);
                osc.start(when); osc.stop(when+7.0);
                osc.onended = function(){try{g.disconnect();osc.disconnect();}catch(e){}};
            })(pi);
        }
    }

    // ── Bass note ────────────────────────────────────────────────────
    function triggerBass(when) {
        var ivl = BWALK[bwalkI % BWALK.length]; bwalkI++;
        var osc = ctx.createOscillator(); osc.type = 'sawtooth';
        osc.frequency.value = mtof(curRoot + ivl);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.001, when);
        g.gain.linearRampToValueAtTime(0.18, when+0.007);
        g.gain.setTargetAtTime(0.001, when+0.007, 0.20);
        osc.connect(g); g.connect(bassFilter);
        osc.start(when); osc.stop(when+1.2);
        osc.onended = function(){try{g.disconnect();osc.disconnect();}catch(e){}};
    }

    // ── Drum voices ───────────────────────────────────────────────────
    function triggerKick(when, vel) {
        var osc = ctx.createOscillator(); osc.type = 'sine';
        osc.frequency.setValueAtTime(72, when);
        osc.frequency.exponentialRampToValueAtTime(28, when + 0.10);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.001, when);
        g.gain.linearRampToValueAtTime(0.35 * vel, when + 0.003);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.28);
        osc.connect(g); g.connect(drumBus);
        osc.start(when); osc.stop(when + 0.32);
        osc.onended = function(){try{g.disconnect();osc.disconnect();}catch(e){}};
    }

    function triggerSnare(when, vel) {
        var off = Math.random() * 0.6;
        var src = ctx.createBufferSource(); src.buffer = drumNoiseBuf;
        var nf  = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 2600; nf.Q.value = 0.9;
        var ng  = ctx.createGain();
        ng.gain.setValueAtTime(0.001, when);
        ng.gain.linearRampToValueAtTime(0.22 * vel, when + 0.002);
        ng.gain.exponentialRampToValueAtTime(0.001, when + 0.10);
        src.connect(nf); nf.connect(ng); ng.connect(drumBus);
        src.start(when, off, 0.12);
        var tosc = ctx.createOscillator(); tosc.type = 'sine'; tosc.frequency.value = 195;
        var tg = ctx.createGain();
        tg.gain.setValueAtTime(0.001, when);
        tg.gain.linearRampToValueAtTime(0.10 * vel, when + 0.002);
        tg.gain.exponentialRampToValueAtTime(0.001, when + 0.042);
        tosc.connect(tg); tg.connect(drumBus);
        tosc.start(when); tosc.stop(when + 0.06);
        src.onended  = function(){try{ng.disconnect();nf.disconnect();src.disconnect();}catch(e){}};
        tosc.onended = function(){try{tg.disconnect();tosc.disconnect();}catch(e){}};
    }

    function triggerHat(when, vel) {
        var src = ctx.createBufferSource(); src.buffer = drumNoiseBuf;
        var hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 8500;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.001, when);
        g.gain.linearRampToValueAtTime(0.14 * vel, when + 0.001);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.042);
        src.connect(hpf); hpf.connect(g); g.connect(drumBus);
        src.start(when, Math.random() * 0.7, 0.055);
        src.onended = function(){try{g.disconnect();hpf.disconnect();src.disconnect();}catch(e){}};
    }

    function triggerGhost(when, vel) {
        var src = ctx.createBufferSource(); src.buffer = drumNoiseBuf;
        var nf  = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 2400; nf.Q.value = 1.0;
        var g   = ctx.createGain();
        g.gain.setValueAtTime(0.001, when);
        g.gain.linearRampToValueAtTime(0.07 * vel, when + 0.002);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.065);
        src.connect(nf); nf.connect(g); g.connect(drumBus);
        src.start(when, Math.random() * 0.7, 0.08);
        src.onended = function(){try{g.disconnect();nf.disconnect();src.disconnect();}catch(e){}};
    }

    // Schedule all drum hits for one bar, anchored to barT.
    // Uses the groove matching the CURRENT template so drums always align
    // with the bar grid and respond to time-signature changes.
    function schedDrumBar(barT) {
        var grv = DGRV[TSEQ[tmplPos]];
        var i;
        for (i = 0; i < grv.k.length; i++) triggerKick(barT  + grv.k[i][0]*DSTEP, grv.k[i][1]);
        for (i = 0; i < grv.s.length; i++) triggerSnare(barT + grv.s[i][0]*DSTEP, grv.s[i][1]);
        for (i = 0; i < grv.h.length; i++) triggerHat(barT   + grv.h[i][0]*DSTEP, grv.h[i][1]);
        for (i = 0; i < grv.g.length; i++) triggerGhost(barT + grv.g[i][0]*DSTEP, grv.g[i][1]);
    }

    // ── Melody ────────────────────────────────────────────────────────
    function playMelNote(when, freq, dur) {
        var osc = ctx.createOscillator(); osc.type = 'triangle';
        osc.frequency.value = freq;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.001, when);
        g.gain.linearRampToValueAtTime(0.14, when+0.06);
        g.gain.setTargetAtTime(0.001, when+dur*0.82, 0.50);
        osc.connect(g); g.connect(melFilt);
        osc.start(when); osc.stop(when+dur+2.8);
        osc.onended = function(){try{g.disconnect();osc.disconnect();}catch(e){}};
    }

    function makeMelPhrase(scaleName, root, seed) {
        var r = seed >>> 0;
        function rn() { r=(r*1664525+1013904223)>>>0; return r/4294967296; }
        var sc = SCALES[scaleName] || SCALES.dorian;

        var styleR = rn();
        var style = styleR < 0.20 ? 'slow' :
                    styleR < 0.50 ? 'fast' :
                    styleR < 0.75 ? 'med'  : 'mixed';

        var num = style==='slow'  ? 2 + Math.floor(rn()*2) :
                  style==='fast'  ? 5 + Math.floor(rn()*4) :
                  style==='med'   ? 3 + Math.floor(rn()*3) :
                                    4 + Math.floor(rn()*3);

        var slowPool = [4,6,6,8,8,12];
        var medPool  = [2,3,3,4,4,6];
        var fastPool = [1,1,1,2,2,3];

        var oct = rn()<0.5 ? 12 : 24;
        var deg = Math.floor(rn()*sc.length);
        var dirs = ['up','down','arch','free'];
        var dir  = dirs[Math.floor(rn()*dirs.length)];
        var notes = [], t = 0;

        for (var i = 0; i < num; i++) {
            var step = dir==='up'   ?  1+Math.floor(rn()*2) :
                       dir==='down' ? -(1+Math.floor(rn()*2)) :
                       dir==='arch' ? (i<num/2?1:-1) :
                                       Math.floor(rn()*5)-2;
            deg = Math.max(0, Math.min(sc.length-1, deg+step));
            var eoct = oct;
            if (rn() < (style==='fast' ? 0.15 : 0.12)) eoct = oct + 12;
            var pool = style==='slow'  ? slowPool :
                       style==='fast'  ? fastPool :
                       style==='med'   ? medPool  :
                       (i < num/2      ? fastPool : slowPool);
            var dSteps = pool[Math.floor(rn()*pool.length)];
            notes.push({t:t*STEP, dur:dSteps*STEP, freq:mtof(root+sc[deg]+eoct)});
            t += dSteps;
            var gapC = style==='fast' ? 0.10 : (style==='slow' ? 0.50 : 0.28);
            if (rn() < gapC) t += style==='fast' ? 1 : Math.floor(rn()*3)+1;
        }
        return {notes:notes, style:style};
    }

    function schedMelPhrase(barStartT) {
        melSeed = (melSeed ^ (barCount*2654435761)) >>> 0;
        var result = makeMelPhrase(curChord.sc, curRoot, melSeed);
        var phrase = result.notes, style = result.style;
        phrase.forEach(function(n){ playMelNote(barStartT+n.t, n.freq, n.dur); });
        var tail = phrase.length ? phrase[phrase.length-1].t+phrase[phrase.length-1].dur : 1.5;
        var restBars = style==='slow' ? 2 + ((melSeed>>>4)&1) :
                       style==='fast' ?      ((melSeed>>>4)&1) :
                                       1 + ((melSeed>>>4)&1);
        melNextT = barStartT + tail + restBars * curTmpl.n * STEP;
        if (ctx && ((melSeed >>> 6) & 7) < 3) {
            var now = ctx.currentTime;
            var dts = [0.375, 0.563, 0.750, 1.125];
            var dt  = dts[(melSeed >>> 10) & 3];
            melDelay.delayTime.setValueAtTime(dt, now);
            melFbGain.gain.setTargetAtTime(0.38, now, 0.15);
            melDelayOut.gain.setTargetAtTime(0.70, now, 0.15);
            var offT = barStartT + tail + dt * 7;
            melFbGain.gain.setTargetAtTime(0.0, offT, 0.6);
            melDelayOut.gain.setTargetAtTime(0.0, offT, 0.6);
        }
    }

    // ── Lookahead scheduler ───────────────────────────────────────────
    function tick() {
        while (nextStepT < ctx.currentTime + AHEAD) {
            // Bar start: schedule drums and optionally a melody phrase
            if (stepInBar === 0) {
                if (drumActive) schedDrumBar(nextStepT);
                if (nextStepT >= melNextT) schedMelPhrase(nextStepT);
            }

            var pi = inArr(curTmpl.p, stepInBar);
            var bi = inArr(curTmpl.b, stepInBar);
            if (pi !== -1) triggerPad(nextStepT, curTmpl.vp[pi]);
            if (bi !== -1) triggerBass(nextStepT);

            nextStepT += STEP;
            stepInBar++;

            if (stepInBar >= curTmpl.n) {
                stepInBar = 0;
                barCount++;
                tmplBars++;

                if (barCount % 2 === 0) {
                    progPos = (progPos+1) % curProg.length;
                    setChordState(CHORDS[curProg[progPos]]);
                }

                if (tmplBars >= barsOnTmpl) {
                    tmplBars = 0;
                    tmplPos  = (tmplPos+1) % TSEQ.length;
                    curTmpl  = TMPLS[TSEQ[tmplPos]];
                    barsOnTmpl = TBARS[tmplPos];
                }
            }
        }
        setTimeout(tick, POLL);
    }

    function djb2(s) {
        var h=5381;
        for(var i=0;i<s.length;i++) h=(((h<<5)+h)^s.charCodeAt(i))>>>0;
        return h;
    }

    // ── Public API ─────────────────────────────────────────────────────
    function init() {
        if (running) return; running = true;
        ctx = new (window.AudioContext||window.webkitAudioContext)({latencyHint:'playback'});
        buildGraph();
        var now = ctx.currentTime;
        master.gain.setTargetAtTime(0.68, now,      2.0);
        subGain.gain.setTargetAtTime(0.22, now+1.5, 3.5);
        nGain.gain.setTargetAtTime(0.028, now+4.0,  2.5);
        setChordState(CHORDS[curProg[0]]);
        nextStepT = now + 0.6;
        // Drums fade in after pads establish, then gate open so scheduling begins
        drumBus.gain.setTargetAtTime(1, now + 2.5, 3.5);
        setTimeout(function() { drumActive = true; }, 2500);
        tick();
    }

    function setSector(idx) {
        if (!ctx) return;
        var semisMap = [0,-2,3,-5];
        var progMap  = [0,2,5,7];
        semis   = semisMap[idx % 4];
        curProg = PROGS[progMap[idx % 4]];
        progPos = 0;
        var fqs = [1800,1400,2500,1100];
        mFilt.frequency.setTargetAtTime(fqs[idx%4], ctx.currentTime, 5.0);
        setChordState(CHORDS[curProg[0]]);
    }

    function setTextSeed(text) {
        if (!ctx) return;
        var h = djb2(text);
        curProg = PROGS[h % PROGS.length];
        semis   = ((h>>8) & 3) - 1;
        progPos = 0;
        setChordState(CHORDS[curProg[0]]);
    }

    function onGlitch() {
        if (!ctx) return;
        var now = ctx.currentTime;
        mFilt.Q.setTargetAtTime(9.0, now, 0.008);
        mFilt.Q.setTargetAtTime(1.1, now+0.18, 0.25);
        nGain.gain.setTargetAtTime(0.15,  now, 0.008);
        nGain.gain.setTargetAtTime(0.028, now+0.45, 0.20);
    }

    function onIdleFlash() {
        if (!ctx) return;
        var now = ctx.currentTime;
        nGain.gain.setTargetAtTime(0.060, now, 0.018);
        nGain.gain.setTargetAtTime(0.028, now+0.30, 0.14);
    }

    function pause() {
        if (ctx && ctx.state === 'running') ctx.suspend();
    }

    function resume() {
        if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    return {init:init, pause:pause, resume:resume,
            setSector:setSector, setTextSeed:setTextSeed,
            onGlitch:onGlitch, onIdleFlash:onIdleFlash};
})();
