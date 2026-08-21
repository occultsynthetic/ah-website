// SSAO pass — reads G-buffer normal+depth, outputs occlusion in R channel

struct Scene {
    view_proj:  mat4x4<f32>,
    view:       mat4x4<f32>,
    proj:       mat4x4<f32>,
    eye:        vec3<f32>, _p0: f32,
    cam_right:  vec3<f32>, _p1: f32,
    cam_up:     vec3<f32>, _p2: f32,
    ambient:    vec3<f32>, _p3: f32,
    sun_dir:    vec3<f32>, _p4: f32,
    sun_color:  vec3<f32>, _p5: f32,
    pt_pos:     vec3<f32>, _p6: f32,
    pt_color:   vec3<f32>, _p7: f32,
    proj_x:     f32, proj_y: f32, znear: f32, zfar: f32,
    screen_w:   f32, screen_h: f32, ssao_radius: f32, ssao_strength: f32,
}
@group(0) @binding(0) var<uniform> scene: Scene;

struct SsaoKernel {
    samples: array<vec4<f32>, 32>,
}
@group(1) @binding(0) var nd_tex:    texture_2d<f32>; // G-buffer normal+depth
@group(1) @binding(1) var nd_samp:   sampler;
@group(1) @binding(2) var noise_tex: texture_2d<f32>; // 4×4 random rotations
@group(1) @binding(3) var noise_samp:sampler;
@group(1) @binding(4) var<uniform>   kernel: SsaoKernel;

struct VertOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertOut {
    // Fullscreen triangle — pure arithmetic, no arrays (GLSL ES 3.0 safe)
    let x = f32(idx / 2u) * 4.0 - 1.0;
    let y = f32(idx & 1u) * 4.0 - 1.0;
    var o: VertOut;
    o.clip_pos = vec4<f32>(x, y, 0.0, 1.0);
    o.uv       = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return o;
}

// Decode the 16-bit depth packed in RG channels → linear view-space depth
fn decode_depth(rg: vec2<f32>) -> f32 {
    return (rg.x + rg.y / 255.0) * scene.zfar;
}

// Reconstruct view-space position from UV and linear depth
fn view_pos(uv: vec2<f32>, z: f32) -> vec3<f32> {
    let ndc_x =  uv.x * 2.0 - 1.0;
    let ndc_y = -uv.y * 2.0 + 1.0; // flip Y: UV top-left → NDC top is +1
    return vec3<f32>(ndc_x * z / scene.proj_x,
                     ndc_y * z / scene.proj_y,
                     -z);
}

@fragment
fn fs_main(v: VertOut) -> @location(0) vec4<f32> {
    let nd = textureSample(nd_tex, nd_samp, v.uv);
    let depth = decode_depth(nd.xy);

    // Nothing at this pixel (background / clear)
    if (depth < scene.znear + 0.01) {
        return vec4<f32>(1.0, 1.0, 1.0, 1.0);
    }

    // Reconstruct view-space normal from BA
    let nx  = nd.z * 2.0 - 1.0;
    let ny  = nd.w * 2.0 - 1.0;
    let nz  = sqrt(max(1.0 - nx * nx - ny * ny, 0.0));
    let N   = normalize(vec3<f32>(nx, ny, nz));

    let frag_pos = view_pos(v.uv, depth);

    // Random rotation vector from tiled 4×4 noise texture
    let noise_scale = vec2<f32>(scene.screen_w, scene.screen_h) / 4.0;
    let noise_uv    = v.uv * noise_scale;
    let rand_xy     = textureSample(noise_tex, noise_samp, noise_uv).xy * 2.0 - 1.0;
    let rand_v      = normalize(vec3<f32>(rand_xy, 0.0));

    // Gram-Schmidt TBN — orient hemisphere to surface normal
    let T   = normalize(rand_v - N * dot(rand_v, N));
    let B   = cross(N, T);
    let tbn = mat3x3<f32>(T, B, N);

    var occ = 0.0;
    let radius = scene.ssao_radius;
    let bias   = 0.025;

    for (var i = 0u; i < 32u; i++) {
        let s_view = frag_pos + tbn * kernel.samples[i].xyz * radius;

        // Project sample to screen
        let s_clip = scene.proj * vec4<f32>(s_view, 1.0);
        var s_uv   = (s_clip.xy / s_clip.w) * 0.5 + 0.5;
        s_uv.y     = 1.0 - s_uv.y; // flip Y back to UV space

        // Bounds check
        if (any(s_uv < vec2<f32>(0.0)) || any(s_uv > vec2<f32>(1.0))) {
            continue;
        }

        let s_nd    = textureSample(nd_tex, nd_samp, s_uv);
        let s_depth = decode_depth(s_nd.xy);

        // Range check prevents large-depth-difference false occlusion
        let range_check = smoothstep(0.0, 1.0, radius / abs(depth - s_depth));
        // Sample occludes if it sits between frag_pos and camera
        occ += select(0.0, 1.0, s_depth <= -s_view.z + bias) * range_check;
    }

    let ao = 1.0 - (occ / 32.0) * scene.ssao_strength;
    return vec4<f32>(ao, ao, ao, 1.0);
}
