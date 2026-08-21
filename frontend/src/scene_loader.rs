// Blender export settings for scene.glb:
//   File → Export → glTF 2.0
//   Format: GLB (binary, single file)
//   Include: ✓ Selected Objects (optional), ✓ Apply Modifiers
//   Geometry: ✓ UVs, ✓ Normals, ✓ Tangents, ✓ Vertex Colors (optional)
//   Materials: ✓ Export, PBR Extensions: leave default
//   Textures: ✓ Export Textures (embedded in GLB)
//   Transform: Y Up (default Blender glTF convention)
//
// Performance tips for low-end office PCs (integrated graphics):
//   • Keep polygon count under 100k triangles
//   • Bake AO + indirect light into the albedo texture in Blender (Cycles bake)
//   • Texture resolution: 1024×1024 max; 512 for smaller details
//   • Use PNG for textures with transparency, JPEG (80% quality) otherwise
//   • Apply all object transforms (Ctrl+A → All Transforms) before export
//   • Use a single material if possible; multi-material adds draw calls
//
// Place the exported file at: frontend/assets/scene.glb
// The website falls back to the procedural megastructure if the file is absent.

use wasm_bindgen::{prelude::*, JsCast};
use wasm_bindgen_futures::JsFuture;

use crate::renderer::Vertex;

pub struct MeshData {
    pub vertices:     Vec<Vertex>,
    pub indices:      Vec<u32>,
    pub albedo_rgba8: Option<(Vec<u8>, u32, u32)>,
    pub normal_rgba8: Option<(Vec<u8>, u32, u32)>,
}

pub async fn load_glb_scene(url: &str) -> Option<MeshData> {
    let bytes = match fetch_bytes(url).await {
        Ok(b) => b,
        Err(e) => {
            log::warn!("GLB fetch '{}': {:?}", url, e);
            return None;
        }
    };
    match gltf::import_slice(&bytes) {
        Ok((doc, buffers, images)) => build_mesh(&doc, &buffers, &images),
        Err(e) => { log::warn!("GLB parse: {}", e); None }
    }
}

// ── network ───────────────────────────────────────────────────────────────

async fn fetch_bytes(url: &str) -> Result<Vec<u8>, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("no window"))?;

    // window.fetch(url)
    let fetch_fn = js_sys::Reflect::get(&window, &JsValue::from_str("fetch"))?
        .dyn_into::<js_sys::Function>()?;
    let promise = fetch_fn
        .call1(&window, &JsValue::from_str(url))?
        .dyn_into::<js_sys::Promise>()?;
    let resp = JsFuture::from(promise).await?;

    // check resp.ok
    let ok = js_sys::Reflect::get(&resp, &JsValue::from_str("ok"))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !ok {
        let status = js_sys::Reflect::get(&resp, &JsValue::from_str("status"))
            .ok().and_then(|v| v.as_f64()).unwrap_or(0.0) as u16;
        return Err(JsValue::from_str(&format!("HTTP {status}")));
    }

    // resp.arrayBuffer()
    let ab_fn = js_sys::Reflect::get(&resp, &JsValue::from_str("arrayBuffer"))?
        .dyn_into::<js_sys::Function>()?;
    let ab_promise = ab_fn.call0(&resp)?.dyn_into::<js_sys::Promise>()?;
    let buf = JsFuture::from(ab_promise).await?;

    Ok(js_sys::Uint8Array::new(&buf).to_vec())
}

// ── gltf parse ────────────────────────────────────────────────────────────

