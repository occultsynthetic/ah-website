use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

mod renderer;
mod notes;
mod glitch;
mod scene_loader;

use glitch::GlitchLayer;
use notes::Notes;
use renderer::Renderer;

fn request_animation_frame(f: &Closure<dyn FnMut()>) {
    web_sys::window()
        .unwrap()
        .request_animation_frame(f.as_ref().unchecked_ref())
        .expect("raf failed");
}

#[wasm_bindgen(start)]
pub async fn main() {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Warn);

    let window   = web_sys::window().expect("no window");
    let document = window.document().expect("no document");

    let canvas = document
        .get_element_by_id("canvas")
        .expect("no #canvas")
        .dyn_into::<HtmlCanvasElement>()
        .expect("not a canvas");

    let w = window.inner_width().unwrap().as_f64().unwrap() as u32;
    let h = window.inner_height().unwrap().as_f64().unwrap() as u32;
    canvas.set_width(w);
    canvas.set_height(h);

    let renderer = match Renderer::new(canvas).await {
        Ok(r) => r,
        Err(e) => { log::error!("renderer init failed: {e}"); return; }
    };
    let renderer = Rc::new(RefCell::new(renderer));

    let notes = match Notes::init(&document) {
        Ok(n) => n,
        Err(e) => { log::error!("notes init failed: {e}"); return; }
    };

    let glitch = match GlitchLayer::new(&document) {
        Ok(g) => g,
        Err(e) => { log::error!("glitch init failed: {e}"); return; }
    };
    let glitch = Rc::new(RefCell::new(glitch));

    setup_menu(&renderer, &notes, &glitch);

    // Load scene.glb in the background; falls back to procedural geometry if absent.
    {
        let r = renderer.clone();
        wasm_bindgen_futures::spawn_local(async move {
            if let Some(mesh) = scene_loader::load_glb_scene("/assets/scene.glb").await {
                r.borrow_mut().load_scene(mesh);
                log::info!("GLB scene loaded");
            }
        });
    }

    let raf: Rc<RefCell<Option<Closure<dyn FnMut()>>>> = Rc::new(RefCell::new(None));
    let raf_loop = raf.clone();
    let glitch_raf = glitch.clone();

    // Cap render work to ~60fps. request_animation_frame still fires at the
    // display's native refresh rate (120/144Hz on many monitors), but this
    // scene reads identically at 60 — no reason to pay 2x+ the GPU cost for
    // an ambient background on high-refresh displays.
    const FRAME_MS: f64 = 1000.0 / 60.0;
    let mut last_frame_time = 0.0_f64;

    *raf.borrow_mut() = Some(Closure::wrap(Box::new(move || {
        let now = web_sys::window()
            .and_then(|w| w.performance())
            .map(|p| p.now())
            .unwrap_or(0.0);
        if now - last_frame_time >= FRAME_MS {
            last_frame_time = now;
            let (ps, cs, il, sa, t, sy0, sy1) = glitch_raf.borrow_mut().tick();
            let mut r = renderer.borrow_mut();
            r.set_glitch(ps, cs, il, sa, t, sy0, sy1);
            r.render();
        }
        request_animation_frame(raf_loop.borrow().as_ref().unwrap());
    }) as Box<dyn FnMut()>));

    request_animation_frame(raf.borrow().as_ref().unwrap());
    std::mem::forget(raf);
}

fn setup_menu(renderer: &Rc<RefCell<Renderer>>, notes: &Notes, glitch: &Rc<RefCell<GlitchLayer>>) {
    for sector_idx in 0..4u32 {
        let doc = web_sys::window().unwrap().document().unwrap();
        let btn = match doc.get_element_by_id(&format!("sector-{sector_idx}")) {
            Some(el) => el,
            None => continue,
        };

        let r = renderer.clone();
        let n = notes.clone();
        let g_click = glitch.clone();

        // ── click: sector change + full glitch transition ──────────
        let click_cb = Closure::wrap(Box::new(move |_: web_sys::MouseEvent| {
            g_click.borrow_mut().trigger();
            let _ = js_sys::eval("if(window.__music)window.__music.onGlitch()");
            r.borrow_mut().set_sector(sector_idx as usize);
            let _ = js_sys::eval(&format!("if(window.__music)window.__music.setSector({})", sector_idx));

            // notes panel (sector 3)
            if sector_idx == 3 { n.show(); } else { n.hide(); }

            if let Some(d) = web_sys::window().and_then(|w| w.document()) {
                // active class on menu buttons
                for j in 0..4u32 {
                    if let Some(el) = d.get_element_by_id(&format!("sector-{j}")) {
                        let cl = el.class_list();
                        if j == sector_idx { let _ = cl.add_1("active"); }
                        else               { let _ = cl.remove_1("active"); }
                    }
                }
                // content panels for sectors 0–2
                for j in 0..3u32 {
                    if let Some(panel) = d.get_element_by_id(&format!("panel-{j}")) {
                        let cl = panel.class_list();
                        if j == sector_idx { let _ = cl.remove_1("panel-hidden"); }
                        else               { let _ = cl.add_1("panel-hidden"); }
                    }
                }
            }
        }) as Box<dyn FnMut(web_sys::MouseEvent)>);

        let _ = btn.add_event_listener_with_callback("click", click_cb.as_ref().unchecked_ref());
        click_cb.forget();

        // ── mouseenter: hover pixelation squares + ghost text ──────
        let g_enter  = glitch.clone();
        let btn_enter = btn.clone();

        let enter_cb = Closure::wrap(Box::new(move |_: web_sys::MouseEvent| {
            let rect = btn_enter.get_bounding_client_rect();
            let text = btn_enter.text_content().unwrap_or_default();
            g_enter.borrow_mut().hover_enter(&text, rect.left(), rect.top());
        }) as Box<dyn FnMut(web_sys::MouseEvent)>);

        let _ = btn.add_event_listener_with_callback("mouseenter", enter_cb.as_ref().unchecked_ref());
        enter_cb.forget();

        // ── mouseleave: clear hover effects ────────────────────────
        let g_leave = glitch.clone();

        let leave_cb = Closure::wrap(Box::new(move |_: web_sys::MouseEvent| {
            g_leave.borrow_mut().hover_leave();
        }) as Box<dyn FnMut(web_sys::MouseEvent)>);

        let _ = btn.add_event_listener_with_callback("mouseleave", leave_cb.as_ref().unchecked_ref());
        leave_cb.forget();
    }
}
