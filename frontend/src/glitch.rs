use wasm_bindgen::{JsCast, JsValue};
use web_sys::{CanvasRenderingContext2d, Document, Element, HtmlCanvasElement};

// ── LCG RNG ───────────────────────────────────────────────────────────

struct Lcg(u64);
impl Lcg {
    fn new(seed: u64) -> Self { Self(seed ^ 0xdeadbeef_cafebabe) }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0
    }
    fn f64(&mut self) -> f64 { (self.next() >> 11) as f64 / (1u64 << 53) as f64 }
    fn range(&mut self, lo: f64, hi: f64) -> f64 { lo + self.f64() * (hi - lo) }
    fn pick(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
    fn chance(&mut self, p: f64) -> bool { self.f64() < p }
    fn u32(&mut self, n: u32) -> u32 { (self.next() % n as u64) as u32 }
}

// ── Year Zero palette ─────────────────────────────────────────────────

const PAL: [(u8, u8, u8); 7] = [
    (196,  8,  0),
    (220, 40,  0),
    (120,  0,  0),
    (255, 100,  0),
    ( 50,  0,  0),
    (200, 160, 110),
    (  0,  20, 80),
];

// Hover ghost chars — uppercase alphanumeric to match menu weight
const GHOST_CHARS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/-|><";

// Interlace constants
const INTERLACE_BASE: f32 = 0.0008;  // always-on (~1.5px at 1920w)
const INTERLACE_HOVER: f32 = 0.0013;
const INTERLACE_PEAK: f32 = 0.0043;  // added on top of base at transition peak

// ── idle flash state ──────────────────────────────────────────────────

struct IdleFlash {
    start_ts: f64,
    duration: f64,  // ms
}

// ── transition state ──────────────────────────────────────────────────

struct TState {
    start_ts:  f64,
    duration:  f64,
    t:         f64,
    intensity: f64,  // per-transition strength multiplier (0.3–1.5)
    do_lines:  bool,
    do_strips: bool,
    do_log:    bool,
    do_blocks: bool,
    sort_y0:   f32,  // UV y-band for GPU sort (random screen portion)
    sort_y1:   f32,
}

// ── public struct ─────────────────────────────────────────────────────

pub struct GlitchLayer {
    ctx:         CanvasRenderingContext2d,
    w:           f64,
    h:           f64,
    state:       Option<TState>,
    frame:       u64,
    ghost_chars: Vec<char>,

    hover_active: bool,
    hover_src:    String,
    hover_x:      f64,
    hover_y:      f64,
    hover_offset: (f64, f64),
    hover_ghost:  Element,

    idle_flash:    Option<IdleFlash>,
    next_flash_ts: f64,  // perf_now() timestamp when next idle flash should start
}

// Returns (pixel_size, chroma_str, interlace_str, sort_amount, time, sort_y0, sort_y1) every tick.
// interlace_str is non-zero even when idle (always-on subtle desync).
// sort_y0/sort_y1 define the UV y-band where GPU pixel-sort applies.
pub type GlitchParams = (f32, f32, f32, f32, f32, f32, f32);

impl GlitchLayer {
    pub fn new(doc: &Document) -> Result<Self, String> {
        let canvas = doc.get_element_by_id("glitch-canvas")
            .ok_or("no #glitch-canvas")?
            .dyn_into::<HtmlCanvasElement>()
            .map_err(|_| "#glitch-canvas not a canvas")?;

        let win = web_sys::window().ok_or("no window")?;
        let w = win.inner_width().ok().and_then(|v| v.as_f64()).unwrap_or(1280.0);
        let h = win.inner_height().ok().and_then(|v| v.as_f64()).unwrap_or(720.0);
        canvas.set_width(w as u32);
        canvas.set_height(h as u32);

        let ctx = canvas
            .get_context("2d").map_err(|_| "get_context err")?
            .ok_or("no 2d ctx")?
            .dyn_into::<CanvasRenderingContext2d>()
            .map_err(|_| "not CanvasRenderingContext2d")?;

        let hover_ghost = doc.get_element_by_id("hover-ghost")
            .ok_or("no #hover-ghost")?;

        let ghost_chars: Vec<char> = GHOST_CHARS.chars().collect();

        Ok(Self {
            ctx, w, h,
            state: None,
            frame: 0,
            ghost_chars,
            hover_active:  false,
            hover_src:     String::new(),
            hover_x:       0.0,
            hover_y:       0.0,
            hover_offset:  (8.0, 3.0),
            hover_ghost,
            idle_flash:    None,
            next_flash_ts: perf_now() + 3000.0,  // first flash ~3 s after load
        })
    }