fn build_mesh(
    doc: &gltf::Document,
    buffers: &[gltf::buffer::Data],
    images: &[gltf::image::Data],
) -> Option<MeshData> {
    let mut all_verts: Vec<Vertex> = Vec::new();
    let mut all_idxs:  Vec<u32>   = Vec::new();

    // Use the first material's textures for the whole merged mesh.
    let albedo_rgba8 = doc.materials().next().and_then(|mat| {
        let idx = mat.pbr_metallic_roughness().base_color_texture()?.texture().source().index();
        images.get(idx).map(to_rgba8)
    });
    let normal_rgba8 = doc.materials().next().and_then(|mat| {
        let idx = mat.normal_texture()?.texture().source().index();
        images.get(idx).map(to_rgba8)
    });

    for mesh in doc.meshes() {
        for prim in mesh.primitives() {
            let reader = prim.reader(|buf| buffers.get(buf.index()).map(|b| b.as_ref()));

            let Some(pos_acc) = reader.read_positions() else { continue };
            let positions: Vec<[f32; 3]> = pos_acc.collect();
            let n = positions.len();

            let normals: Vec<[f32; 3]> = reader.read_normals()
                .map(|it| it.collect())
                .unwrap_or_else(|| vec![[0.0, 1.0, 0.0]; n]);

            let tangents: Vec<[f32; 4]> = reader.read_tangents()
                .map(|it| it.collect())
                .unwrap_or_else(|| vec![[1.0, 0.0, 0.0, 1.0]; n]);

            let uvs: Vec<[f32; 2]> = reader.read_tex_coords(0)
                .map(|it| it.into_f32().collect())
                .unwrap_or_else(|| vec![[0.0, 0.0]; n]);

            let base = all_verts.len() as u32;
            for i in 0..n {
                all_verts.push(Vertex {
                    pos:     positions[i],
                    normal:  normals[i],
                    tangent: tangents[i],
                    color:   [1.0, 1.0, 1.0],  // albedo texture drives color
                    uv:      uvs[i],
                });
            }

            match reader.read_indices() {
                Some(idxs) => all_idxs.extend(idxs.into_u32().map(|i| base + i)),
                None       => all_idxs.extend(0..n as u32),
            }
        }
    }

    if all_verts.is_empty() { return None; }

    Some(MeshData { vertices: all_verts, indices: all_idxs, albedo_rgba8, normal_rgba8 })
}

// ── image format conversion ───────────────────────────────────────────────

fn to_rgba8(img: &gltf::image::Data) -> (Vec<u8>, u32, u32) {
    use gltf::image::Format;
    let (w, h) = (img.width, img.height);
    let pixels: Vec<u8> = match img.format {
        Format::R8G8B8A8 => img.pixels.clone(),
        Format::R8G8B8 => img.pixels.chunks_exact(3)
            .flat_map(|c| [c[0], c[1], c[2], 255u8]).collect(),
        Format::R8 => img.pixels.iter()
            .flat_map(|&v| [v, v, v, 255u8]).collect(),
        Format::R8G8 => img.pixels.chunks_exact(2)
            .flat_map(|c| [c[0], c[1], 0u8, 255u8]).collect(),
        Format::R16G16B16A16 => img.pixels.chunks_exact(8)
            .flat_map(|c| [c[1], c[3], c[5], c[7]]).collect(),
        Format::R16G16B16 => img.pixels.chunks_exact(6)
            .flat_map(|c| [c[1], c[3], c[5], 255u8]).collect(),
        Format::R16G16 => img.pixels.chunks_exact(4)
            .flat_map(|c| [c[1], c[3], 0u8, 255u8]).collect(),
        Format::R16 => img.pixels.chunks_exact(2)
            .flat_map(|c| [c[1], c[1], c[1], 255u8]).collect(),
        Format::R32G32B32A32FLOAT => img.pixels.chunks_exact(16)
            .flat_map(|c| to_u8x4_f32(c, 4)).collect(),
        Format::R32G32B32FLOAT => img.pixels.chunks_exact(12)
            .flat_map(|c| to_u8x4_f32(c, 3)).collect(),
        #[allow(unreachable_patterns)]
        _ => vec![255u8; (w * h * 4) as usize],
    };
    (pixels, w, h)
}

fn to_u8x4_f32(bytes: &[u8], components: usize) -> [u8; 4] {
    let ch = |i: usize| -> u8 {
        if i < components {
            let s = i * 4;
            let f = f32::from_le_bytes([bytes[s], bytes[s+1], bytes[s+2], bytes[s+3]]);
            (f.clamp(0.0, 1.0) * 255.0) as u8
        } else { 255 }
    };
    [ch(0), ch(1), ch(2), ch(3)]
}
