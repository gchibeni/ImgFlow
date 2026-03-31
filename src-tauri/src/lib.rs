use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex, Semaphore};

static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

// ── Download types ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct DownloadTask {
    pub url: String,
    pub dest_path: String,
    pub file_name: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DownloadResult {
    pub success: bool,
    pub file_name: String,
    pub task_index: usize,
    pub error: Option<String>,
}

impl DownloadResult {
    fn ok(file_name: String) -> Self {
        Self { success: true, file_name, task_index: 0, error: None }
    }
    fn err(file_name: String, error: String) -> Self {
        Self { success: false, file_name, task_index: 0, error: Some(error) }
    }
}

#[derive(Debug, Serialize, Clone)]
struct DownloadProgress {
    completed: usize,
    total: usize,
}

// ── Google OAuth types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct GoogleTokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct SheetsResponse {
    sheets: Option<Vec<SheetProperties>>,
}

#[derive(Debug, Deserialize)]
struct SheetProperties {
    properties: SheetProp,
}

#[derive(Debug, Deserialize)]
struct SheetProp {
    title: String,
}

#[derive(Debug, Deserialize)]
struct ValuesResponse {
    values: Option<Vec<Vec<String>>>,
}

#[derive(Debug, Serialize)]
struct SheetDataResponse {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

const REDIRECT_PORT: u16 = 23847;

#[derive(Deserialize)]
struct OAuthCreds {
    client_id: String,
    client_secret: String,
}

static OAUTH_CREDS: OnceLock<OAuthCreds> = OnceLock::new();

fn oauth_creds() -> &'static OAuthCreds {
    OAUTH_CREDS.get_or_init(|| {
        #[derive(Deserialize)]
        struct CredFile {
            installed: OAuthCreds,
        }
        const JSON: &str = include_str!("../../credentials.json");
        let f: CredFile = serde_json::from_str(JSON).expect("Failed to parse credentials.json");
        f.installed
    })
}

fn token_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    dir.join("token.json")
}

fn load_tokens(app: &tauri::AppHandle) -> Option<GoogleTokens> {
    let path = token_path(app);
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_tokens(app: &tauri::AppHandle, tokens: &GoogleTokens) -> Result<(), String> {
    let path = token_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(tokens).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

async fn get_valid_access_token(app: &tauri::AppHandle) -> Result<String, String> {
    let tokens = load_tokens(app).ok_or("Not authenticated")?;

    // Check if token is expired
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    if let Some(expires_at) = tokens.expires_at {
        if now >= expires_at {
            // Refresh the token
            if let Some(refresh_token) = &tokens.refresh_token {
                return refresh_access_token(app, refresh_token).await;
            }
            return Err("Token expired and no refresh token available".into());
        }
    }

    Ok(tokens.access_token)
}

async fn refresh_access_token(
    app: &tauri::AppHandle,
    refresh_token: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", oauth_creds().client_id.as_str()),
            ("client_secret", oauth_creds().client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("Refresh request failed: {}", e))?;

    let token_resp: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let tokens = GoogleTokens {
        access_token: token_resp.access_token.clone(),
        refresh_token: token_resp
            .refresh_token
            .or_else(|| Some(refresh_token.to_string())),
        expires_at: token_resp.expires_in.map(|ei| now + ei - 60),
    };
    save_tokens(app, &tokens)?;

    Ok(token_resp.access_token)
}

// ── Google Auth commands ────────────────────────────────────────────

#[tauri::command]
async fn check_google_auth(app: tauri::AppHandle) -> Result<bool, String> {
    match get_valid_access_token(&app).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
async fn google_login(app: tauri::AppHandle) -> Result<bool, String> {
    let redirect_uri = format!("http://localhost:{}", REDIRECT_PORT);
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=https://www.googleapis.com/auth/spreadsheets.readonly&access_type=offline&prompt=consent",
        oauth_creds().client_id,
        urlencoding(&redirect_uri)
    );

    // Start TCP listener before opening browser
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", REDIRECT_PORT))
        .await
        .map_err(|e| format!("Failed to start callback server: {}", e))?;

    // Open browser
    opener::open(&auth_url).map_err(|e| format!("Failed to open browser: {}", e))?;

    // Wait for callback (with 120s timeout)
    let code = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;

            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
            let request = String::from_utf8_lossy(&buf[..n]).to_string();

            // Extract code from GET /?code=...
            if let Some(code) = extract_code_from_request(&request) {
                let html = auth_page(true);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = stream.write_all(response.as_bytes()).await;
                return Ok::<String, String>(code);
            } else {
                let html = auth_page(false);
                let response = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        }
    })
    .await
    .map_err(|_| "Login timed out (120s)".to_string())??;

    // Exchange code for tokens
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", oauth_creds().client_id.as_str()),
            ("client_secret", oauth_creds().client_secret.as_str()),
            ("redirect_uri", &redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange error: {}", body));
    }

    let token_resp: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let tokens = GoogleTokens {
        access_token: token_resp.access_token,
        refresh_token: token_resp.refresh_token,
        expires_at: token_resp.expires_in.map(|ei| now + ei - 60),
    };
    save_tokens(&app, &tokens)?;

    Ok(true)
}

