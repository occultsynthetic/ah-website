// Phosphor-persistence pass.
// Reads the freshly-composited frame (curr_tex) and the previous accumulated
// frame (accum_tex), blends them, then outputs the same blended value to two
// render targets simultaneously:
//   @location(0) → accum_tex[pong]  (stored for next frame)
//   @location(1) → swapchain surface (shown on screen)
//
// BLEND controls the fraction of the previous frame that "bleeds" into the
// current frame.  0.0 = no persistence, 1.0 = image frozen.  0.18 gives a
// subtle 2-frame tail that reads as phosphor afterglow at 60 fps.

@group(0) @binding(0) var curr_tex:  texture_2d<f32>;
@group(0) @binding(1) var curr_samp: sampler;
@group(0) @binding(2) var accum_tex: texture_2d<f32>;
@group(0) @binding(3) var accum_samp: sampler;

const BLEND: f32 = 0.48;

struct VertOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
}

struct PersistOut {
    @location(0) to_accum:  vec4<f32>,
    @location(1) to_screen: vec4<f32>,
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
fn fs_main(v: VertOut) -> PersistOut {
    let curr    = textureSample(curr_tex, curr_samp, v.uv).rgb;
    let prev    = textureSample(accum_tex, accum_samp, v.uv).rgb;
    let blended = clamp(mix(curr, prev, BLEND), vec3<f32>(0.0), vec3<f32>(1.0));
    let out     = vec4<f32>(blended, 1.0);
    return PersistOut(out, out);
}
