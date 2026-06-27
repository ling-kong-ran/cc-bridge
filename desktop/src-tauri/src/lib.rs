use std::io::BufRead;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

/// Holds the Python sidecar child process so we can kill it on exit.
pub struct SidecarState(pub Mutex<Option<std::process::Child>>);

/// Spawns the Python sidecar, reads its port from stdout, and returns (port, child).
fn spawn_sidecar(cmd: &str, args: &[&str]) -> Result<(u16, std::process::Child), Box<dyn std::error::Error>> {
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start sidecar '{}': {}", cmd, e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture sidecar stdout")?;
    let mut reader = std::io::BufReader::new(stdout);

    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(30);
    let mut port: u16 = 0;

    loop {
        if start.elapsed() > timeout {
            let _ = child.kill();
            return Err("Sidecar timed out waiting for port".into());
        }
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => {
                let status = child.wait().ok();
                return Err(format!("Sidecar exited with {:?} before reporting port", status).into());
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.starts_with("SIDECAR_PORT:") {
                    port = trimmed.trim_start_matches("SIDECAR_PORT:").trim().parse().unwrap_or(17878);
                    break;
                }
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("Error reading sidecar stdout: {}", e).into());
            }
        }
    }

    Ok((port, child))
}

/// Finds the sidecar binary path. Returns (command, args) for spawn_sidecar.
fn resolve_sidecar_command(app: &tauri::AppHandle) -> (String, Vec<String>) {
    let exe_name = if cfg!(windows) { "server.exe" } else { "server" };

    // Search candidate directories for server.exe
    let mut search_dirs: Vec<std::path::PathBuf> = Vec::new();

    // 1. Exe-relative (most reliable for production)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            search_dirs.push(exe_dir.join("binaries").join("server"));
            search_dirs.push(exe_dir.to_path_buf());
        }
    }

    // 2. Tauri resource dir
    if let Ok(resource_dir) = app.path().resource_dir() {
        search_dirs.push(resource_dir.join("binaries").join("server"));
        search_dirs.push(resource_dir);
    }

    // 3. CARGO_MANIFEST_DIR (development)
    search_dirs.push(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("server"),
    );

    for dir in &search_dirs {
        let candidate = dir.join(exe_name);
        if candidate.exists() {
            eprintln!("[cc-gui] Found sidecar at: {:?}", candidate);
            return (candidate.to_string_lossy().to_string(), vec!["--sidecar".to_string()]);
        }
    }

    // 4. Development fallback: try `python ../server.py --sidecar`
    let repo_server = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("server.py");
    if repo_server.exists() {
        eprintln!("[cc-gui] Falling back to: python {:?}", repo_server);
        return (
            "python".to_string(),
            vec![repo_server.to_string_lossy().to_string(), "--sidecar".to_string()],
        );
    }

    // 5. Last resort
    eprintln!("[cc-gui] Sidecar not found, trying PATH: {}", exe_name);
    (exe_name.to_string(), vec!["--sidecar".to_string()])
}

/// Try to start the sidecar, falling back to connecting to an existing server.
fn try_start_sidecar(app: &tauri::AppHandle) -> Result<(u16, std::process::Child), String> {
    let (cmd, args) = resolve_sidecar_command(app);
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    eprintln!("[cc-gui] Starting sidecar: {} {:?}", cmd, args_ref);

    match spawn_sidecar(&cmd, &args_ref) {
        Ok(result) => return Ok(result),
        Err(e) => {
            let err_msg = format!("Sidecar start failed: {}\nTrying fallback...", e);
            eprintln!("[cc-gui] {}", err_msg);
        }
    }

    // Fallback: try to connect to an already-running server on common ports
    for port in [17878u16, 17879, 17880] {
        if port_is_open(port) {
            eprintln!("[cc-gui] Found existing server on port {}", port);
            // Return a dummy child process
            let dummy = if cfg!(windows) {
                Command::new("cmd.exe").args(["/c", "exit", "0"]).spawn().ok()
            } else {
                Command::new("true").spawn().ok()
            };
            return Ok((port, dummy.unwrap_or_else(|| {
                // Can't create dummy, spawn a no-op
                Command::new(if cfg!(windows) { "cmd.exe" } else { "true" })
                    .spawn()
                    .expect("Cannot spawn")
            })));
        }
    }

    Err("Could not start sidecar and no existing server found.\n\
          Please ensure the server is running (python server.py) or rebuild with `npm run build:all`."
        .to_string())
}

fn port_is_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        std::time::Duration::from_millis(500),
    )
    .is_ok()
}

fn show_error_and_exit(title: &str, message: &str) -> ! {
    eprintln!("[cc-gui] FATAL: {} - {}", title, message);

    // Write error to temp file for user to check
    let tmp = std::env::temp_dir();
    let log_path = tmp.join("cc-gui-error.log");
        let _ = std::fs::write(&log_path, format!("{}: {}\n{}", title, message, chrono_now()));
        eprintln!("[cc-gui] Error log written to: {:?}", log_path);

    // Try platform-specific error dialog
    #[cfg(target_os = "windows")]
    {
        // Use msg.exe as a simple dialog
        let _ = Command::new("msg")
            .args(["*", &format!("{} - {}", title, message)])
            .spawn();
    }

    std::process::exit(1);
}

fn chrono_now() -> String {
    // Simple timestamp without chrono dependency
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}", d.as_secs()))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let (port, child) = match try_start_sidecar(&app.handle()) {
                Ok(result) => result,
                Err(e) => {
                    show_error_and_exit("CC-GUI Error", &e);
                }
            };

            eprintln!("[cc-gui] Sidecar ready on port {}", port);

            app.manage(SidecarState(Mutex::new(Some(child))));

            let url: tauri::Url = format!("http://127.0.0.1:{}", port)
                .parse()
                .expect("Invalid URL");

            let _window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("CC-GUI")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .center()
                .build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let windows = app.webview_windows();
                if windows.len() <= 1 {
                    if let Some(state) = app.try_state::<SidecarState>() {
                        if let Ok(mut guard) = state.0.lock() {
                            if let Some(ref mut child) = *guard {
                                eprintln!("[cc-gui] Shutting down sidecar");
                                drop(child.stdin.take());
                                std::thread::sleep(std::time::Duration::from_millis(200));
                                let _ = child.kill();
                            }
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running cc-gui");
}