#[tauri::command]
async fn google_logout(app: tauri::AppHandle) -> Result<(), String> {
    let path = token_path(&app);
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn fetch_sheet_names(
    spreadsheet_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let access_token = get_valid_access_token(&app).await?;
    let sid = extract_spreadsheet_id(&spreadsheet_id);

    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{}?fields=sheets.properties.title",
        sid
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to fetch sheets: {}", body));
    }

    let data: SheetsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let names: Vec<String> = data
        .sheets
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.properties.title)
        .collect();

    Ok(names)
}

#[tauri::command]
async fn fetch_sheet_data(
    spreadsheet_id: String,
    sheet_name: String,
    app: tauri::AppHandle,
) -> Result<SheetDataResponse, String> {
    let access_token = get_valid_access_token(&app).await?;
    let sid = extract_spreadsheet_id(&spreadsheet_id);

    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{}/values/{}",
        sid,
        urlencoding(&sheet_name)
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to fetch data: {}", body));
    }

    let data: ValuesResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let values = data.values.unwrap_or_default();
    if values.is_empty() {
        return Ok(SheetDataResponse {
            headers: vec![],
            rows: vec![],
        });
    }

    let headers: Vec<String> = values[0].iter().map(|h| h.trim().to_string()).collect();
    let rows = values[1..].to_vec();

    Ok(SheetDataResponse { headers, rows })
}

// ── Download commands ───────────────────────────────────────────────

/// Extract the host from a URL for per-domain rate limiting.
fn extract_host(url: &str) -> String {
    let normalized = normalize_url(url);
    if let Ok(parsed) = reqwest::Url::parse(&normalized) {
        parsed.host_str().unwrap_or("unknown").to_lowercase()
    } else {
        "unknown".to_string()
    }
}