    // ── transition API ────────────────────────────────────────────────

    pub fn trigger(&mut self) {
        let ts = perf_now();
        let mut rng = Lcg::new(ts as u64 ^ self.frame.wrapping_mul(0x9e3779b97f4a7c15));

        // Random vertical band for the GPU pixel-sort displacement
        let y0 = rng.range(0.0, 0.75) as f32;
        let y1 = (y0 + rng.range(0.05, 0.65) as f32).min(1.0);

        // Pick 3 or 4 effects: 50% chance one random effect is skipped.
        let skip: Option<usize> = if rng.chance(0.5) { Some(rng.pick(4)) } else { None };

        self.state = Some(TState {
            start_ts:  ts,
            duration:  rng.range(700.0, 3200.0),
            t:         0.0,
            intensity: rng.range(0.28, 1.55),
            do_lines:  skip != Some(0),
            do_strips: skip != Some(1),
            do_log:    skip != Some(2),
            do_blocks: skip != Some(3),
            sort_y0:   y0,
            sort_y1:   y1,
        });
    }

    // ── hover API ─────────────────────────────────────────────────────

    pub fn hover_enter(&mut self, text: &str, x: f64, y: f64) {
        self.hover_active = true;
        // Collapse whitespace, preserve inner structure with NBSP
        self.hover_src = text.split_whitespace()
            .collect::<Vec<_>>()
            .join("\u{00a0}");
        self.hover_x = x;
        self.hover_y = y;

        let mut rng = Lcg::new(self.frame ^ 0xcafebabe);
        self.hover_offset = (rng.range(6.0, 16.0), rng.range(1.0, 5.0));
        self.update_ghost(&mut rng, 0.0, 0.0);
    }

    pub fn hover_leave(&mut self) {
        self.hover_active = false;
        let _ = self.hover_ghost.set_attribute("style", "display: none;");
        self.ctx.clear_rect(0.0, 0.0, self.w, self.h);
    }

    // ── main tick — call once per animation frame ─────────────────────

