use serde::Serialize;
use std::time::Instant;

use crate::config::normalize_base_url;

#[derive(Debug, Serialize)]
pub struct HealthCheckResult {
    pub request_url: String,
    pub ok: bool,
    pub status_code: Option<u16>,
    pub elapsed_ms: u128,
    pub payload: Option<serde_json::Value>,
    pub error: Option<String>,
}

async fn fetch_health(
    client: &reqwest::Client,
    request_url: String,
) -> HealthCheckResult {
    let start = Instant::now();

    let resp = match client.get(&request_url).send().await {
        Ok(r) => r,
        Err(e) => {
            return HealthCheckResult {
                request_url,
                ok: false,
                status_code: None,
                elapsed_ms: start.elapsed().as_millis(),
                payload: None,
                error: Some(e.to_string()),
            };
        }
    };

    let status_code = Some(resp.status().as_u16());
    let ok = resp.status().is_success();
    let text = resp.text().await.unwrap_or_default();
    let payload = serde_json::from_str::<serde_json::Value>(&text).ok();

    HealthCheckResult {
        request_url,
        ok,
        status_code,
        elapsed_ms: start.elapsed().as_millis(),
        payload,
        error: None,
    }
}

/// 检测 `GET /api/health`，并在需要时自动兼容 AntiHub Web 的 `/backend/*` 代理：
/// - `{base}/api/health`
/// - `{base}/backend/api/health`
#[tauri::command]
pub async fn check_health(base_url: String) -> Result<HealthCheckResult, String> {
    let base = normalize_base_url(&base_url).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let candidates = [
        format!("{base}/api/health"),
        format!("{base}/backend/api/health"),
    ];
    let candidate_count = candidates.len();

    let mut last: Option<HealthCheckResult> = None;

    for (idx, url) in candidates.iter().cloned().enumerate() {
        let result = fetch_health(&client, url).await;
        let should_try_next = idx + 1 < candidate_count
            && (result.status_code == Some(404) || result.status_code.is_none());

        if result.ok {
            return Ok(result);
        }

        last = Some(result);

        if !should_try_next {
            break;
        }
    }

    Ok(last.unwrap_or(HealthCheckResult {
        request_url: format!("{base}/api/health"),
        ok: false,
        status_code: None,
        elapsed_ms: 0,
        payload: None,
        error: Some("unknown error".into()),
    }))
}
