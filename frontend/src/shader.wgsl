struct Camera {
    view_proj: mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> camera: Camera;

struct VertIn {
    @location(0) pos: vec3<f32>,
    @location(1) col: vec3<f32>,
}

struct VertOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) col: vec3<f32>,
}

@vertex
fn vs_main(v: VertIn) -> VertOut {
    var out: VertOut;
    out.clip_pos = camera.view_proj * vec4<f32>(v.pos, 1.0);
    out.col = v.col;
    return out;
}

@fragment
fn fs_main(v: VertOut) -> @location(0) vec4<f32> {
    return vec4<f32>(v.col, 1.0);
}