    pub fn tick(&mut self) -> GlitchParams {
        self.frame = self.frame.wrapping_add(1);
        let now  = perf_now();
        let time = (now / 1000.0) as f32;  // seconds since page load → grain seed

        // ── full transition ───────────────────────────────────────────
        if let Some(ref mut st) = self.state {
            st.t = ((now - st.start_ts) / st.duration).min(1.0);
            let t = st.t;

            if t >= 1.0 {
                self.state = None;
                self.ctx.clear_rect(0.0, 0.0, self.w, self.h);
                return (1.0, 0.0, INTERLACE_BASE, 0.0, time, 0.0, 1.0);
            }

            let q    = envelope(t);
            let seed = (now as u64).wrapping_mul(2654435761).wrapping_add(self.frame >> 1);
            let mut rng = Lcg::new(seed);

            let (do_lines, do_strips, do_log, do_blocks, intensity, sort_y0, sort_y1) = {
                let st = self.state.as_ref().unwrap();
                (st.do_lines, st.do_strips, st.do_log, st.do_blocks,
                 st.intensity, st.sort_y0, st.sort_y1)
            };

            self.ctx.clear_rect(0.0, 0.0, self.w, self.h);
            if do_lines  { self.draw_scanlines(q); }
            // Displacement slices — no q scaling, just random snap positions each frame
            if do_strips { self.draw_displacement_slices(&mut rng); }
            if do_log    { self.draw_system_log(q, &mut rng); }
            if do_blocks { self.draw_blocks(q, &mut rng); }

            // ── GPU effects: stepped/chaotic rather than smooth q ramp ────
            // pixel_size: snap to discrete sizes rather than smooth ramp
            let pixel_size: f32 = if q > 0.04 {
                const SIZES: [f32; 9] = [1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 18.0, 24.0];
                let base_idx = (q * intensity * 8.0) as usize;
                let jitter   = rng.pick(3);  // ±1-2 size steps for each frame
                SIZES[(base_idx + jitter).min(8)]
            } else { 1.0 };

            // chroma: random spike on/off each frame (not smooth ramp)
            let chroma: f32 = if rng.chance(0.42) && q > 0.04 {
                rng.range(0.003, (0.032 * intensity).min(0.040)) as f32
            } else { 0.0 };

            // interlace: base + random spike
            let interlace = INTERLACE_BASE + if q > 0.03 {
                rng.range(0.0, INTERLACE_PEAK as f64 * intensity * q.sqrt()) as f32
            } else { 0.0 };

            // sort: random level (not smooth), capped by intensity
            let sort_amount: f32 = if q > 0.03 {
                (rng.range(0.06, intensity.min(1.0)) * q.sqrt()) as f32
            } else { 0.0 };

            return (pixel_size, chroma, interlace, sort_amount, time, sort_y0, sort_y1);
        }

        // ── hover-only mode ───────────────────────────────────────────
        if self.hover_active {
            let seed = (self.frame >> 1).wrapping_mul(2654435761);
            let mut rng = Lcg::new(seed);

            if self.frame % 3 == 0 {
                let jx = rng.range(-1.5, 1.5);
                let jy = rng.range(-0.5, 0.5);
                self.update_ghost(&mut rng, jx, jy);
            }

            self.ctx.clear_rect(0.0, 0.0, self.w, self.h);
            let n = rng.pick(6) + 3;
            for _ in 0..n {
                let size = rng.range(18.0, 70.0);
                let x    = rng.range(0.0, (self.w - size).max(1.0));
                let y    = rng.range(0.0, (self.h - size).max(1.0));
                let (r, g, b) = PAL[rng.pick(PAL.len())];
                self.ctx.set_fill_style(&rgba(r, g, b, rng.range(0.04, 0.13)));
                self.ctx.fill_rect(x, y, size, size);
            }

            return (1.0, 0.0, INTERLACE_HOVER, 0.0, time, 0.0, 1.0);
        }

        // ── idle: random displacement flash ──────────────────────────
        let seed = (now as u64).wrapping_mul(2654435761).wrapping_add(self.frame >> 1);
        let mut rng = Lcg::new(seed);

        // Expire finished flash and schedule the next one
        if matches!(&self.idle_flash, Some(f) if (now - f.start_ts) >= f.duration) {
            self.idle_flash = None;
            let mut srng = Lcg::new(now as u64 ^ self.frame);
            self.next_flash_ts = now + srng.range(2000.0, 8000.0);
        }

        // Fire a new flash if it's time
        if self.idle_flash.is_none() && now >= self.next_flash_ts {
            let mut srng = Lcg::new(now as u64 ^ self.frame.wrapping_mul(0x517cc1b727220a95));
            self.idle_flash = Some(IdleFlash {
                start_ts: now,
                duration: srng.range(120.0, 480.0),
            });
            self.next_flash_ts = f64::MAX;
            let _ = js_sys::eval("if(window.__music)window.__music.onIdleFlash()");
        }

        if self.idle_flash.is_some() {
            // Redraw canvas at ~12 fps so bars hold position between updates
            if self.frame % 5 == 0 {
                self.ctx.clear_rect(0.0, 0.0, self.w, self.h);
                self.draw_idle_slices(&mut rng);
            }
            // GPU effects use a block-stable seed so they don't flicker every frame
            let block = self.frame / 5;
            let mut brng = Lcg::new(block.wrapping_mul(2654435761));
            let chroma    = if brng.chance(0.55) { brng.range(0.004, 0.018) as f32 } else { 0.0 };
            let interlace = INTERLACE_BASE + brng.range(0.0, INTERLACE_PEAK as f64 * 0.65) as f32;
            return (1.0, chroma, interlace, 0.0, time, 0.0, 1.0);
        }

        self.ctx.clear_rect(0.0, 0.0, self.w, self.h);
        (1.0, 0.0, INTERLACE_BASE, 0.0, time, 0.0, 1.0)
    }

    // ── ghost text ────────────────────────────────────────────────────

    fn update_ghost(&self, rng: &mut Lcg, jx: f64, jy: f64) {
        let text  = make_ghost(&self.hover_src, rng, &self.ghost_chars);
        let (ox, oy) = self.hover_offset;
        let style = format!(
            "display: block; left: {:.1}px; top: {:.1}px;",
            self.hover_x + ox + jx,
            self.hover_y + oy + jy,
        );
        let _ = self.hover_ghost.set_attribute("style", &style);
        self.hover_ghost.set_text_content(Some(&text));
    }

    // ── transition overlay renderers ──────────────────────────────────

    fn draw_scanlines(&self, q: f64) {
        self.ctx.set_fill_style(&rgba(0, 0, 0, q * 0.36));
        let mut y = 0.0f64;
        while y < self.h {
            self.ctx.fill_rect(0.0, y, self.w, 2.0);
            y += 5.0;
        }
    }