#[tauri::command]
async fn download_images(
    tasks: Vec<DownloadTask>,
    app: tauri::AppHandle,
) -> Result<Vec<DownloadResult>, String> {
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let total = tasks.len();
    let completed = Arc::new(AtomicUsize::new(0));

    // Global concurrency limit
    let global_sem = Arc::new(Semaphore::new(10));

    // Per-domain concurrency limit (3 per host)
    let domain_sems: Arc<Mutex<HashMap<String, Arc<Semaphore>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Pre-allocate results in order
    let results: Arc<Mutex<Vec<Option<DownloadResult>>>> =
        Arc::new(Mutex::new(vec![None; total]));

    let mut handles = Vec::with_capacity(total);

    for (i, task) in tasks.into_iter().enumerate() {
        let client = client.clone();
        let app = app.clone();
        let global_sem = global_sem.clone();
        let domain_sems = domain_sems.clone();
        let results = results.clone();
        let completed = completed.clone();

        let handle = tokio::spawn(async move {
            // Check cancel before acquiring permits
            if CANCEL_FLAG.load(Ordering::SeqCst) {
                return;
            }

            // Acquire global permit
            let _global_permit = global_sem.acquire().await.unwrap();

            // Check cancel after acquiring global permit
            if CANCEL_FLAG.load(Ordering::SeqCst) {
                return;
            }

            // Acquire per-domain permit
            let host = extract_host(&task.url);
            let domain_sem = {
                let mut map = domain_sems.lock().await;
                map.entry(host).or_insert_with(|| Arc::new(Semaphore::new(4))).clone()
            };
            let _domain_permit = domain_sem.acquire().await.unwrap();

            // Check cancel one more time before downloading
            if CANCEL_FLAG.load(Ordering::SeqCst) {
                return;
            }

            let mut result = download_single(&client, &task).await;
            result.task_index = i;

            // Store result in its original position
            {
                let mut res = results.lock().await;
                res[i] = Some(result);
            }

            // Emit progress
            let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = app.emit(
                "download-progress",
                DownloadProgress {
                    completed: done,
                    total,
                },
            );
        });

        handles.push(handle);
    }

    // Wait for all tasks to complete
    for handle in handles {
        let _ = handle.await;
    }

    // Collect results, filtering out cancelled (None) entries
    let final_results = results.lock().await.iter().filter_map(|r| r.clone()).collect();

    Ok(final_results)
}

#[tauri::command]
fn cancel_download() {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn validate_download_path(path: String) -> Result<bool, String> {
    let p = PathBuf::from(&path);
    // Try to create the directory to see if the path is valid and writable
    if let Err(e) = tokio::fs::create_dir_all(&p).await {
        return Err(format!("Cannot use this download path: {}", e));
    }
    Ok(true)
}

#[tauri::command]
fn get_default_export_path() -> String {
    if let Some(docs) = dirs::document_dir() {
        let export = docs.join("Export");
        return export.to_string_lossy().to_string();
    }
    // Fallback
    if cfg!(target_os = "windows") {
        "C:/Users/Documents/Export".to_string()
    } else {
        "~/Documents/Export".to_string()
    }
}

async fn download_single(client: &reqwest::Client, task: &DownloadTask) -> DownloadResult {
    // Subfolder name used in error display: "Subfolder/Img"
    let subfolder = std::path::Path::new(&task.dest_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let display_name = || format!("{}/{}", subfolder, task.file_name);

    let dir = PathBuf::from(&task.dest_path);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return DownloadResult::err(display_name(), format!("Dir error: {}", e));
    }

    let url = normalize_url(&task.url);
    const RETRY_DELAYS_MS: [u64; 4] = [3000, 5000, 8000, 21000];
    let mut last_error = String::new();

    for attempt in 0..=4u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(
                RETRY_DELAYS_MS[(attempt - 1) as usize],
            ))
            .await;
            if CANCEL_FLAG.load(Ordering::SeqCst) {
                return DownloadResult::err(display_name(), "Cancelled".to_string());
            }
        }

        let response = match client.get(&url).send().await {
            Ok(r) => r,
            Err(_) => { last_error = "Network error".to_string(); continue; }
        };

        let status = response.status();

        // Non-retryable client errors (4xx except 429)
        if status.is_client_error() && status.as_u16() != 429 {
            return DownloadResult::err(display_name(), "Invalid link".to_string());
        }
        if status.as_u16() == 429 { last_error = "Rate-limited".to_string(); continue; }
        if status.is_server_error() { last_error = "Server error".to_string(); continue; }
        if !status.is_success() {
            return DownloadResult::err(display_name(), "Invalid link".to_string());
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        // Retryable: HTML usually means a rate-limit or viewer redirect page
        if content_type.contains("text/html") {
            last_error = "Rate-limited".to_string();
            continue;
        }

        let extension = get_extension(&task.url, &content_type, &task.file_name);
        let file_name = if task.file_name.contains('.') {
            task.file_name.clone()
        } else {
            format!("{}.{}", task.file_name, extension)
        };

        let file_path = dir.join(&file_name);

        let bytes = match response.bytes().await {
            Ok(b) => b,
            Err(_) => { last_error = "Network error".to_string(); continue; }
        };

        return match tokio::fs::write(&file_path, &bytes).await {
            Ok(_) => DownloadResult::ok(file_name),
            Err(e) => DownloadResult::err(display_name(), format!("Write error: {}", e)),
        };
    }

    DownloadResult::err(display_name(), last_error)
}

