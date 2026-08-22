use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use web_sys::HtmlCanvasElement;
use wgpu::{util::DeviceExt, *};

// ── vertex types ──────────────────────────────────────────────────────

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Vertex {
    pub pos:     [f32; 3],
    pub normal:  [f32; 3],
    pub tangent: [f32; 4],  // xyz + w=bitangent sign; [0;4] for procedural geometry
    pub color:   [f32; 3],
    pub uv:      [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ParticleVertex {
    pos:   [f32; 3],
    color: [f32; 4],
}

// ── uniforms (std140 layout — each vec3 has trailing f32 padding) ─────

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SceneUniform {
    view_proj:    [[f32; 4]; 4],
    view:         [[f32; 4]; 4],
    proj:         [[f32; 4]; 4],
    eye:          [f32; 3], _p0: f32,
    cam_right:    [f32; 3], _p1: f32,
    cam_up:       [f32; 3], _p2: f32,
    ambient:      [f32; 3], _p3: f32,
    sun_dir:      [f32; 3], _p4: f32,
    sun_color:    [f32; 3], _p5: f32,
    pt_pos:       [f32; 3], _p6: f32,
    pt_color:     [f32; 3], _p7: f32,
    proj_x:       f32, proj_y: f32, znear: f32, zfar: f32,
    screen_w:     f32, screen_h: f32, ssao_radius: f32, ssao_strength: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GlitchUniform {
    pixel_size:    f32,
    chroma_str:    f32,
    interlace_str: f32,
    sort_amount:   f32,
    time:          f32,  // seconds since page load — drives grain pattern per frame
    grain_str:     f32,  // grain intensity (always on)
    sort_y0:       f32,  // UV y-start of displacement band (0 = top of screen)
    sort_y1:       f32,  // UV y-end   of displacement band (1 = bottom of screen)
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SsaoKernel {
    samples: [[f32; 4]; 32],
}

// ── pipeline constants ────────────────────────────────────────────────

const GRID:    usize = 9;
const SPACING: f32   = 1.7;
const BW:      f32   = 1.4;
const BD:      f32   = 1.4;
const ZNEAR:   f32   = 0.1;
const ZFAR:    f32   = 150.0;
const FOVY:    f32   = std::f32::consts::FRAC_PI_3;
const MAX_P:   usize = 140;

const SECTORS: [([f32; 3], [f32; 3]); 4] = [
    ([0.0,  7.0, 16.0], [0.0, 1.5, 0.0]),
    ([16.0, 9.0,  4.0], [0.0, 2.0, 0.0]),
    ([-6.0, 3.0, 11.0], [0.0, 0.5, 0.0]),
    ([0.0, 18.0,  4.0], [0.0, 0.0, 0.0]),
];

const VERT_ATTRS: [VertexAttribute; 5] = vertex_attr_array![
    0 => Float32x3,  // pos
    1 => Float32x3,  // normal
    2 => Float32x4,  // tangent (xyz + w=bitangent sign)
    3 => Float32x3,  // color
    4 => Float32x2,  // uv
];

const PARTICLE_ATTRS: [VertexAttribute; 2] = vertex_attr_array![
    0 => Float32x3,
    1 => Float32x4,
];

// ── RNG (LCG — no deps) ───────────────────────────────────────────────

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self { Self(seed) }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0
    }
    fn f32(&mut self) -> f32 { (self.next() >> 33) as f32 / u32::MAX as f32 }
    fn range(&mut self, lo: f32, hi: f32) -> f32 { lo + self.f32() * (hi - lo) }
}

// ── procedural megastructure geometry ────────────────────────────────

fn block_height(ix: usize, iz: usize) -> f32 {
    let (x, z) = (ix as f32, iz as f32);
    let a = ((x * 1.4 + 0.7).sin() * (z * 0.8 + 1.1).cos()).abs();
    let b = ((x * 0.5 + z * 0.6 + 1.3).sin()).abs();
    let c = ((x * 0.3).sin() * (z * 0.3).sin()).abs();
    (a * 3.0 + b * 2.0 + c * 1.5 + 0.3).max(0.3)
}

fn block_color(ix: usize, iz: usize, h: f32) -> [f32; 3] {
    let v = 0.09 + h * 0.05;
    let r = v * (0.78 + 0.16 * ((ix as f32) * 0.9).sin().abs());
    let g = v * (0.82 + 0.14 * ((iz as f32) * 0.7).sin().abs());
    let b = v * (0.96 + 0.14 * (((ix + iz) as f32) * 0.4).cos().abs());
    [r, g, b]
}

fn push_face(verts: &mut Vec<Vertex>, idxs: &mut Vec<u32>,
             corners: [[f32; 3]; 4], normal: [f32; 3], color: [f32; 3]) {
    let base = verts.len() as u32;
    let uvs = [[0.0f32, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    for (i, c) in corners.iter().enumerate() {
        verts.push(Vertex { pos: *c, normal, tangent: [0.0; 4], color, uv: uvs[i] });
    }
    idxs.extend_from_slice(&[base, base+1, base+2, base, base+2, base+3]);
}

fn push_box(verts: &mut Vec<Vertex>, idxs: &mut Vec<u32>,
            cx: f32, y0: f32, cz: f32, w: f32, h: f32, d: f32, color: [f32; 3]) {
    let (x0, x1) = (cx - w/2.0, cx + w/2.0);
    let (z0, z1) = (cz - d/2.0, cz + d/2.0);
    let y1 = y0 + h;
    // CCW winding for FrontFace::Ccw (normals verified by cross-product)
    push_face(verts, idxs, [[x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]], [0.,1.,0.], color); // +Y
    push_face(verts, idxs, [[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]], [1.,0.,0.], color); // +X
    push_face(verts, idxs, [[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],[x0,y0,z0]], [-1.,0.,0.], color); // -X
    push_face(verts, idxs, [[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],[x0,y0,z1]], [0.,0.,1.], color); // +Z
    push_face(verts, idxs, [[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0]], [0.,0.,-1.], color); // -Z
}

fn generate_scene() -> (Vec<Vertex>, Vec<u32>) {
    let mut verts = Vec::new();
    let mut idxs  = Vec::new();
    let offset = (GRID as f32 - 1.0) * SPACING * 0.5;
    for ix in 0..GRID {
        for iz in 0..GRID {
            let cx = ix as f32 * SPACING - offset;
            let cz = iz as f32 * SPACING - offset;
            let h  = block_height(ix, iz);
            push_box(&mut verts, &mut idxs, cx, 0.0, cz, BW, h, BD, block_color(ix, iz, h));
        }
    }
    (verts, idxs)
}

// ── SSAO kernel + noise ───────────────────────────────────────────────

fn gen_ssao_kernel() -> SsaoKernel {
    let mut rng = Rng::new(42);
    let mut k = SsaoKernel { samples: [[0f32; 4]; 32] };
    for i in 0..32 {
        let scale = (i as f32 / 32.0).powi(2);
        let scale = 0.1 + scale * 0.9;
        let x = rng.range(-1.0, 1.0);
        let y = rng.range(-1.0, 1.0);
        let z = rng.f32(); // hemisphere: z ∈ [0,1]
        let v = Vec3::new(x, y, z).normalize() * rng.f32() * scale;
        k.samples[i] = [v.x, v.y, v.z, 0.0];
    }
    k
}

fn gen_noise_pixels() -> Vec<u8> {
    let mut rng = Rng::new(777);
    let mut px = Vec::with_capacity(64);
    for _ in 0..16 {
        let a = rng.f32() * std::f32::consts::TAU;
        let x = ((a.cos() * 0.5 + 0.5) * 255.0) as u8;
        let y = ((a.sin() * 0.5 + 0.5) * 255.0) as u8;
        px.extend_from_slice(&[x, y, 128u8, 255u8]);
    }
    px
}

// ── particles ─────────────────────────────────────────────────────────

struct Particle { pos: [f32; 3], vel: [f32; 3], life: f32, size: f32 }

struct ParticleSystem { ps: Vec<Particle>, rng: Rng, verts: Vec<ParticleVertex> }

impl ParticleSystem {
    fn new(rng: Rng) -> Self {
        let mut s = Self { ps: Vec::new(), rng, verts: Vec::with_capacity(MAX_P * 6) };
        for _ in 0..MAX_P { s.spawn(); }
        s
    }

    fn spawn(&mut self) {
        let x = self.rng.range(-8.0, 8.0);
        let z = self.rng.range(-8.0, 8.0);
        self.ps.push(Particle {
            pos:  [x, self.rng.range(0.0, 1.5), z],
            vel:  [self.rng.range(-0.03,0.03), self.rng.range(0.1,0.5), self.rng.range(-0.03,0.03)],
            life: self.rng.f32(),
            size: self.rng.range(0.02, 0.065),
        });
    }

    fn update(&mut self) {
        const DT: f32 = 1.0 / 60.0;
        for p in &mut self.ps {
            p.pos[0] += p.vel[0] * DT;
            p.pos[1] += p.vel[1] * DT;
            p.pos[2] += p.vel[2] * DT;
            p.life   -= DT * 0.16;
        }
        self.ps.retain(|p| p.life > 0.0);
        while self.ps.len() < MAX_P { self.spawn(); }
    }

    // Refills the persistent `verts` buffer in place instead of allocating a
    // fresh Vec every frame (this runs once per rendered frame).
    fn update_verts(&mut self, right: Vec3, up: Vec3) {
        const QUAD: [(f32, f32); 6] = [
            (-0.5,-0.5),(0.5,-0.5),(0.5,0.5),(-0.5,-0.5),(0.5,0.5),(-0.5,0.5)
        ];
        self.verts.clear();
        for p in &self.ps {
            let c  = Vec3::from_array(p.pos);
            let a  = (p.life * 2.0).min(1.0);
            let col = [0.3 * a, 0.5 * a, 0.4 * a, a * 0.55];
            for (ox, oy) in QUAD {
                let world = c + right * (ox * p.size) + up * (oy * p.size);
                self.verts.push(ParticleVertex { pos: world.to_array(), color: col });
            }
        }
    }
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]
}

// ── texture helpers ────────────────────────────────────────────────────

fn upload_rgba8(device: &Device, queue: &Queue, pixels: &[u8], w: u32, h: u32) -> (Texture, TextureView) {
    let (tex, view) = mk_tex(device, w, h, TextureFormat::Rgba8Unorm,
        TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST);
    queue.write_texture(
        ImageCopyTexture { texture: &tex, mip_level: 0, origin: Origin3d::ZERO, aspect: TextureAspect::All },
        pixels,
        ImageDataLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: None },
        Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    (tex, view)
}

fn mk_tex(device: &Device, w: u32, h: u32, fmt: TextureFormat, usage: TextureUsages) -> (Texture, TextureView) {
    let tex = device.create_texture(&TextureDescriptor {
        label: None,
        size: Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: fmt,
        usage,
        view_formats: &[],
    });
    let view = tex.create_view(&TextureViewDescriptor::default());
    (tex, view)
}

fn nearest_sampler(device: &Device) -> Sampler {
    device.create_sampler(&SamplerDescriptor {
        mag_filter:    FilterMode::Nearest,
        min_filter:    FilterMode::Nearest,
        address_mode_u: AddressMode::Repeat,
        address_mode_v: AddressMode::Repeat,
        ..Default::default()
    })
}

fn linear_sampler(device: &Device) -> Sampler {
    device.create_sampler(&SamplerDescriptor {
        mag_filter:    FilterMode::Linear,
        min_filter:    FilterMode::Linear,
        address_mode_u: AddressMode::ClampToEdge,
        address_mode_v: AddressMode::ClampToEdge,
        ..Default::default()
    })
}

// ── renderer ──────────────────────────────────────────────────────────

pub struct Renderer {
    surface:          Surface<'static>,
    device:           Device,
    queue:            Queue,
    config:           SurfaceConfiguration,

    // G-buffer textures
    gb_color_tex:     Texture,
    gb_color_view:    TextureView,
    gb_nd_tex:        Texture,    // normal+depth
    gb_nd_view:       TextureView,
    depth_tex:        Texture,
    depth_view:       TextureView,

    // SSAO textures
    ssao_tex:         Texture,
    ssao_view:        TextureView,
    noise_tex:        Texture,
    noise_view:       TextureView,

    // samplers
    nearest:          Sampler,
    linear:           Sampler,

    // pipelines
    scene_pipeline:     RenderPipeline,
    ssao_pipeline:      RenderPipeline,
    composite_pipeline: RenderPipeline,
    particle_pipeline:  RenderPipeline,

    // bind group layouts
    scene_bgl:        BindGroupLayout,
    ssao_bgl:         BindGroupLayout,
    composite_bgl:    BindGroupLayout,

    // bind groups (some rebuilt on resize)
    scene_bg:         BindGroup,
    ssao_bg:          BindGroup,
    composite_bg:     BindGroup,

    material_bgl:        BindGroupLayout,
    default_material_bg: BindGroup,

    // buffers
    scene_uniform_buf: Buffer,
    ssao_kernel_buf:   Buffer,
    vertex_buf:        Buffer,
    index_buf:         Buffer,
    index_count:       u32,
    particle_buf:      Buffer,
    flat_normal_tex:   Texture,
    flat_normal_view:  TextureView,
    white_albedo_tex:  Texture,
    white_albedo_view: TextureView,
    glitch_buf:        Buffer,

    // loaded GLB material (None = use default_material_bg with procedural scene)
    loaded_material_bg:  Option<BindGroup>,
    loaded_albedo_tex:   Option<Texture>,
    loaded_albedo_view:  Option<TextureView>,
    loaded_normal_tex:   Option<Texture>,
    loaded_normal_view:  Option<TextureView>,

    // camera
    cam_eye:  [f32; 3],
    cam_look: [f32; 3],
    tgt_eye:  [f32; 3],
    tgt_look: [f32; 3],
    aspect:   f32,
    // view-space right/up axes, cached from update_uniform()'s view matrix
    // so render()'s particle billboarding doesn't recompute look_at_rh again
    cam_right: Vec3,
    cam_up:    Vec3,

    // Phosphor-persistence ping-pong
    composite_out_tex:  Texture,
    composite_out_view: TextureView,
    accum_a_tex:        Texture,
    accum_a_view:       TextureView,
    accum_b_tex:        Texture,
    accum_b_view:       TextureView,
    persistence_bgl:    BindGroupLayout,
    persist_bg_a:       BindGroup,   // reads accum_a, writes accum_b + screen
    persist_bg_b:       BindGroup,   // reads accum_b, writes accum_a + screen
    persistence_pipeline: RenderPipeline,

    particles: ParticleSystem,
    frame:     u64,
}

impl Renderer {
    pub async fn new(canvas: HtmlCanvasElement) -> Result<Self, String> {
        // Cap to the WebGL2 spec minimum max-texture-dimension so surface.configure
        // doesn't panic on GPUs that top out at 2048 (common on integrated/mobile).
        let max_dim = Limits::downlevel_webgl2_defaults().max_texture_dimension_2d;
        let w = canvas.width().max(1).min(max_dim);
        let h = canvas.height().max(1).min(max_dim);
        canvas.set_width(w);
        canvas.set_height(h);
        let aspect = w as f32 / h as f32;

        // Force WebGL2 backend — avoids Chrome WebGPU spec version mismatches.
        let instance = Instance::new(InstanceDescriptor {
            backends: Backends::GL,
            ..Default::default()
        });
        let surface  = instance.create_surface(SurfaceTarget::Canvas(canvas))
            .map_err(|e| e.to_string())?;

        let adapter = instance.request_adapter(&RequestAdapterOptions {
            power_preference: PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }).await.ok_or("no GPU adapter — WebGL2 not available")?;

        let (device, queue) = adapter.request_device(&DeviceDescriptor {
            required_limits: Limits::downlevel_webgl2_defaults(),
            ..Default::default()
        }, None).await.map_err(|e| e.to_string())?;

        let caps   = surface.get_capabilities(&adapter);
        let fmt    = caps.formats.iter().find(|f| f.is_srgb()).copied().unwrap_or(caps.formats[0]);
        let config = SurfaceConfiguration {
            usage: TextureUsages::RENDER_ATTACHMENT,
            format: fmt,
            width: w, height: h,
            present_mode: PresentMode::AutoVsync,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let att = TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING;

        let (gb_color_tex, gb_color_view) = mk_tex(&device, w, h, TextureFormat::Rgba8Unorm, att);
        let (gb_nd_tex, gb_nd_view)       = mk_tex(&device, w, h, TextureFormat::Rgba8Unorm, att);
        // SSAO is inherently low-frequency (it's a soft ambient darkening, not
        // a sharp-edged effect) — rendering it at half resolution and letting
        // the composite pass upsample with a linear sampler cuts the 32-tap
        // fragment shader's invocation count to ~1/4 with no visible loss.
        let (ssao_w, ssao_h) = (w.max(2) / 2, h.max(2) / 2);
        let (ssao_tex, ssao_view)         = mk_tex(&device, ssao_w, ssao_h, TextureFormat::Rgba8Unorm, att);
        let (composite_out_tex, composite_out_view) = mk_tex(&device, w, h, TextureFormat::Rgba8Unorm, att);
        let (accum_a_tex, accum_a_view)   = mk_tex(&device, w, h, TextureFormat::Rgba8Unorm, att);
        let (accum_b_tex, accum_b_view)   = mk_tex(&device, w, h, TextureFormat::Rgba8Unorm, att);
        let (depth_tex, depth_view)       = mk_tex(&device, w, h, TextureFormat::Depth24Plus,
            TextureUsages::RENDER_ATTACHMENT);

        // 4×4 noise texture (SSAO rotation vectors)
        let noise_px = gen_noise_pixels();
        let (noise_tex, noise_view) = {
            let t = device.create_texture(&TextureDescriptor {
                label: None,
                size: Extent3d { width: 4, height: 4, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
                view_formats: &[],
            });
            queue.write_texture(
                ImageCopyTexture { texture: &t, mip_level: 0, origin: Origin3d::ZERO, aspect: TextureAspect::All },
                &noise_px,
                ImageDataLayout { offset: 0, bytes_per_row: Some(16), rows_per_image: None },
                Extent3d { width: 4, height: 4, depth_or_array_layers: 1 },
            );
            let v = t.create_view(&TextureViewDescriptor::default());
            (t, v)
        };

        // 1×1 flat normal map placeholder (pointing straight up: 0.5, 0.5, 1.0)
        let flat_normal_data = [128u8, 128, 255, 255];
        let (flat_normal_tex, flat_normal_view) = {
            let t = device.create_texture(&TextureDescriptor {
                label: None,
                size: Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
                view_formats: &[],
            });
            queue.write_texture(
                ImageCopyTexture { texture: &t, mip_level: 0, origin: Origin3d::ZERO, aspect: TextureAspect::All },
                &flat_normal_data,
                ImageDataLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: None },
                Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            );
            let v = t.create_view(&TextureViewDescriptor::default());
            (t, v)
        };

        // 1×1 white albedo fallback (used by procedural scene via default_material_bg)
        let white_albedo_data = [255u8, 255, 255, 255];
        let (white_albedo_tex, white_albedo_view) = {
            let t = device.create_texture(&TextureDescriptor {
                label: None,
                size: Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
                view_formats: &[],
            });
            queue.write_texture(
                ImageCopyTexture { texture: &t, mip_level: 0, origin: Origin3d::ZERO, aspect: TextureAspect::All },
                &white_albedo_data,
                ImageDataLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: None },
                Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            );
            let v = t.create_view(&TextureViewDescriptor::default());
            (t, v)
        };

        let nearest = nearest_sampler(&device);
        let linear  = linear_sampler(&device);

        // ── bind group layouts ──────────────────────────────────────

        // Group 0: scene uniform only (shared by scene, ssao, and particle passes)
        let scene_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                BindGroupLayoutEntry {
                    binding: 0, visibility: ShaderStages::VERTEX_FRAGMENT,
                    ty: BindingType::Buffer { ty: BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
            ],
        });

        // Group 1: per-material textures (albedo + normal map)
        let material_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                BindGroupLayoutEntry {
                    binding: 0, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture { sample_type: TextureSampleType::Float { filterable: true }, view_dimension: TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 1, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering),
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 2, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture { sample_type: TextureSampleType::Float { filterable: true }, view_dimension: TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 3, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let ssao_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                BindGroupLayoutEntry { binding: 0, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture { sample_type: TextureSampleType::Float { filterable: true }, view_dimension: TextureViewDimension::D2, multisampled: false }, count: None },
                BindGroupLayoutEntry { binding: 1, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering), count: None },
                BindGroupLayoutEntry { binding: 2, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture { sample_type: TextureSampleType::Float { filterable: true }, view_dimension: TextureViewDimension::D2, multisampled: false }, count: None },
                BindGroupLayoutEntry { binding: 3, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering), count: None },
                BindGroupLayoutEntry { binding: 4, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Buffer { ty: BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
            ],
        });

        let persistence_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                BindGroupLayoutEntry { binding: 0, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture { sample_type: TextureSampleType::Float { filterable: true }, view_dimension: TextureViewDimension::D2, multisampled: false }, count: None },
                BindGroupLayoutEntry { binding: 1, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering), count: None },
                BindGroupLayoutEntry { binding: 2, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture { sample_type: TextureSampleType::Float { filterable: true }, view_dimension: TextureViewDimension::D2, multisampled: false }, count: None },
                BindGroupLayoutEntry { binding: 3, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering), count: None },
            ],
        });

        let composite_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                BindGroupLayoutEntry { binding: 0, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture { sample_type: TextureSampleType::Float { filterable: true }, view_dimension: TextureViewDimension::D2, multisampled: false }, count: None },
                BindGroupLayoutEntry { binding: 1, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering), count: None },
                BindGroupLayoutEntry { binding: 2, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture { sample_type: TextureSampleType::Float { filterable: true }, view_dimension: TextureViewDimension::D2, multisampled: false }, count: None },
                BindGroupLayoutEntry { binding: 3, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering), count: None },
                BindGroupLayoutEntry { binding: 4, visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Buffer { ty: BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
            ],
        });

        // ── buffers ─────────────────────────────────────────────────

        let init_uniform = SceneUniform::default_val(aspect, w, h);
        let scene_uniform_buf = device.create_buffer_init(&util::BufferInitDescriptor {
            label: Some("scene_uniform"),
            contents: bytemuck::cast_slice(&[init_uniform]),
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
        });

        let kernel = gen_ssao_kernel();
        let ssao_kernel_buf = device.create_buffer_init(&util::BufferInitDescriptor {
            label: Some("ssao_kernel"),
            contents: bytemuck::cast_slice(&[kernel]),
            usage: BufferUsages::UNIFORM,
        });

        let (scene_verts, scene_idxs) = generate_scene();
        let index_count = scene_idxs.len() as u32;

        let vertex_buf = device.create_buffer_init(&util::BufferInitDescriptor {
            label: Some("verts"),
            contents: bytemuck::cast_slice(&scene_verts),
            usage: BufferUsages::VERTEX,
        });
        let index_buf = device.create_buffer_init(&util::BufferInitDescriptor {
            label: Some("idxs"),
            contents: bytemuck::cast_slice(&scene_idxs),
            usage: BufferUsages::INDEX,
        });

        let particle_buf = device.create_buffer(&BufferDescriptor {
            label: Some("particles"),
            size: (MAX_P * 6 * std::mem::size_of::<ParticleVertex>()) as u64,
            usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let glitch_buf = device.create_buffer_init(&util::BufferInitDescriptor {
            label: Some("glitch"),
            contents: bytemuck::cast_slice(&[GlitchUniform {
                pixel_size:    1.0,
                chroma_str:    0.0,
                interlace_str: 0.0008,
                sort_amount:   0.0,
                time:          0.0,
                grain_str:     0.005,
                sort_y0:       0.0,
                sort_y1:       1.0,
            }]),
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
        });

        // ── bind groups ──────────────────────────────────────────────

        let scene_bg = device.create_bind_group(&BindGroupDescriptor {
            label: None, layout: &scene_bgl,
            entries: &[
                BindGroupEntry { binding: 0, resource: scene_uniform_buf.as_entire_binding() },
            ],
        });

        let default_material_bg = device.create_bind_group(&BindGroupDescriptor {
            label: None, layout: &material_bgl,
            entries: &[
                BindGroupEntry { binding: 0, resource: BindingResource::TextureView(&white_albedo_view) },
                BindGroupEntry { binding: 1, resource: BindingResource::Sampler(&linear) },
                BindGroupEntry { binding: 2, resource: BindingResource::TextureView(&flat_normal_view) },
                BindGroupEntry { binding: 3, resource: BindingResource::Sampler(&nearest) },
            ],
        });

        let ssao_bg = device.create_bind_group(&BindGroupDescriptor {
            label: None, layout: &ssao_bgl,
            entries: &[
                BindGroupEntry { binding: 0, resource: BindingResource::TextureView(&gb_nd_view) },
                BindGroupEntry { binding: 1, resource: BindingResource::Sampler(&linear) },
                BindGroupEntry { binding: 2, resource: BindingResource::TextureView(&noise_view) },
                BindGroupEntry { binding: 3, resource: BindingResource::Sampler(&nearest) },
                BindGroupEntry { binding: 4, resource: ssao_kernel_buf.as_entire_binding() },
            ],
        });

        let composite_bg = device.create_bind_group(&BindGroupDescriptor {
            label: None, layout: &composite_bgl,
            entries: &[
                BindGroupEntry { binding: 0, resource: BindingResource::TextureView(&gb_color_view) },
                BindGroupEntry { binding: 1, resource: BindingResource::Sampler(&nearest) },
                BindGroupEntry { binding: 2, resource: BindingResource::TextureView(&ssao_view) },
                // linear, not nearest: ssao_view is now half-resolution, and a
                // bilinear upsample keeps the (inherently soft) AO term from
                // showing blocky 2x2 texel edges at full composite resolution.
                BindGroupEntry { binding: 3, resource: BindingResource::Sampler(&linear) },
                BindGroupEntry { binding: 4, resource: glitch_buf.as_entire_binding() },
            ],
        });

        // persist_bg_a: reads accum_a as prev → caller writes to accum_b + screen
        let persist_bg_a = device.create_bind_group(&BindGroupDescriptor {
            label: None, layout: &persistence_bgl,
            entries: &[
                BindGroupEntry { binding: 0, resource: BindingResource::TextureView(&composite_out_view) },
                BindGroupEntry { binding: 1, resource: BindingResource::Sampler(&linear) },
                BindGroupEntry { binding: 2, resource: BindingResource::TextureView(&accum_a_view) },
                BindGroupEntry { binding: 3, resource: BindingResource::Sampler(&linear) },
            ],
        });
        // persist_bg_b: reads accum_b as prev → caller writes to accum_a + screen
        let persist_bg_b = device.create_bind_group(&BindGroupDescriptor {
            label: None, layout: &persistence_bgl,
            entries: &[
                BindGroupEntry { binding: 0, resource: BindingResource::TextureView(&composite_out_view) },
                BindGroupEntry { binding: 1, resource: BindingResource::Sampler(&linear) },
                BindGroupEntry { binding: 2, resource: BindingResource::TextureView(&accum_b_view) },
                BindGroupEntry { binding: 3, resource: BindingResource::Sampler(&linear) },
            ],
        });

        // ── pipelines ────────────────────────────────────────────────

        // Particle / SSAO passes only need the scene uniform (group 0).
        let scene_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[&scene_bgl], push_constant_ranges: &[],
        });
        // G-buffer scene pass also binds per-material textures (group 1).
        let scene_geo_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[&scene_bgl, &material_bgl], push_constant_ranges: &[],
        });
        let post_layout_scene_ssao = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[&scene_bgl, &ssao_bgl], push_constant_ranges: &[],
        });
        let post_layout_comp = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[&composite_bgl], push_constant_ranges: &[],
        });

        let scene_shader     = device.create_shader_module(include_wgsl!("scene.wgsl"));
        let ssao_shader      = device.create_shader_module(include_wgsl!("ssao.wgsl"));
        let composite_shader = device.create_shader_module(include_wgsl!("composite.wgsl"));
        let particle_shader  = device.create_shader_module(include_wgsl!("particle.wgsl"));

        let depth_state = DepthStencilState {
            format: TextureFormat::Depth24Plus,
            depth_write_enabled: true,
            depth_compare: CompareFunction::Less,
            stencil: StencilState::default(),
            bias: DepthBiasState::default(),
        };

        let scene_pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: None, layout: Some(&scene_geo_layout),
            vertex: VertexState {
                module: &scene_shader, entry_point: "vs_main",
                buffers: &[VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as BufferAddress,
                    step_mode: VertexStepMode::Vertex,
                    attributes: &VERT_ATTRS,
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(FragmentState {
                module: &scene_shader, entry_point: "fs_main",
                targets: &[
                    Some(ColorTargetState { format: TextureFormat::Rgba8Unorm, blend: Some(BlendState::REPLACE), write_mask: ColorWrites::ALL }),
                    Some(ColorTargetState { format: TextureFormat::Rgba8Unorm, blend: Some(BlendState::REPLACE), write_mask: ColorWrites::ALL }),
                ],
                compilation_options: Default::default(),
            }),
            primitive: PrimitiveState { front_face: FrontFace::Ccw, cull_mode: Some(Face::Back), ..Default::default() },
            depth_stencil: Some(depth_state.clone()),
            multisample: MultisampleState::default(),
            multiview: None, cache: None,
        });

        let ssao_pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: None, layout: Some(&post_layout_scene_ssao),
            vertex: VertexState {
                module: &ssao_shader, entry_point: "vs_main",
                buffers: &[], compilation_options: Default::default(),
            },
            fragment: Some(FragmentState {
                module: &ssao_shader, entry_point: "fs_main",
                targets: &[Some(ColorTargetState { format: TextureFormat::Rgba8Unorm, blend: Some(BlendState::REPLACE), write_mask: ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: PrimitiveState::default(),
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview: None, cache: None,
        });

        let composite_pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: None, layout: Some(&post_layout_comp),
            vertex: VertexState {
                module: &composite_shader, entry_point: "vs_main",
                buffers: &[], compilation_options: Default::default(),
            },
            fragment: Some(FragmentState {
                module: &composite_shader, entry_point: "fs_main",
                // Outputs to composite_out_tex (Rgba8Unorm), not the surface.
                // Persistence pass blits to screen in the next step.
                targets: &[Some(ColorTargetState { format: TextureFormat::Rgba8Unorm, blend: Some(BlendState::REPLACE), write_mask: ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: PrimitiveState::default(),
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview: None, cache: None,
        });

        let particle_pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: None, layout: Some(&scene_layout),
            vertex: VertexState {
                module: &particle_shader, entry_point: "vs_main",
                buffers: &[VertexBufferLayout {
                    array_stride: std::mem::size_of::<ParticleVertex>() as BufferAddress,
                    step_mode: VertexStepMode::Vertex,
                    attributes: &PARTICLE_ATTRS,
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(FragmentState {
                module: &particle_shader, entry_point: "fs_main",
                targets: &[Some(ColorTargetState {
                    format: TextureFormat::Rgba8Unorm,  // now blends onto composite_out_tex
                    blend: Some(BlendState { // additive
                        color: BlendComponent { src_factor: BlendFactor::SrcAlpha, dst_factor: BlendFactor::One, operation: BlendOperation::Add },
                        alpha: BlendComponent { src_factor: BlendFactor::One, dst_factor: BlendFactor::OneMinusSrcAlpha, operation: BlendOperation::Add },
                    }),
                    write_mask: ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: PrimitiveState::default(),
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview: None, cache: None,
        });

        let persist_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: None, bind_group_layouts: &[&persistence_bgl], push_constant_ranges: &[],
        });
        let persist_shader = device.create_shader_module(include_wgsl!("persist.wgsl"));
        let persistence_pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: None, layout: Some(&persist_layout),
            vertex: VertexState {
                module: &persist_shader, entry_point: "vs_main",
                buffers: &[], compilation_options: Default::default(),
            },
            fragment: Some(FragmentState {
                module: &persist_shader, entry_point: "fs_main",
                targets: &[
                    Some(ColorTargetState { format: TextureFormat::Rgba8Unorm, blend: Some(BlendState::REPLACE), write_mask: ColorWrites::ALL }),
                    Some(ColorTargetState { format: fmt,                       blend: Some(BlendState::REPLACE), write_mask: ColorWrites::ALL }),
                ],
                compilation_options: Default::default(),
            }),
            primitive: PrimitiveState::default(),
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview: None, cache: None,
        });

        let seed = web_sys::window().and_then(|w| w.performance()).map(|p| (p.now() * 1000.0) as u64).unwrap_or(1234);

        let (init_eye, init_look) = SECTORS[0];

        Ok(Self {
            surface, device, queue, config,
            gb_color_tex, gb_color_view, gb_nd_tex, gb_nd_view, depth_tex, depth_view,
            ssao_tex, ssao_view, noise_tex, noise_view, nearest, linear,
            scene_pipeline, ssao_pipeline, composite_pipeline, particle_pipeline,
            scene_bgl, ssao_bgl, composite_bgl,
            scene_bg, ssao_bg, composite_bg,
            material_bgl, default_material_bg,
            white_albedo_tex, white_albedo_view,
            scene_uniform_buf, ssao_kernel_buf,
            vertex_buf, index_buf, index_count,
            particle_buf,
            flat_normal_tex, flat_normal_view,
            glitch_buf,
            loaded_material_bg:  None,
            loaded_albedo_tex:   None,
            loaded_albedo_view:  None,
            loaded_normal_tex:   None,
            loaded_normal_view:  None,
            composite_out_tex, composite_out_view,
            accum_a_tex, accum_a_view,
            accum_b_tex, accum_b_view,
            persistence_bgl, persist_bg_a, persist_bg_b,
            persistence_pipeline,
            cam_eye: init_eye, cam_look: init_look,
            tgt_eye: init_eye, tgt_look: init_look,
            aspect,
            cam_right: Vec3::X, cam_up: Vec3::Y,
            particles: ParticleSystem::new(Rng::new(seed)),
            frame: 0,
        })
    }

    pub fn set_sector(&mut self, idx: usize) {
        let (eye, look) = SECTORS[idx.min(SECTORS.len() - 1)];
        self.tgt_eye  = eye;
        self.tgt_look = look;
    }

    pub fn set_glitch(&mut self, pixel_size: f32, chroma_str: f32, interlace_str: f32, sort_amount: f32, time: f32, sort_y0: f32, sort_y1: f32) {
        let data = GlitchUniform {
            pixel_size, chroma_str, interlace_str, sort_amount,
            time, grain_str: 0.05, sort_y0, sort_y1,
        };
        self.queue.write_buffer(&self.glitch_buf, 0, bytemuck::cast_slice(&[data]));
    }

    pub fn load_scene(&mut self, mesh: crate::scene_loader::MeshData) {
        self.vertex_buf = self.device.create_buffer_init(&util::BufferInitDescriptor {
            label: Some("glb_verts"),
            contents: bytemuck::cast_slice(&mesh.vertices),
            usage: BufferUsages::VERTEX,
        });
        self.index_buf = self.device.create_buffer_init(&util::BufferInitDescriptor {
            label: Some("glb_idxs"),
            contents: bytemuck::cast_slice(&mesh.indices),
            usage: BufferUsages::INDEX,
        });
        self.index_count = mesh.indices.len() as u32;

        // Upload albedo texture (or use 1×1 white fallback)
        if let Some((px, w, h)) = mesh.albedo_rgba8 {
            let (t, v) = upload_rgba8(&self.device, &self.queue, &px, w, h);
            self.loaded_albedo_tex  = Some(t);
            self.loaded_albedo_view = Some(v);
        }
        // Upload normal map texture (or use flat-normal fallback)
        if let Some((px, w, h)) = mesh.normal_rgba8 {
            let (t, v) = upload_rgba8(&self.device, &self.queue, &px, w, h);
            self.loaded_normal_tex  = Some(t);
            self.loaded_normal_view = Some(v);
        }

        let albedo_view = self.loaded_albedo_view.as_ref().unwrap_or(&self.white_albedo_view);
        let normal_view = self.loaded_normal_view.as_ref().unwrap_or(&self.flat_normal_view);

        self.loaded_material_bg = Some(self.device.create_bind_group(&BindGroupDescriptor {
            label: None, layout: &self.material_bgl,
            entries: &[
                BindGroupEntry { binding: 0, resource: BindingResource::TextureView(albedo_view) },
                BindGroupEntry { binding: 1, resource: BindingResource::Sampler(&self.linear) },
                BindGroupEntry { binding: 2, resource: BindingResource::TextureView(normal_view) },
                BindGroupEntry { binding: 3, resource: BindingResource::Sampler(&self.nearest) },
            ],
        }));
    }

    fn update_uniform(&mut self) {
        const SPD: f32 = 0.04;
        self.cam_eye  = lerp3(self.cam_eye,  self.tgt_eye,  SPD);
        self.cam_look = lerp3(self.cam_look, self.tgt_look, SPD);

        let t      = self.frame as f32 * 0.018;
        let pt_pos = [t.sin() * 7.5, 4.0 + t.cos() * 2.0, t.cos() * 7.5];

        let eye    = Vec3::from_array(self.cam_eye);
        let look   = Vec3::from_array(self.cam_look);
        let view   = Mat4::look_at_rh(eye, look, Vec3::Y);
        let proj   = Mat4::perspective_rh_gl(FOVY, self.aspect, ZNEAR, ZFAR);
        let vp     = proj * view;

        // Rows of view matrix rotation part = camera axes in world space (column-major)
        // Cached on self so render()'s particle billboarding can reuse them
        // instead of recomputing look_at_rh a second time this frame.
        self.cam_right = Vec3::new(view.x_axis.x, view.y_axis.x, view.z_axis.x);
        self.cam_up    = Vec3::new(view.x_axis.y, view.y_axis.y, view.z_axis.y);

        let u = SceneUniform {
            view_proj:   vp.to_cols_array_2d(),
            view:        view.to_cols_array_2d(),
            proj:        proj.to_cols_array_2d(),
            eye:         self.cam_eye, _p0: 0.0,
            cam_right:   self.cam_right.to_array(), _p1: 0.0,
            cam_up:      self.cam_up.to_array(),    _p2: 0.0,
            ambient:     [0.005, 0.005, 0.008], _p3: 0.0,
            sun_dir:     [0.6, 0.85, 0.5],     _p4: 0.0,
            sun_color:   [0.18, 0.16, 0.13],   _p5: 0.0,
            pt_pos,                             _p6: 0.0,
            pt_color:    [0.55, 0.28, 0.07],   _p7: 0.0,
            proj_x:      proj.x_axis.x,
            proj_y:      proj.y_axis.y,
            znear:       ZNEAR,
            zfar:        ZFAR,
            screen_w:    self.config.width as f32,
            screen_h:    self.config.height as f32,
            ssao_radius: 0.55,
            ssao_strength: 0.85,
        };
        self.queue.write_buffer(&self.scene_uniform_buf, 0, bytemuck::cast_slice(&[u]));
    }

    pub fn render(&mut self) {
        self.frame = self.frame.wrapping_add(1);
        self.update_uniform();

        // update + upload particles — cam_right/cam_up were already computed
        // by update_uniform() above, no need to redo the view matrix here.
        self.particles.update();
        self.particles.update_verts(self.cam_right, self.cam_up);
        let pcount = self.particles.verts.len() as u32;
        if !self.particles.verts.is_empty() {
            self.queue.write_buffer(&self.particle_buf, 0, bytemuck::cast_slice(&self.particles.verts));
        }

        let output = match self.surface.get_current_texture() {
            Ok(t) => t,
            Err(e) => { log::warn!("frame skip: {e:?}"); return; }
        };
        let out_view = output.texture.create_view(&TextureViewDescriptor::default());
        let mut enc  = self.device.create_command_encoder(&Default::default());

        // ── pass 1: scene → G-buffer ─────────────────────────────
        {
            let mut pass = enc.begin_render_pass(&RenderPassDescriptor {
                label: None,
                color_attachments: &[
                    Some(RenderPassColorAttachment {
                        view: &self.gb_color_view, resolve_target: None,
                        ops: Operations { load: LoadOp::Clear(Color::BLACK), store: StoreOp::Store },
                    }),
                    Some(RenderPassColorAttachment {
                        view: &self.gb_nd_view, resolve_target: None,
                        ops: Operations { load: LoadOp::Clear(Color::BLACK), store: StoreOp::Store },
                    }),
                ],
                depth_stencil_attachment: Some(RenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_ops: Some(Operations { load: LoadOp::Clear(1.0), store: StoreOp::Store }),
                    stencil_ops: None,
                }),
                timestamp_writes: None, occlusion_query_set: None,
            });
            pass.set_pipeline(&self.scene_pipeline);
            pass.set_bind_group(0, &self.scene_bg, &[]);
            let mat_bg = self.loaded_material_bg.as_ref().unwrap_or(&self.default_material_bg);
            pass.set_bind_group(1, mat_bg, &[]);
            pass.set_vertex_buffer(0, self.vertex_buf.slice(..));
            pass.set_index_buffer(self.index_buf.slice(..), IndexFormat::Uint32);
            pass.draw_indexed(0..self.index_count, 0, 0..1);
        }

        // ── pass 2: SSAO ─────────────────────────────────────────
        {
            let mut pass = enc.begin_render_pass(&RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &self.ssao_view, resolve_target: None,
                    ops: Operations { load: LoadOp::Clear(Color::WHITE), store: StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None, occlusion_query_set: None,
            });
            pass.set_pipeline(&self.ssao_pipeline);
            pass.set_bind_group(0, &self.scene_bg, &[]);
            pass.set_bind_group(1, &self.ssao_bg,  &[]);
            pass.draw(0..3, 0..1);
        }

        // ── pass 3: composite → composite_out_tex ────────────────
        {
            let mut pass = enc.begin_render_pass(&RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &self.composite_out_view, resolve_target: None,
                    ops: Operations { load: LoadOp::Clear(Color::BLACK), store: StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None, occlusion_query_set: None,
            });
            pass.set_pipeline(&self.composite_pipeline);
            pass.set_bind_group(0, &self.composite_bg, &[]);
            pass.draw(0..3, 0..1);
        }

        // ── pass 4: particles (additive) → composite_out_tex ─────
        if pcount > 0 {
            let mut pass = enc.begin_render_pass(&RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &self.composite_out_view, resolve_target: None,
                    ops: Operations { load: LoadOp::Load, store: StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None, occlusion_query_set: None,
            });
            pass.set_pipeline(&self.particle_pipeline);
            pass.set_bind_group(0, &self.scene_bg, &[]);
            pass.set_vertex_buffer(0, self.particle_buf.slice(..));
            pass.draw(0..pcount, 0..1);
        }

        // ── pass 5: persistence → [accum[pong], swapchain] ───────
        // Even frames: reads accum_a (ping) → writes accum_b (pong) + screen
        // Odd  frames: reads accum_b (ping) → writes accum_a (pong) + screen
        {
            let (bg, pong_view) = if self.frame & 1 == 0 {
                (&self.persist_bg_a, &self.accum_b_view)
            } else {
                (&self.persist_bg_b, &self.accum_a_view)
            };
            let mut pass = enc.begin_render_pass(&RenderPassDescriptor {
                label: None,
                color_attachments: &[
                    Some(RenderPassColorAttachment {
                        view: pong_view, resolve_target: None,
                        ops: Operations { load: LoadOp::Clear(Color::BLACK), store: StoreOp::Store },
                    }),
                    Some(RenderPassColorAttachment {
                        view: &out_view, resolve_target: None,
                        ops: Operations { load: LoadOp::Clear(Color::BLACK), store: StoreOp::Store },
                    }),
                ],
                depth_stencil_attachment: None,
                timestamp_writes: None, occlusion_query_set: None,
            });
            pass.set_pipeline(&self.persistence_pipeline);
            pass.set_bind_group(0, bg, &[]);
            pass.draw(0..3, 0..1);
        }

        self.queue.submit(std::iter::once(enc.finish()));
        output.present();
    }
}

impl SceneUniform {
    fn default_val(aspect: f32, w: u32, h: u32) -> Self {
        let proj = Mat4::perspective_rh_gl(FOVY, aspect, ZNEAR, ZFAR);
        Self {
            view_proj: Mat4::IDENTITY.to_cols_array_2d(),
            view:      Mat4::IDENTITY.to_cols_array_2d(),
            proj:      proj.to_cols_array_2d(),
            eye:       [0.0, 7.0, 16.0], _p0: 0.0,
            cam_right: [1.0, 0.0, 0.0],  _p1: 0.0,
            cam_up:    [0.0, 1.0, 0.0],  _p2: 0.0,
            ambient:   [0.005, 0.005, 0.008], _p3: 0.0,
            sun_dir:   [0.6, 0.85, 0.5],     _p4: 0.0,
            sun_color: [0.18, 0.16, 0.13],   _p5: 0.0,
            pt_pos:    [0.0, 4.0, 0.0],      _p6: 0.0,
            pt_color:  [0.55, 0.28, 0.07],   _p7: 0.0,
            proj_x: proj.x_axis.x, proj_y: proj.y_axis.y,
            znear: ZNEAR, zfar: ZFAR,
            screen_w: w as f32, screen_h: h as f32,
            ssao_radius: 0.55, ssao_strength: 0.85,
        }
    }
}