    fn draw_displacement_slices(&self, rng: &mut Lcg) {
        let count = rng.pick(5) + 1;  // 1–5 slices per frame
        for _ in 0..count {
            let y = rng.range(0.0, self.h);

            // Height: mix of razor-thin and chunky bands
            let h = {
                let r = rng.f64();
                if r < 0.45      { rng.range(1.0, 5.0) }
                else if r < 0.75 { rng.range(5.0, 22.0) }
                else             { rng.range(22.0, 90.0) }
            }.min(self.h - y);

            // Displacement direction and magnitude — always at least 5% of screen width
            let sign = if rng.chance(0.5) { 1.0_f64 } else { -1.0_f64 };
            let dx   = sign * rng.range(self.w * 0.05, self.w * 0.26);

            // Main displaced band — fixed alpha, no q scaling
            let (r, g, b) = PAL[rng.pick(PAL.len())];
            self.ctx.set_fill_style(&rgba(r, g, b, rng.range(0.28, 0.76)));
            self.ctx.fill_rect(dx, y, self.w, h);

            // Bright cut-line at the displacement boundary
            if rng.chance(0.68) {
                let cut_x = (if dx > 0.0 { dx } else { self.w + dx }).clamp(0.0, self.w - 1.0);
                let (cr, cg, cb) = PAL[rng.pick(3)];
                self.ctx.set_fill_style(&rgba(cr, cg, cb, rng.range(0.55, 1.0)));
                self.ctx.fill_rect(cut_x, y, 1.5, h);
            }
        }
    }

    fn draw_blocks(&self, q: f64, rng: &mut Lcg) {
        let n = ((q * 11.0) as u32 + 2).min(16);
        for _ in 0..n {
            let (r, g, b) = PAL[rng.pick(PAL.len())];
            self.ctx.set_fill_style(&rgba(r, g, b, rng.range(0.18, 0.58) * q));
            self.ctx.fill_rect(
                rng.range(0.0, self.w),
                rng.range(0.0, self.h),
                rng.range(8.0, self.w * 0.14),
                rng.range(2.0, 38.0),
            );
        }
    }

    // ── system log text (Option E) ────────────────────────────────────

    fn draw_system_log(&self, q: f64, rng: &mut Lcg) {
        self.ctx.set_font("9px 'Courier New',monospace");

        let n_lines = ((q * 11.0) as u32 + 2).min(16);
        // Three loose columns across the screen
        let col_xs = [0.02_f64, 0.38, 0.68];

        for _ in 0..n_lines {
            let kind = rng.pick(9);
            let text = gen_log_line(rng, kind);

            let cx  = col_xs[rng.pick(col_xs.len())];
            let x   = cx * self.w + rng.range(-4.0, 4.0);
            let y   = rng.range(10.0, self.h * 0.92);

            // Alert lines (err/warn/open_up) are brighter orange-red
            let is_alert = matches!(kind, 3 | 5 | 6);
            let (r, g, b) = if is_alert { PAL[1] } else { PAL[0] };
            let alpha = rng.range(0.30, 0.82) * q * if is_alert { 1.0 } else { 0.78 };

            self.ctx.set_fill_style(&rgba(r, g, b, alpha));
            let _ = self.ctx.fill_text(&text, x, y);
        }
    }
}

// ── system log line generator ─────────────────────────────────────────

