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
    var BWALK = [0,7,10,0,5,12,3,7];

    // ── Song form ───────────────────────────────────────────────────
    // 16-bar sections rather than a 2–4 bar template shuffle: the old
    // rotation changed time signature every couple of bars, which read as
    // restlessness instead of structure. One template per section means a
    // groove gets long enough to settle before it turns over.
    //
    // drums: 0 none · 1 sparse (kick + skeleton hats) · 2 full · 3 busy
    // gains multiply the SYNTH panel values rather than replacing them,
    // so user settings survive the arrangement.
    var SECTION_BARS = 16;
    var SECTIONS = [
        // name      tmpl drums drumG tone  sub  noise pad  bass mel   swarm  stab
        {n:'INTRO',  t:4, d:0, dg:0.00, to:0.60, sb:1.00, nz:1.45, pd:0.72, bs:0.45, ml:false, sw:true,  st:'sparse'},
        {n:'RISE',   t:0, d:1, dg:0.55, to:0.80, sb:1.00, nz:1.15, pd:0.90, bs:0.85, ml:true,  sw:false, st:'alt'   },
        {n:'MAIN',   t:0, d:2, dg:1.00, to:1.00, sb:1.00, nz:0.90, pd:1.00, bs:1.00, ml:true,  sw:true,  st:'full'  },
        {n:'LIFT',   t:6, d:3, dg:1.15, to:1.25, sb:1.10, nz:1.00, pd:1.10, bs:1.10, ml:true,  sw:false, st:'dense' },
        // The drop: drums fall away right after the biggest build
        {n:'VOID',   t:5, d:0, dg:0.00, to:0.55, sb:1.20, nz:1.60, pd:0.70, bs:0.40, ml:false, sw:true,  st:'sparse'},
        {n:'RETURN', t:2, d:2, dg:1.00, to:1.05, sb:1.00, nz:0.85, pd:1.00, bs:1.00, ml:true,  sw:true,  st:'push'  },
        {n:'PEAK',   t:6, d:3, dg:1.25, to:1.35, sb:1.15, nz:1.10, pd:1.15, bs:1.15, ml:true,  sw:true,  st:'dense' },
        {n:'FADE',   t:3, d:1, dg:0.45, to:0.70, sb:0.90, nz:1.30, pd:0.80, bs:0.60, ml:false, sw:true,  st:'tail'  },
    ];

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
    var bwalkI     = 0;

    // Song-form state
    var secIdx     = 0;
    var secBar     = 0;
    var curSec     = SECTIONS[0];
    var curTmplIdx = SECTIONS[0].t;
    var curTmpl    = TMPLS[curTmplIdx];

    // Deterministic per-bar RNG — rhythms vary bar to bar but a given bar
    // always resolves the same way, so pads and drums agree on the pattern.
    function barRng(seed) {
        var r = (seed * 2654435761) >>> 0;
        return function () {
            r = (r * 1664525 + 1013904223) >>> 0;
            return r / 4294967296;
        };
    }

    var melNextT = 0;
    var melSeed  = 0x4a7c15;
    var nextStepT = 0;

    var drumBus, drumNoiseBuf;
    var drumActive = false;  // gates drum scheduling until fade-in begins
    var snareDelay, snareDelayFB, snareDelayOut;
    var swarmFilt, swarmDelay, swarmDelayFB, swarmDelayOut, swarmVerbSend;
    var swarmOscs = [];
    var distCurve;
    var swarmCountdown = 2;
    var analyser = null;

    // ── User-tunable parameters (drives the SYNTH panel in AUDIO.SYS) ──
    // PARAM_DEFS is the single source of truth: it seeds both the live
    // values (P) and the reset targets (DEFAULTS), and describes each
    // control to the UI. fmt: 'n' = number, 'hz' = frequency, 'i' = integer.
    var PARAM_DEFS = [
        {g:'MASTER', id:'masterVol',   label:'VOLUME', min:0,   max:1.0,   dflt:0.68,  fmt:'n',
         hint:'overall output level'},
        {g:'MASTER', id:'masterTone',  label:'TONE',   min:200, max:6000,  dflt:1800,  fmt:'hz',
         hint:'pad lowpass cutoff'},
        {g:'MASTER', id:'masterReso',  label:'RESO',   min:0.1, max:12,    dflt:1.1,   fmt:'n',
         hint:'pad filter resonance'},
        {g:'MASTER', id:'reverb',      label:'REVERB', min:0,   max:1.5,   dflt:0.55,  fmt:'n',
         hint:'reverb return level'},

        {g:'SWARMATRON', id:'swarmLevel',  label:'LEVEL',  min:0,   max:0.30, dflt:0.110, fmt:'n',
         hint:'swarm peak loudness'},
        {g:'SWARMATRON', id:'swarmTone',   label:'TONE',   min:200, max:5000, dflt:1400,  fmt:'hz',
         hint:'swarm lowpass cutoff'},
        {g:'SWARMATRON', id:'swarmReso',   label:'RESO',   min:0.1, max:8,    dflt:0.65,  fmt:'n',
         hint:'swarm filter resonance'},
        {g:'SWARMATRON', id:'swarmEcho',   label:'ECHO',   min:0,   max:0.85, dflt:0.42,  fmt:'n',
         hint:'swarm delay feedback'},
        {g:'SWARMATRON', id:'swarmSpread', label:'SPREAD', min:0,   max:4,    dflt:1.0,   fmt:'n',
         hint:'voice detune spread'},
        {g:'SWARMATRON', id:'swarmRate',   label:'EVERY',  min:1,   max:12,   dflt:2,     fmt:'i',
         hint:'bars between swarms'},

        {g:'PAD',    id:'padLevel',   label:'LEVEL',  min:0,   max:2.0,  dflt:1.0,   fmt:'n',
         hint:'chord stab level'},
        {g:'PAD',    id:'padDetune',  label:'DETUNE', min:0,   max:4.0,  dflt:1.0,   fmt:'n',
         hint:'chord stab detune'},

        {g:'BASS',   id:'bassLevel',  label:'LEVEL',  min:0,   max:2.5,  dflt:1.0,   fmt:'n',
         hint:'bass note level'},
        {g:'BASS',   id:'bassTone',   label:'TONE',   min:80,  max:2000, dflt:520,   fmt:'hz',
         hint:'bass lowpass cutoff'},
        {g:'BASS',   id:'subLevel',   label:'SUB',    min:0,   max:0.6,  dflt:0.22,  fmt:'n',
         hint:'sub oscillator drone'},

        {g:'MELODY', id:'melLevel',   label:'LEVEL',  min:0,   max:2.5,  dflt:1.0,   fmt:'n',
         hint:'lead melody level'},
        {g:'MELODY', id:'melTone',    label:'TONE',   min:500, max:9000, dflt:4200,  fmt:'hz',
         hint:'melody lowpass cutoff'},
        {g:'MELODY', id:'melEcho',    label:'ECHO',   min:0,   max:2.0,  dflt:1.0,   fmt:'n',
         hint:'melody delay amount'},

        {g:'DRUMS',  id:'drumLevel',  label:'LEVEL',  min:0,   max:2.0,  dflt:1.0,   fmt:'n',
         hint:'drum bus level'},
        {g:'DRUMS',  id:'snareEcho',  label:'ECHO',   min:0,   max:0.8,  dflt:0.32,  fmt:'n',
         hint:'snare delay feedback'},

        {g:'NOISE',  id:'noiseLevel', label:'LEVEL',  min:0,   max:0.15, dflt:0.028, fmt:'n',
         hint:'ambient noise bed'},
    ];

    var P = {}, DEFAULTS = {};
    for (var _i = 0; _i < PARAM_DEFS.length; _i++) {
        P[PARAM_DEFS[_i].id]        = PARAM_DEFS[_i].dflt;
        DEFAULTS[PARAM_DEFS[_i].id] = PARAM_DEFS[_i].dflt;
    }

    // Push one param onto its live AudioNode. Trigger-time params (levels
    // read when a note is scheduled) have no node to update and fall through.
    // Section-scaled params fold in the current section's multiplier so a
    // slider move doesn't undo the arrangement until the next boundary.
    function applyParam(id) {
        if (!ctx) return;
        var now = ctx.currentTime, v = P[id], T = 0.05;
        switch (id) {
            case 'masterVol':  master.gain.setTargetAtTime(v, now, T); break;
            case 'masterTone': mFilt.frequency.setTargetAtTime(v * curSec.to, now, T); break;
            case 'masterReso': mFilt.Q.setTargetAtTime(v, now, T); break;
            case 'reverb':     verbRtn.gain.setTargetAtTime(v, now, T); break;
            case 'swarmTone':  swarmFilt.frequency.setTargetAtTime(v, now, T); break;
            case 'swarmReso':  swarmFilt.Q.setTargetAtTime(v, now, T); break;
            case 'swarmEcho':  swarmDelayFB.gain.setTargetAtTime(v, now, T); break;
            case 'bassTone':   bassFilter.frequency.setTargetAtTime(v, now, T); break;
            case 'subLevel':   subGain.gain.setTargetAtTime(v * curSec.sb, now, T); break;
            case 'melTone':    melFilt.frequency.setTargetAtTime(v, now, T); break;
            case 'drumLevel':  drumBus.gain.setTargetAtTime(v * curSec.dg, now, T); break;
            case 'snareEcho':  snareDelayFB.gain.setTargetAtTime(v, now, T); break;
            case 'noiseLevel': nGain.gain.setTargetAtTime(v * curSec.nz, now, T); break;
        }
    }

    // Applied once the graph exists. Excludes params whose initial value is
    // owned by init()'s slow fade-in ramps (master/sub/noise/drum levels) —
    // those read from P directly there, so re-applying would snap the fade.
    var INIT_APPLY = ['masterTone','masterReso','reverb','swarmTone','swarmReso',
                      'swarmEcho','bassTone','melTone','snareEcho'];
    function applyInitParams() {
        for (var i = 0; i < INIT_APPLY.length; i++) applyParam(INIT_APPLY[i]);
    }

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
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.82;
        master.connect(analyser);

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

        // Snare delay bus — Massive Attack dotted-8th echo trail
        snareDelay    = ctx.createDelay(2.0); snareDelay.delayTime.value = STEP * 1.5;
        snareDelayFB  = ctx.createGain();     snareDelayFB.gain.value    = 0.32;
        snareDelayOut = ctx.createGain();     snareDelayOut.gain.value   = 0.68;
        snareDelay.connect(snareDelayFB); snareDelayFB.connect(snareDelay);
        snareDelay.connect(snareDelayOut); snareDelayOut.connect(drumBus);

        // Swarmatron bus — filter → dry + reverb send + dedicated feedback delay
        swarmFilt = ctx.createBiquadFilter();
        swarmFilt.type = 'lowpass'; swarmFilt.frequency.value = 1400; swarmFilt.Q.value = 0.65;
        var swarmDry = ctx.createGain(); swarmDry.gain.value = 0.14;
        swarmFilt.connect(swarmDry); swarmDry.connect(comp);
        swarmVerbSend = ctx.createGain(); swarmVerbSend.gain.value = 1.0;
        swarmFilt.connect(swarmVerbSend); swarmVerbSend.connect(verbSend);
        swarmDelay    = ctx.createDelay(4.0); swarmDelay.delayTime.value = STEP * 2;
        swarmDelayFB  = ctx.createGain();     swarmDelayFB.gain.value    = 0.42;
        swarmDelayOut = ctx.createGain();     swarmDelayOut.gain.value   = 0.38;
        swarmFilt.connect(swarmDelay);
        swarmDelay.connect(swarmDelayFB); swarmDelayFB.connect(swarmDelay);
        swarmDelay.connect(swarmDelayOut); swarmDelayOut.connect(verbSend);

        // Distortion waveshaper curve shared by all glitch bursts
        distCurve = (function () {
            var n = 512, c = new Float32Array(n), k = 200;
            for (var i = 0; i < n; i++) {
                var x = i * 2 / n - 1;
                c[i] = (Math.PI + k) * x / (Math.PI + k * Math.abs(x));
            }
            return c;
        })();
    }

    // ── Chord state ──────────────────────────────────────────────────
    function setChordState(def) {
        curChord = def;
        curRoot  = def.r + semis;
        var iv = def.iv;
        for (var i = 0; i < 3; i++) padFreqs[i] = mtof(curRoot + iv[i % iv.length]);
        if (ctx) {
            var now = ctx.currentTime;
            subOsc.frequency.cancelScheduledValues(now);
            subOsc.frequency.setTargetAtTime(mtof(curRoot-12), now, 2.0);
            swarmOscs = swarmOscs.filter(function(v) { return v.stopAt > now; });
            swarmOscs.forEach(function(v) {
                v.osc.frequency.setTargetAtTime(mtof(curRoot + v.relSemis), now, 2.0);
            });
        }
    }

    // Voicing for an arbitrary root — used by passing chords, which sound
    // without disturbing the sustained chord state.
    function chordFreqs(root, iv) {
        var f = [];
        for (var i = 0; i < 3; i++) f[i] = mtof(root + iv[i % iv.length]);
        return f;
    }

    // ── Pad stab ─────────────────────────────────────────────────────
    var PTYP  = ['sawtooth','sawtooth','triangle'];
    var PDET  = [-7, +7, +2];
    var PBASE = [0.063, 0.063, 0.081];
    function triggerPad(when, vel, freqs, decay) {
        var f = freqs || padFreqs;
        var d = decay || 1.5;
        for (var pi = 0; pi < 3; pi++) {
            (function (i) {
                var osc = ctx.createOscillator();
                osc.type = PTYP[i]; osc.detune.value = PDET[i] * P.padDetune;
                osc.frequency.value = f[i];
                var g = ctx.createGain();
                g.gain.setValueAtTime(0.001, when);
                g.gain.linearRampToValueAtTime(PBASE[i]*vel*P.padLevel, when+0.016);
                g.gain.setTargetAtTime(0.001, when+0.016, d);
                osc.connect(g); g.connect(mFilt);
                osc.start(when); osc.stop(when+7.0);
                osc.onended = function(){try{g.disconnect();osc.disconnect();}catch(e){}};
            })(pi);
        }
    }

    // ── Stab rhythm ──────────────────────────────────────────────────
    // The template's `p` array is the bar's home rhythm; these reshape it so
    // a 16-bar section doesn't repeat the identical stab pattern 16 times.
    // Returns [[eighthPosition, velocityScale], ...].
    function stabsForBar(tmpl, style, rnd) {
        var p = tmpl.p, vp = tmpl.vp, n = tmpl.n, out = [], i;

        function push(idx, scale) {
            out.push([p[idx] % n, (vp[idx] !== undefined ? vp[idx] : 0.8) * scale]);
        }

        if (style === 'sparse') {
            push(0, 0.85);
            if (rnd() < 0.35 && p.length > 2) push(p.length - 1, 0.6);
        } else if (style === 'alt') {
            for (i = 0; i < p.length; i += 2) push(i, 0.95);
            if (rnd() < 0.4 && p.length > 1) push(1, 0.55);
        } else if (style === 'tail') {
            for (i = Math.max(0, p.length - 2); i < p.length; i++) push(i, 0.8);
        } else if (style === 'push') {
            // Anticipations — everything but the downbeat lands an eighth early
            push(0, 1.0);
            for (i = 1; i < p.length; i++) {
                out.push([(p[i] - 1 + n) % n, (vp[i] || 0.8) * 0.9]);
            }
        } else if (style === 'dense') {
            for (i = 0; i < p.length; i++) push(i, 1.0);
            for (i = 0; i < n; i++) {
                if (p.indexOf(i) === -1 && rnd() < 0.22) out.push([i, 0.42]);
            }
        } else { // 'full'
            for (i = 0; i < p.length; i++) push(i, 1.0);
        }

        // Drop a hit now and then so even the home rhythm breathes
        if (out.length > 2 && rnd() < 0.22) out.splice(1 + Math.floor(rnd() * (out.length - 1)), 1);
        return out;
    }

    // ── Bass note ────────────────────────────────────────────────────
    function triggerBass(when) {
        var ivl = BWALK[bwalkI % BWALK.length]; bwalkI++;
        var osc = ctx.createOscillator(); osc.type = 'sawtooth';
        osc.frequency.value = mtof(curRoot + ivl);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.001, when);
        g.gain.linearRampToValueAtTime(0.162 * P.bassLevel, when+0.007);
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
        g.gain.linearRampToValueAtTime(1.40 * vel, when + 0.003);
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
        ng.gain.linearRampToValueAtTime(0.88 * vel, when + 0.002);
        ng.gain.exponentialRampToValueAtTime(0.001, when + 0.10);
        src.connect(nf); nf.connect(ng); ng.connect(drumBus);
        src.start(when, off, 0.12);
        var tosc = ctx.createOscillator(); tosc.type = 'sine'; tosc.frequency.value = 195;
        var tg = ctx.createGain();
        tg.gain.setValueAtTime(0.001, when);
        tg.gain.linearRampToValueAtTime(0.40 * vel, when + 0.002);
        tg.gain.exponentialRampToValueAtTime(0.001, when + 0.042);
        tosc.connect(tg); tg.connect(drumBus);
        tosc.start(when); tosc.stop(when + 0.06);
        // ~30% of hits get a dotted-8th Massive Attack echo trail
        if (snareDelay && Math.random() < 0.30) {
            var dSend = ctx.createGain(); dSend.gain.value = vel * 0.52;
            ng.connect(dSend); dSend.connect(snareDelay);
            setTimeout(function () { try { dSend.disconnect(); } catch (e) {} }, 4500);
        }
        src.onended  = function(){try{ng.disconnect();nf.disconnect();src.disconnect();}catch(e){}};
        tosc.onended = function(){try{tg.disconnect();tosc.disconnect();}catch(e){}};
    }

    function triggerHat(when, vel) {
        var src = ctx.createBufferSource(); src.buffer = drumNoiseBuf;
        var hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 8500;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.001, when);
        g.gain.linearRampToValueAtTime(0.56 * vel, when + 0.001);
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
        g.gain.linearRampToValueAtTime(0.28 * vel, when + 0.002);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.065);
        src.connect(nf); nf.connect(g); g.connect(drumBus);
        src.start(when, Math.random() * 0.7, 0.08);
        src.onended = function(){try{g.disconnect();nf.disconnect();src.disconnect();}catch(e){}};
    }

    // Schedule one bar of drums, anchored to barT, thinned to the section's
    // density. The groove matches the CURRENT template so drums stay on the
    // bar grid through time-signature changes.
    //   1 = skeleton: downbeat kicks, backbeat, every other hat, no ghosts
    //   2 = the groove as written
    //   3 = busy: groove plus offbeat ghosts and doubled hats
    function schedDrumBar(barT, density, rnd) {
        if (density <= 0) return;
        var grv = DGRV[curTmplIdx];
        var i, steps = curTmpl.n * 2;

        for (i = 0; i < grv.k.length; i++) {
            if (density === 1 && i > 1) continue;
            triggerKick(barT + grv.k[i][0]*DSTEP, grv.k[i][1]);
        }
        for (i = 0; i < grv.s.length; i++) {
            triggerSnare(barT + grv.s[i][0]*DSTEP, grv.s[i][1]);
        }
        for (i = 0; i < grv.h.length; i++) {
            if (density === 1 && (i & 1)) continue;
            triggerHat(barT + grv.h[i][0]*DSTEP, grv.h[i][1] * (density === 1 ? 0.8 : 1));
        }
        if (density >= 2) {
            for (i = 0; i < grv.g.length; i++) triggerGhost(barT + grv.g[i][0]*DSTEP, grv.g[i][1]);
        }
        if (density >= 3) {
            // Offbeat sixteenths between the written hats
            for (i = 1; i < steps; i += 2) {
                if (rnd() < 0.45) triggerGhost(barT + i*DSTEP, 0.13 + rnd()*0.07);
            }
        }
    }

    // Fill across the tail of a bar, crescendoing into the downbeat that
    // follows. Sections used to cut straight from one groove to the next with
    // nothing signalling the change — this is what leads the ear over.
    function schedDrumFill(barT, strength, rnd) {
        var steps = curTmpl.n * 2;
        var len   = Math.min(steps, 6 + Math.floor(rnd() * 5));   // last 6–10 sixteenths
        var start = steps - len;

        for (var i = start; i < steps; i++) {
            var t    = barT + i * DSTEP;
            var prog = (i - start) / len;                          // 0 → 1 across the fill
            var vel  = (0.30 + prog * 0.62) * strength;

            // Density ramps up as the fill approaches the downbeat
            if (rnd() < 0.45 + prog * 0.45) triggerSnare(t, vel * 0.85);
            if (rnd() < 0.35 + prog * 0.40) triggerGhost(t + DSTEP * 0.5, vel * 0.6);
            if (prog > 0.55 && rnd() < 0.30) triggerKick(t, vel * 0.7);
        }
        // Land it
        triggerKick(barT + steps * DSTEP, 0.95 * strength);
    }

    // ── Swarmatron — structural modes (bloom/ascent/exhale/drift), pad layer +
    //    melodic layer that phrases through scale tones with portamento.
    //    Pad voices are chord-tracked (swarmOscs); melodic voices are not —
    //    they keep their scheduled phrase through chord changes.
    function triggerSwarm(when, dur) {
        var sc    = SCALES[curChord ? curChord.sc : 'dorian'];
        var scLen = sc.length;
        var root  = curRoot;
        var iv    = curChord ? curChord.iv : [0, 7, 10];

        var mRng = Math.random();
        var mode = mRng < 0.28 ? 'bloom'
                 : mRng < 0.55 ? 'drift'
                 : mRng < 0.78 ? 'ascent'
                 : 'exhale';

        // Master gain — shape varies per mode to drive dynamics
        var PEAK = P.swarmLevel;
        if (PEAK <= 0) return;  // muted — skip building the whole voice graph
        var masterG = ctx.createGain();
        masterG.gain.setValueAtTime(0, when);
        masterG.connect(swarmFilt);

        if (mode === 'bloom') {
            // Slow build toward tension peak, then release
            masterG.gain.linearRampToValueAtTime(PEAK * 0.35, when + dur * 0.22);
            masterG.gain.linearRampToValueAtTime(PEAK,        when + dur * 0.65);
            masterG.gain.setValueAtTime(PEAK,                 when + dur * 0.84);
            masterG.gain.exponentialRampToValueAtTime(0.001,  when + dur);
        } else if (mode === 'ascent') {
            // Rises quickly, holds dissonant peak, cuts off
            masterG.gain.linearRampToValueAtTime(PEAK * 0.55, when + dur * 0.12);
            masterG.gain.linearRampToValueAtTime(PEAK,        when + dur * 0.72);
            masterG.gain.exponentialRampToValueAtTime(0.001,  when + dur * 0.97);
        } else if (mode === 'exhale') {
            // Appears present, decays away
            masterG.gain.linearRampToValueAtTime(PEAK,        when + dur * 0.10);
            masterG.gain.linearRampToValueAtTime(PEAK * 0.28, when + dur * 0.84);
            masterG.gain.exponentialRampToValueAtTime(0.001,  when + dur);
        } else { // drift
            // Quiet and constant — background texture
            masterG.gain.linearRampToValueAtTime(PEAK * 0.70, when + 1.4);
            masterG.gain.setValueAtTime(PEAK * 0.70,          when + dur - 1.0);
            masterG.gain.exponentialRampToValueAtTime(0.001,  when + dur);
        }

        // ── PAD LAYER: 4 voices on chord tones (chord-tracked via swarmOscs) ──
        var PAD_TYPES = ['sawtooth', 'square', 'triangle', 'sawtooth'];
        var PAD_DET   = [-20, +20, +5, -8];

        for (var pi = 0; pi < 4; pi++) {
            (function (i) {
                var relSemis = iv[i % iv.length] + (i < 2 ? 0 : 12);
                var osc = ctx.createOscillator();
                osc.type = PAD_TYPES[i];
                osc.frequency.value = mtof(root + relSemis);
                osc.detune.value = PAD_DET[i] * P.swarmSpread;

                var lfo = ctx.createOscillator(); var lfoG = ctx.createGain();
                lfo.frequency.value = 0.05 + Math.random() * 0.09;
                lfoG.gain.value = 1.5 + Math.random() * 2.0;
                lfo.connect(lfoG); lfoG.connect(osc.detune);
                lfo.start(when); lfo.stop(when + dur + 0.2);

                var tremLfo = ctx.createOscillator(); var tremG = ctx.createGain();
                tremLfo.frequency.value = 0.09 + Math.random() * 0.13;
                tremG.gain.value = 0.07 + Math.random() * 0.09;
                tremLfo.start(when); tremLfo.stop(when + dur + 0.2);
                var vGain = ctx.createGain(); vGain.gain.value = 1.0;
                tremLfo.connect(tremG); tremG.connect(vGain.gain);

                osc.connect(vGain); vGain.connect(masterG);
                osc.start(when); osc.stop(when + dur + 0.2);

                swarmOscs.push({ osc: osc, relSemis: relSemis, stopAt: when + dur + 0.2 });
                osc.onended = function () { try { vGain.disconnect(); osc.disconnect(); } catch (e) {} };
            })(pi);
        }

        // ── MELODIC LAYER: portamento phrases through scale degrees ──
        // NOT added to swarmOscs — keeps its phrase through chord changes.
        // noteIdxs = scale degree indices (0=root 1=2nd 2=3rd 3=4th 4=5th 5=6th 6=7th)
        // glideFrac = fraction of step duration used for the portamento slide
        function melVoice(waveType, octOff, detCents, noteIdxs, glideFrac) {
            var step = dur / noteIdxs.length;
            var osc = ctx.createOscillator();
            osc.type = waveType;
            osc.detune.value = detCents;
            osc.frequency.setValueAtTime(mtof(root + sc[noteIdxs[0] % scLen] + octOff), when);

            // Gentle vibrato for melodic expression
            var vib = ctx.createOscillator(); var vibG = ctx.createGain();
            vib.frequency.value = 4.5 + Math.random() * 1.5;
            vibG.gain.value = 3 + Math.random() * 4;
            vib.connect(vibG); vibG.connect(osc.detune);
            vib.start(when); vib.stop(when + dur + 0.2);

            // Hold at each pitch, then glide over glideFrac of the step
            for (var ni = 1; ni < noteIdxs.length; ni++) {
                var noteT    = when + ni * step;
                var prevFreq = mtof(root + sc[noteIdxs[ni - 1] % scLen] + octOff);
                var newFreq  = mtof(root + sc[noteIdxs[ni]     % scLen] + octOff);
                osc.frequency.setValueAtTime(prevFreq, noteT);
                osc.frequency.exponentialRampToValueAtTime(newFreq, noteT + step * glideFrac);
            }

            var g = ctx.createGain(); g.gain.value = 1.0;
            osc.connect(g); g.connect(masterG);
            osc.start(when); osc.stop(when + dur + 0.2);
            osc.onended = function () { try { g.disconnect(); osc.disconnect(); } catch (e) {} };
        }

        if (mode === 'bloom') {
            // Rises through scale, reaches minor 7th (tension), settles to 6th
            melVoice('triangle', 12, +3, [0, 1, 2, 4, 6, 5], 0.60);
            // Counter voice, fills harmony below
            melVoice('sawtooth',  0, -5, [4, 5, 6, 5, 3, 4], 0.65);
        } else if (mode === 'ascent') {
            // Climbs scale, holds at dissonant peak
            melVoice('sawtooth', 12, +2, [0, 2, 4, 5, 6, 6], 0.55);
            // High register voice pushing at the ceiling
            melVoice('square',   24, -4, [3, 5, 6, 6, 5, 4], 0.60);
        } else if (mode === 'exhale') {
            // Descends to root — releases tension
            melVoice('triangle', 12, +2, [6, 5, 4, 2, 1, 0], 0.65);
            melVoice('sawtooth',  0, -3, [5, 4, 3, 2, 1, 0], 0.70);
        } else { // drift
            // Slow wander, never strays far from root
            melVoice('triangle', 12, +5, [0, 2, 1, 3, 2, 0], 0.75);
        }

        var cleanMs = Math.max((when + dur + 0.3 - ctx.currentTime) * 1000, 200);
        setTimeout(function () { try { masterG.disconnect(); } catch (e) {} }, cleanMs);
    }

    // ── Year Zero glitch bursts — three flavours ──────────────────────
    function triggerGlitch(when) {
        var type = Math.random();
        if (type < 0.38) {
            // A: digital screech — high bandpass noise + heavy distortion
            var offA = Math.random() * 0.5;
            var srcA = ctx.createBufferSource(); srcA.buffer = drumNoiseBuf;
            var wsA  = ctx.createWaveShaper(); wsA.curve = distCurve;
            var bpA  = ctx.createBiquadFilter();
            bpA.type = 'bandpass';
            bpA.frequency.setValueAtTime(5400, when);
            bpA.frequency.exponentialRampToValueAtTime(1600, when + 0.09);
            bpA.Q.value = 4.5;
            var gA = ctx.createGain();
            gA.gain.setValueAtTime(0, when);
            gA.gain.linearRampToValueAtTime(0.182, when + 0.003);
            gA.gain.exponentialRampToValueAtTime(0.001, when + 0.10);
            srcA.connect(wsA); wsA.connect(bpA); bpA.connect(gA); gA.connect(drumBus);
            srcA.start(when, offA, 0.12);
            srcA.onended = function () { try { gA.disconnect(); bpA.disconnect(); wsA.disconnect(); srcA.disconnect(); } catch (e) {} };

        } else if (type < 0.72) {
            // B: stutter sequence — 3-5 micro-hits slightly off the grid
            var count = 3 + Math.floor(Math.random() * 3);
            var gap   = DSTEP * (0.35 + Math.random() * 0.50);
            for (var k = 0; k < count; k++) {
                (function (ki) {
                    var t   = when + ki * gap + (Math.random() * 0.010 - 0.005);
                    var offB = Math.random() * 0.6;
                    var srcB = ctx.createBufferSource(); srcB.buffer = drumNoiseBuf;
                    var wsB  = ctx.createWaveShaper(); wsB.curve = distCurve;
                    var bpB  = ctx.createBiquadFilter();
                    bpB.type = 'bandpass'; bpB.frequency.value = 1800 + Math.random() * 3400; bpB.Q.value = 5.5;
                    var gB  = ctx.createGain();
                    var vB  = 0.117 * Math.pow(0.78, ki);
                    gB.gain.setValueAtTime(0, t);
                    gB.gain.linearRampToValueAtTime(vB, t + 0.002);
                    gB.gain.exponentialRampToValueAtTime(0.001, t + 0.030);
                    srcB.connect(wsB); wsB.connect(bpB); bpB.connect(gB); gB.connect(drumBus);
                    srcB.start(t, offB, 0.04);
                    srcB.onended = function () { try { gB.disconnect(); bpB.disconnect(); wsB.disconnect(); srcB.disconnect(); } catch (e) {} };
                })(k);
            }

        } else {
            // C: industrial sub-rumble — distorted low-frequency body hit
            var offC = Math.random() * 0.5;
            var srcC = ctx.createBufferSource(); srcC.buffer = drumNoiseBuf;
            var wsC  = ctx.createWaveShaper(); wsC.curve = distCurve;
            var lpC  = ctx.createBiquadFilter();
            lpC.type = 'lowpass'; lpC.frequency.value = 340; lpC.Q.value = 2.2;
            var gC   = ctx.createGain();
            gC.gain.setValueAtTime(0, when);
            gC.gain.linearRampToValueAtTime(0.26, when + 0.007);
            gC.gain.exponentialRampToValueAtTime(0.001, when + 0.22);
            srcC.connect(wsC); wsC.connect(lpC); lpC.connect(gC); gC.connect(comp);
            srcC.start(when, offC, 0.26);
            srcC.onended = function () { try { gC.disconnect(); lpC.disconnect(); wsC.disconnect(); srcC.disconnect(); } catch (e) {} };
        }
    }

    // ── Melody ────────────────────────────────────────────────────────
    function playMelNote(when, freq, dur) {
        var osc = ctx.createOscillator(); osc.type = 'triangle';
        osc.frequency.value = freq;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.001, when);
        g.gain.linearRampToValueAtTime(0.126 * P.melLevel, when+0.06);
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
            melFbGain.gain.setTargetAtTime(Math.min(0.85, 0.38 * P.melEcho), now, 0.15);
            melDelayOut.gain.setTargetAtTime(0.70 * P.melEcho, now, 0.15);
            var offT = barStartT + tail + dt * 7;
            melFbGain.gain.setTargetAtTime(0.0, offT, 0.6);
            melDelayOut.gain.setTargetAtTime(0.0, offT, 0.6);
        }
    }

    // Move the mix to a new section. Everything ramps over roughly a bar so
    // sections arrive rather than switch.
    function applySection(sec, when) {
        if (!ctx) return;
        var T = curTmpl.n * STEP * 0.45;
        drumBus.gain.setTargetAtTime(P.drumLevel  * sec.dg, when, T);
        mFilt.frequency.setTargetAtTime(P.masterTone * sec.to, when, T);
        nGain.gain.setTargetAtTime(P.noiseLevel   * sec.nz, when, T);
        subGain.gain.setTargetAtTime(P.subLevel   * sec.sb, when, T);
    }

    // Chord a semitone above or below the next one, sounded on the last
    // eighth of the bar before a change — a leading tone into the new chord.
    function schedPassingChord(when, nextDef, rnd) {
        var dir  = rnd() < 0.5 ? 1 : -1;
        var root = nextDef.r + semis + dir;
        triggerPad(when, 0.42, chordFreqs(root, nextDef.iv), 0.35);
    }

    // ── Lookahead scheduler ───────────────────────────────────────────
    function tick() {
        while (nextStepT < ctx.currentTime + AHEAD) {
            var barsToChord = 4;                       // chord turns over every 4 bars
            var lastBarOfSection = (secBar === SECTION_BARS - 1);
            var rnd = barRng(barCount + 1);
            var stabs = stabsForBar(curTmpl, curSec.st, rnd);

            // Bar start: drums, glitch events, swarmatron, melody
            if (stepInBar === 0) {
                if (drumActive) {
                    if (lastBarOfSection && curSec.d > 0) {
                        // Fill out of the section instead of cutting dead
                        schedDrumBar(nextStepT, Math.max(1, curSec.d - 1), rnd);
                        schedDrumFill(nextStepT, 0.75 + (SECTIONS[(secIdx+1) % SECTIONS.length].d >= 2 ? 0.25 : 0), rnd);
                    } else {
                        schedDrumBar(nextStepT, curSec.d, rnd);
                    }

                    // Year Zero glitch burst — ~22% per bar, offset slightly into the bar
                    if (Math.random() < 0.22) {
                        triggerGlitch(nextStepT + Math.random() * STEP * 1.5);
                    }
                    // Swarmatron — only where the section calls for it
                    if (--swarmCountdown <= 0) {
                        if (curSec.sw) {
                            var barDur = curTmpl.n * STEP;
                            triggerSwarm(nextStepT, barDur * (2 + Math.floor(Math.random() * 3)));
                        }
                        swarmCountdown = Math.max(1, Math.round(P.swarmRate)) +
                                         Math.floor(Math.random() * 2);
                    }
                }
                if (curSec.ml && nextStepT >= melNextT) schedMelPhrase(nextStepT);
            }

            // Pads follow the section's stab style; bass thins in quiet sections
            for (var si = 0; si < stabs.length; si++) {
                if (stabs[si][0] === stepInBar) {
                    triggerPad(nextStepT, stabs[si][1] * curSec.pd);
                }
            }
            var bi = inArr(curTmpl.b, stepInBar);
            if (bi !== -1 && rnd() < curSec.bs) triggerBass(nextStepT);

            // Passing chord on the final eighth before the chord turns over
            if (stepInBar === curTmpl.n - 1 && (barCount + 1) % barsToChord === 0) {
                schedPassingChord(nextStepT + STEP * 0.5,
                                  CHORDS[curProg[(progPos + 1) % curProg.length]], rnd);
            }

            nextStepT += STEP;
            stepInBar++;

            if (stepInBar >= curTmpl.n) {
                stepInBar = 0;
                barCount++;
                secBar++;

                if (barCount % barsToChord === 0) {
                    progPos = (progPos+1) % curProg.length;
                    setChordState(CHORDS[curProg[progPos]]);
                }

                // Section turnover — one template per section, so the metre
                // holds long enough to establish itself
                if (secBar >= SECTION_BARS) {
                    secBar     = 0;
                    secIdx     = (secIdx + 1) % SECTIONS.length;
                    curSec     = SECTIONS[secIdx];
                    curTmplIdx = curSec.t;
                    curTmpl    = TMPLS[curTmplIdx];
                    applySection(curSec, nextStepT);
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
        applyInitParams();
        master.gain.setTargetAtTime(P.masterVol, now, 2.0);
        // Section 0 (INTRO) owns the opening mix — drumless, dark, sub-heavy.
        subGain.gain.setTargetAtTime(P.subLevel  * curSec.sb, now+1.5, 3.5);
        nGain.gain.setTargetAtTime(P.noiseLevel  * curSec.nz, now+4.0, 2.5);
        drumBus.gain.setTargetAtTime(P.drumLevel * curSec.dg, now,     1.0);
        setChordState(CHORDS[curProg[0]]);
        nextStepT = now + 0.6;
        // Gate scheduling open once the pads have established
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
        // Scale the sector's character by the user's TONE setting rather than
        // overwriting it, so a SYNTH tweak survives sector changes.
        var fqs = [1800,1400,2500,1100];
        mFilt.frequency.setTargetAtTime(fqs[idx%4] * (P.masterTone / 1800), ctx.currentTime, 5.0);
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
        mFilt.Q.setTargetAtTime(P.masterReso, now+0.18, 0.25);
        nGain.gain.setTargetAtTime(Math.max(0.15, P.noiseLevel), now, 0.008);
        nGain.gain.setTargetAtTime(P.noiseLevel, now+0.45, 0.20);
    }

    function onIdleFlash() {
        if (!ctx) return;
        var now = ctx.currentTime;
        nGain.gain.setTargetAtTime(Math.max(0.060, P.noiseLevel), now, 0.018);
        nGain.gain.setTargetAtTime(P.noiseLevel, now+0.30, 0.14);
    }

    function pause() {
        if (ctx && ctx.state === 'running') ctx.suspend();
    }

    function resume() {
        if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    // ── Param API (consumed by synth-ui.js) ───────────────────────────
    // Values can be set before audio starts; applyParam() no-ops without a
    // graph and init() applies the stored values when the context comes up.
    function getParamDefs() { return PARAM_DEFS; }
    function getParam(id)   { return P[id]; }

    function setParam(id, v) {
        if (!(id in P)) return;
        P[id] = v;
        applyParam(id);
    }

    function resetParams() {
        for (var k in DEFAULTS) {
            if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
            P[k] = DEFAULTS[k];
            applyParam(k);
        }
    }

    return {init:init, pause:pause, resume:resume,
            setSector:setSector, setTextSeed:setTextSeed,
            onGlitch:onGlitch, onIdleFlash:onIdleFlash,
            getAnalyser: function () { return analyser; },
            getParamDefs: getParamDefs, getParam: getParam,
            setParam: setParam, resetParams: resetParams,
            isReady: function () { return !!ctx; }};
})();
