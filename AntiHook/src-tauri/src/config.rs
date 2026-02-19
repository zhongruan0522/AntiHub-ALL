use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Serialize, Deserialize)]
pub struct AppConfig {
    pub kiro_server_url: String,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing user home directory")]
    MissingHomeDir,

    #[error("invalid url: {0}")]
    InvalidUrl(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

fn config_dir() -> Result<PathBuf, ConfigError> {
    let home_dir = dirs::home_dir().ok_or(ConfigError::MissingHomeDir)?;
    Ok(home_dir.join(".config").join("antihook"))
}

fn config_file_path() -> Result<PathBuf, ConfigError> {
    Ok(config_dir()?.join("config.json"))
}

pub fn normalize_base_url(raw: &str) -> Result<String, ConfigError> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(ConfigError::InvalidUrl("empty url".into()));
    }

    let parsed = url::Url::parse(trimmed)
        .map_err(|e| ConfigError::InvalidUrl(format!("{e}")))?;

    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(ConfigError::InvalidUrl(format!(
                "unsupported scheme: {other}"
            )))
        }
    }

    if parsed.host_str().is_none() {
        return Err(ConfigError::InvalidUrl("missing host".into()));
    }

    Ok(trimmed.to_string())
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), std::io::Error> {
    let tmp_path = path.with_extension("json.tmp");

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::write(&tmp_path, data)?;

    if path.exists() {
        let _ = std::fs::remove_file(path);
    }

    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

#[tauri::command]
pub fn get_config_path() -> Result<String, String> {
    config_file_path()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_config() -> Result<Option<AppConfig>, String> {
    let path = config_file_path().map_err(|e| e.to_string())?;
    if !path.exists() {
        return Ok(None);
    }

    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let cfg: AppConfig = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    Ok(Some(cfg))
}

#[tauri::command]
pub fn save_config(kiro_server_url: String) -> Result<String, String> {
    let normalized = normalize_base_url(&kiro_server_url).map_err(|e| e.to_string())?;
    let cfg = AppConfig {
        kiro_server_url: normalized.clone(),
    };

    let json = serde_json::to_string_pretty(&cfg)
        .map(|s| format!("{s}\n"))
        .map_err(|e| e.to_string())?;

    let path = config_file_path().map_err(|e| e.to_string())?;
    atomic_write(&path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(normalized)
}