fn gen_log_line(rng: &mut Lcg, kind: usize) -> String {
    match kind % 9 {
        0 => {
            // Timestamp + PAREPIN init
            let y  = 2027u32 + rng.u32(3);
            let mo = rng.u32(12) + 1;
            let d  = rng.u32(28) + 1;
            let h  = rng.u32(24);
            let mi = rng.u32(60);
            let s  = rng.u32(60);
            let code = rng.next() & 0xFFFF;
            format!("[{y}.{mo:02}.{d:02}.{h:02}:{mi:02}:{s:02}] PAREPIN INIT 0x{code:04X}")
        }
        1 => {
            // GPS coordinates — PRESENCE location
            let lat = 34.052_234 + (rng.f64() - 0.5) * 0.18;
            let lon = -118.243_685 - rng.f64() * 0.4;
            format!("STATUS: PRESENCE_DETECTED {lat:.6},{lon:.6}")
        }
        2 => {
            // Hex dump line
            let offset = rng.next() & 0xFFFF;
            let bytes: String = (0..8)
                .map(|_| format!("{:02X}", rng.next() & 0xFF))
                .collect::<Vec<_>>()
                .join(" ");
            format!("0x{offset:04X}: {bytes}")
        }
        3 => {
            // Auth failure
            let attempt = rng.u32(3) + 1;
            format!("ERR: AUTH FAILED ({attempt}/3) \u{2014} SIGNAL COMPROMISED")
        }
        4 => {
            // Network reject
            let a    = rng.u32(255);
            let b    = rng.u32(255);
            let port = 8000 + rng.u32(999);
            format!("NODE: 192.168.{a}.{b} > 10.0.0.1:{port} REJECT")
        }
        5 => {
            // Compliance breach
            let sector = rng.u32(8) + 1;
            format!(">>> WARNING: COMPLIANCE BREACH SECTOR {sector:02}")
        }
        6 => {
            // Core dump — OPEN_UP ARG reference
            let addr = rng.next() & 0xFFFF_FFFF;
            format!("OPEN_UP.exe \u{2014} CORE DUMP 0x{addr:08X}")
        }
        7 => {
            // Security clearance / OPAL system
            let levels = ["VIOLET", "INDIGO", "OPAL", "CRIMSON", "ZERO"];
            let lvl = levels[rng.pick(levels.len())];
            format!("OPAL SECURITY LEVEL: {lvl} \u{2014} 18 USC 2511")
        }
        _ => {
            // EXTERMINAL link with altitude
            let lat = 34.0 + (rng.f64() - 0.5) * 0.8;
            let lon = -118.0 - rng.f64() * 0.6;
            let alt = rng.f64() * 480.0;
            format!("EXTERMINAL LINK {lat:.6},{lon:.6} ALT {alt:.1}m")
        }
    }
}

// ── idle-flash variant of displacement slices ─────────────────────────

impl GlitchLayer {
    fn draw_idle_slices(&self, rng: &mut Lcg) {
        let count = rng.pick(4) + 1;  // 1–4 slices (slightly fewer than transitions)
        for _ in 0..count {
            let y = rng.range(0.0, self.h);

            let h = {
                let r = rng.f64();
                if r < 0.45      { rng.range(1.0, 5.0) }
                else if r < 0.75 { rng.range(5.0, 22.0) }
                else             { rng.range(22.0, 90.0) }
            }.min(self.h - y);

            let sign = if rng.chance(0.5) { 1.0_f64 } else { -1.0_f64 };
            let dx   = sign * rng.range(self.w * 0.05, self.w * 0.26);

            let (r, g, b) = rand_pal_warm(rng);
            self.ctx.set_fill_style(&rgba(r, g, b, rng.range(0.28, 0.76)));
            self.ctx.fill_rect(dx, y, self.w, h);

            if rng.chance(0.68) {
                let cut_x = (if dx > 0.0 { dx } else { self.w + dx }).clamp(0.0, self.w - 1.0);
                let (cr, cg, cb) = rand_pal_warm(rng);
                self.ctx.set_fill_style(&rgba(cr, cg, cb, rng.range(0.55, 1.0)));
                self.ctx.fill_rect(cut_x, y, 1.5, h);
            }
        }
    }
}

// ── helpers ───────────────────────────────────────────────────────────

fn envelope(t: f64) -> f64 {
    // Symmetric triangle: linear ramp up to peak at t=0.5, linear ramp back to 0.
    if t < 0.5 { t * 2.0 } else { 2.0 - t * 2.0 }
}

fn make_ghost(src: &str, rng: &mut Lcg, chars: &[char]) -> String {
    src.chars().map(|c| {
        if c.is_whitespace() { c } else { chars[rng.pick(chars.len())] }
    }).collect()
}

// Interpolate between two random warm PAL entries (indices 0–4: reds and oranges).
// Gives continuous colour variety within the existing palette tonal range.
fn rand_pal_warm(rng: &mut Lcg) -> (u8, u8, u8) {
    let (r1, g1, b1) = PAL[rng.pick(5)];
    let (r2, g2, b2) = PAL[rng.pick(5)];
    let t = rng.f64();
    (
        (r1 as f64 + (r2 as f64 - r1 as f64) * t) as u8,
        (g1 as f64 + (g2 as f64 - g1 as f64) * t) as u8,
        (b1 as f64 + (b2 as f64 - b1 as f64) * t) as u8,
    )
}

fn rgba(r: u8, g: u8, b: u8, a: f64) -> JsValue {
    JsValue::from_str(&format!("rgba({r},{g},{b},{:.3})", a.clamp(0.0, 1.0)))
}

fn perf_now() -> f64 {
    web_sys::window()
        .and_then(|w| w.performance())
        .map(|p| p.now())
        .unwrap_or(0.0)
}