// ── Helpers ─────────────────────────────────────────────────────────

fn auth_page(success: bool) -> String {
    let template = include_str!("../../auth.html");
    let flag = if success { "true" } else { "false" };
    template.replace("</head>", &format!("<script>var AUTH_SUCCESS = {};</script></head>", flag))
}

fn extract_code_from_request(request: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    // GET /?code=XXXX&scope=... HTTP/1.1
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for param in query.split('&') {
        let mut kv = param.splitn(2, '=');
        if kv.next() == Some("code") {
            return kv.next().map(|s| s.to_string());
        }
    }
    None
}

fn extract_spreadsheet_id(input: &str) -> String {
    let input = input.trim();
    // If it's a URL like https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/...
    if input.contains("spreadsheets/d/") {
        if let Some(id) = input.split("spreadsheets/d/").nth(1) {
            return id.split('/').next().unwrap_or(id).to_string();
        }
    }
    // Otherwise treat as raw ID
    input.to_string()
}

fn urlencoding(s: &str) -> String {
    let mut result = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}

fn normalize_url(url: &str) -> String {
    let url = url.trim();
    if url.contains("dropbox.com") {
        // Always force dl=1, regardless of whether dl=0, dl=1, or no dl param exists
        return force_query_param(url, "dl", "1");
    }
    if url.contains("drive.google.com/file/d/") {
        if let Some(id) = url.split("/d/").nth(1).and_then(|s| s.split('/').next()) {
            return format!("https://drive.google.com/uc?export=download&id={}", id);
        }
    }
    url.to_string()
}

/// Rebuild `url` with `key=value` set, replacing any existing value for `key`.
fn force_query_param(url: &str, key: &str, value: &str) -> String {
    let prefix = format!("{}=", key);
    if let Some(qpos) = url.find('?') {
        let base = &url[..qpos];
        let query = &url[qpos + 1..];
        let filtered: Vec<&str> = query.split('&').filter(|p| !p.starts_with(&prefix[..])).collect();
        if filtered.is_empty() {
            format!("{}?{}={}", base, key, value)
        } else {
            format!("{}?{}&{}={}", base, filtered.join("&"), key, value)
        }
    } else {
        format!("{}?{}={}", url, key, value)
    }
}

fn get_extension(url: &str, content_type: &str, file_name: &str) -> String {
    if let Some(ext) = file_name.rsplit('.').next() {
        if matches!(
            ext.to_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "tiff" | "tif"
        ) {
            return ext.to_string();
        }
    }
    if let Some(path) = url.split('?').next() {
        if let Some(ext) = path.rsplit('.').next() {
            let ext_lower = ext.to_lowercase();
            if matches!(
                ext_lower.as_str(),
                "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "tiff" | "tif"
            ) {
                return ext_lower;
            }
        }
    }
    match content_type {
        t if t.contains("jpeg") => "jpg".to_string(),
        t if t.contains("png") => "png".to_string(),
        t if t.contains("gif") => "gif".to_string(),
        t if t.contains("webp") => "webp".to_string(),
        t if t.contains("svg") => "svg".to_string(),
        t if t.contains("bmp") => "bmp".to_string(),
        t if t.contains("tiff") => "tiff".to_string(),
        _ => "jpg".to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            download_images,
            cancel_download,
            validate_download_path,
            get_default_export_path,
            google_login,
            google_logout,
            check_google_auth,
            fetch_sheet_names,
            fetch_sheet_data,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
