use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Router,
};
use std::{path::PathBuf, sync::Arc};
use tower_http::{cors::CorsLayer, services::ServeDir};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let dist_path = std::env::var("DIST_PATH")
        .unwrap_or_else(|_| "frontend/dist".to_string());

    let notes_dir = Arc::new(PathBuf::from(
        std::env::var("NOTES_DIR").unwrap_or_else(|_| "notes".to_string()),
    ));

    // Ensure notes dir exists
    if !notes_dir.exists() {
        tracing::warn!("notes dir {:?} does not exist — /api/notes will return empty", notes_dir);
    }

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/notes", get(list_notes))
        .route("/api/notes/*path", get(get_note))
        .nest_service("/", ServeDir::new(&dist_path))
        .with_state(notes_dir)
        .layer(CorsLayer::permissive());

    let addr: std::net::SocketAddr = ([127, 0, 0, 1], 3000).into();
    tracing::info!("serving {} on http://{}", dist_path, addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// GET /api/notes  →  JSON array of relative .md paths
async fn list_notes(State(notes_dir): State<Arc<PathBuf>>) -> impl IntoResponse {
    let mut files: Vec<String> = Vec::new();

    if notes_dir.is_dir() {
        for entry in walkdir::WalkDir::new(&*notes_dir)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(rel) = p.strip_prefix(&*notes_dir) {
                    // Normalise Windows backslashes
                    files.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }

    axum::Json(files)
}

// GET /api/notes/*path  →  raw markdown text
async fn get_note(
    Path(path): Path<String>,
    State(notes_dir): State<Arc<PathBuf>>,
) -> impl IntoResponse {
    // Reject path traversal
    if path.contains("..") || path.contains('\\') {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    let target = notes_dir.join(path.trim_start_matches('/'));

    // Double-check the resolved path stays inside notes_dir
    let notes_abs = notes_dir.canonicalize().unwrap_or_else(|_| notes_dir.as_ref().clone());
    match target.canonicalize() {
        Ok(abs) if abs.starts_with(&notes_abs) => {
            match tokio::fs::read_to_string(&abs).await {
                Ok(text) => text.into_response(),
                Err(_)   => (StatusCode::NOT_FOUND, "note not found").into_response(),
            }
        }
        _ => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
