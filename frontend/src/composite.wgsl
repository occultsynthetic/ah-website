// Composite pass:
//   1. Pixelate UVs
//   2. Pixel-sort columns (bright floats up, dark sinks down)
//   3. Interlace field desync (even/odd rows offset laterally)
//   4. Chromatic aberration (R/B channel separation)
//   5. SSAO multiply
//   6. Film grain (always on, pattern re-seeds each frame via time)

@group(0) @binding(0) var color_tex:  texture_2d<f32>;
@group(0) @binding(1) var color_samp: sampler;
@group(0) @binding(2) var ssao_tex:   texture_2d<f32>;
@group(0) @binding(3) var ssao_samp:  sampler;

struct Glitch {
    pixel_size:    f32,
    chroma_str:    f32,
    interlace_str: f32,
    sort_amount:   f32,
    time:          f32,  // seconds since page load
    grain_str:     f32,  // film grain intensity
    sort_y0:       f32,  // UV y-start of displacement band
    sort_y1:       f32,  // UV y-end   of displacement band
}
@group(0) @binding(4) var<uniform> glitch: Glitch;

struct VertOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertOut {
    let x = f32(idx / 2u) * 4.0 - 1.0;
    let y = f32(idx & 1u) * 4.0 - 1.0;
    var o: VertOut;
    o.clip_pos = vec4<f32>(x, y, 0.0, 1.0);
    o.uv       = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return o;
}

@fragment
fn fs_main(v: VertOut) -> @location(0) vec4<f32> {
    let dims   = textureDimensions(color_tex);
    let screen = vec2<f32>(f32(dims.x), f32(dims.y));

    // ── 1. Pixelate ───────────────────────────────────────────────────
    let ps     = max(1.0, glitch.pixel_size);
    let pix_uv = (floor(v.uv * screen / ps) * ps + 0.5) / screen;

    // ── 2. Pixel sort ─────────────────────────────────────────────────
    var sort_uv = pix_uv;
    let sa = glitch.sort_amount;
    if sa > 0.01 && pix_uv.y >= glitch.sort_y0 && pix_uv.y <= glitch.sort_y1 {
        let strip    = floor(pix_uv.x * 40.0);
        let col_hash = fract(sin(strip * 127.3 + 19.47) * 43758.5453);
        if col_hash < sa * 0.70 {
            let pre  = textureSample(color_tex, color_samp, pix_uv).rgb;
            let lum  = dot(pre, vec3<f32>(0.299, 0.587, 0.114));
            let bias = (lum - 0.5) * sa * 0.38;
            sort_uv  = vec2<f32>(pix_uv.x, clamp(pix_uv.y - bias, 0.0, 1.0));
        }
    }

    // ── 3. Interlace field desync ─────────────────────────────────────
    let row    = u32(v.clip_pos.y);
    let il_sgn = select(-1.0, 1.0, (row & 1u) == 0u);
    let il_uv  = sort_uv + vec2<f32>(glitch.interlace_str * il_sgn, 0.0);

    // ── 4. Chromatic aberration ───────────────────────────────────────
    let ca = glitch.chroma_str;
    let r  = textureSample(color_tex, color_samp, il_uv + vec2<f32>( ca, 0.0)).r;
    let g  = textureSample(color_tex, color_samp, il_uv).g;
    let b  = textureSample(color_tex, color_samp, il_uv - vec2<f32>( ca, 0.0)).b;

    // ── 5. SSAO multiply ──────────────────────────────────────────────
    let ao  = textureSample(ssao_tex, ssao_samp, il_uv).r;
    let col = vec3<f32>(r, g, b) * ao;

    // ── 6. Film grain ─────────────────────────────────────────────────
    // Two irrational-period offsets keep the pattern unique every frame.
    // All values stay in [0,1] to avoid f32 sin precision issues.
    let tp    = vec2<f32>(fract(glitch.time * 68.75), fract(glitch.time * 36.65));
    let gn    = fract(sin(dot(fract(v.uv + tp), vec2<f32>(127.1, 311.7))) * 43758.5453);
    let grain = (gn - 0.5) * glitch.grain_str;

    return vec4<f32>(clamp(col + grain, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
