// G-buffer scene pass — outputs lit color (loc 0) + encoded normal+depth (loc 1)

struct Scene {
    view_proj:   mat4x4<f32>,
    view:        mat4x4<f32>,
    proj:        mat4x4<f32>,
    eye:         vec3<f32>, _p0: f32,
    cam_right:   vec3<f32>, _p1: f32,
    cam_up:      vec3<f32>, _p2: f32,
    ambient:     vec3<f32>, _p3: f32,
    sun_dir:     vec3<f32>, _p4: f32,
    sun_color:   vec3<f32>, _p5: f32,
    pt_pos:      vec3<f32>, _p6: f32,
    pt_color:    vec3<f32>, _p7: f32,
    proj_x:      f32, proj_y: f32, znear: f32, zfar: f32,
    screen_w:    f32, screen_h: f32, ssao_radius: f32, ssao_strength: f32,
}
@group(0) @binding(0) var<uniform> scene: Scene;

// Per-material textures — swapped per draw call when a GLB is loaded.
// Default bind group uses 1×1 white albedo + 1×1 flat normal (128,128,255).
@group(1) @binding(0) var albedo_tex:  texture_2d<f32>;
@group(1) @binding(1) var albedo_samp: sampler;
@group(1) @binding(2) var normal_tex:  texture_2d<f32>;
@group(1) @binding(3) var normal_samp: sampler;

struct VertIn {
    @location(0) pos:     vec3<f32>,
    @location(1) normal:  vec3<f32>,
    @location(2) tangent: vec4<f32>,  // xyz = tangent, w = bitangent sign; [0;4] for procedural
    @location(3) color:   vec3<f32>,  // vertex color (block tint for procedural, [1,1,1] for GLB)
    @location(4) uv:      vec2<f32>,
}

struct VertOut {
    @builtin(position) clip_pos:      vec4<f32>,
    @location(0)       world_pos:     vec3<f32>,
    @location(1)       world_normal:  vec3<f32>,
    @location(2)       view_normal:   vec3<f32>,
    @location(3)       color:         vec3<f32>,
    @location(4)       uv:            vec2<f32>,
    @location(5)       linear_z:      f32,
    @location(6)       world_tangent: vec4<f32>,
}

struct FragOut {
    @location(0) color: vec4<f32>,
    @location(1) nd:    vec4<f32>, // RG=depth16, B=view_nx, A=view_ny
}

@vertex
fn vs_main(v: VertIn) -> VertOut {
    var o: VertOut;
    let view_pos    = scene.view * vec4<f32>(v.pos, 1.0);
    o.clip_pos      = scene.proj * view_pos;
    o.world_pos     = v.pos;
    o.world_normal  = v.normal;
    o.view_normal   = normalize((scene.view * vec4<f32>(v.normal, 0.0)).xyz);
    o.color         = v.color;
    o.uv            = v.uv;
    o.linear_z      = -view_pos.z;
    o.world_tangent = v.tangent;  // already in world space (no separate model matrix)
    return o;
}

@fragment
fn fs_main(v: VertOut) -> FragOut {
    let N = normalize(v.world_normal);
    let V = normalize(scene.eye - v.world_pos);

    // TBN normal mapping — skipped for procedural geometry (tangent.xyz == 0).
    var shading_N = N;
    if dot(v.world_tangent.xyz, v.world_tangent.xyz) > 0.01 {
        let T  = normalize(v.world_tangent.xyz);
        let B  = cross(N, T) * v.world_tangent.w;
        let nm = textureSample(normal_tex, normal_samp, v.uv).xyz * 2.0 - 1.0;
        shading_N = normalize(T * nm.x + B * nm.y + N * nm.z);
    }

    // Albedo: texture × vertex color.
    //   • GLB meshes:        color=[1,1,1], albedo_tex=Blender texture  → albedo = texture
    //   • Procedural meshes: color=block_color, albedo_tex=1×1 white   → albedo = block_color
    let albedo = textureSample(albedo_tex, albedo_samp, v.uv).rgb * v.color;

    // Phong lighting
    let amb = albedo * scene.ambient;

    let sun_diff = max(dot(shading_N, normalize(scene.sun_dir)), 0.0);
    let sun = albedo * scene.sun_color * sun_diff;

    let L    = normalize(scene.pt_pos - v.world_pos);
    let dist = length(scene.pt_pos - v.world_pos);
    let attn = 1.0 / (1.0 + 0.1 * dist + 0.03 * dist * dist);
    let H    = normalize(L + V);
    let diff = max(dot(shading_N, L), 0.0);
    let spec = pow(max(dot(shading_N, H), 0.0), 64.0);
    let pt   = (albedo * scene.pt_color * diff + scene.pt_color * spec * 0.4) * attn;

    let lit = amb + sun + pt;

    // Encode depth into RG (16-bit fixed-point)
    let d   = clamp(v.linear_z / scene.zfar, 0.0, 1.0);
    let d_r = floor(d * 255.0) / 255.0;
    let d_g = fract(d * 255.0);

    // Encode view-space normal XY into BA
    let vn = normalize(v.view_normal);

    var o: FragOut;
    o.color = vec4<f32>(lit, 1.0);
    o.nd    = vec4<f32>(d_r, d_g, vn.x * 0.5 + 0.5, vn.y * 0.5 + 0.5);
    return o;
}
