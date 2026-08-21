// Particle pass — CPU-expanded billboards, additive blend over composite output

struct Scene {
    view_proj: mat4x4<f32>,
    // (rest of uniform unused here but buffer must exist)
}
@group(0) @binding(0) var<uniform> scene: Scene;

struct VertIn {
    @location(0) pos:   vec3<f32>,
    @location(1) color: vec4<f32>, // RGBA, A = alpha for additive fade
}

struct VertOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0)       color:    vec4<f32>,
}

@vertex
fn vs_main(v: VertIn) -> VertOut {
    var o: VertOut;
    o.clip_pos = scene.view_proj * vec4<f32>(v.pos, 1.0);
    o.color    = v.color;
    return o;
}

@fragment
fn fs_main(v: VertOut) -> @location(0) vec4<f32> {
    return v.color;
}
