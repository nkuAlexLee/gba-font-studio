//! GBA Font Studio 桌面客户端
//!
//! 职责：
//! 1. 首次启动：在安装路径下创建 workspace（AGENTS.md + .pi/skills + .pi/extensions）
//!    与 agent 数据目录（PI_CODING_AGENT_DIR：sessions/settings），并写入一个初始会话，
//!    让新用户打开即可看到欢迎会话。
//! 2. 拉起两个 sidecar 服务（payload 内自带 node.exe）：
//!    - pi-web（next start，:30141，agent 聊天 UI）
//!    - romctl serve（:8645，GBA 模拟器 + 工作台数据后端）
//! 3. 等 30141 就绪后导航 webview（窗口隐藏启动，避免白屏/报错页闪现）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use tauri::Manager as _;
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::time::{Duration, Instant};

pub fn run() {
    main_inner();
}

fn main_inner() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = bootstrap(&handle) {
                    eprintln!("[gba-app] bootstrap 失败: {e}");
                    show_error_window(&handle, &format!("启动失败：{e}\n\n日志见安装目录 data/logs/"));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running gba font studio");
}

/// 独立错误窗（bootstrap 失败时给出可见反馈）
fn show_error_window(app: &tauri::AppHandle, msg: &str) {
    use tauri::WebviewWindowBuilder;
    let _ = WebviewWindowBuilder::new(app, "error", tauri::WebviewUrl::App("error.html".into()))
        .title("GBA Font Studio — 启动失败")
        .inner_size(640.0, 320.0)
        .visible(true)
        .build();
    let escaped = msg.replace('\\', "\\\\").replace('`', "\\`").replace('<', "&lt;");
    if let Some(w) = app.get_webview_window("error") {
        let _ = w.eval(&format!(
            "document.body.innerHTML = '<pre style=\"font:13px/1.6 monospace;padding:16px;white-space:pre-wrap\">{}</pre>';",
            escaped
        ));
        let _ = w.show();
    }
}

fn bootstrap(app: &tauri::AppHandle) -> Result<(), String> {
    eprintln!("[gba-app] bootstrap: 开始");
    let raw_resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?;
    // Tauri 在 Windows 返回 verbatim 前缀路径（两个反斜杠+问号）；子进程 cwd 不接受该前缀（os error 123）
    let resource_dir = PathBuf::from(strip_verbatim(&raw_resource_dir.to_string_lossy()));
    let payload = find_payload_dir(&resource_dir)?;
    eprintln!("[gba-app] payload = {}", payload.display());

    // 用户数据放安装根目录的 data/（与 payload 分离 → 升级重装 payload 不会丢用户工作区/会话）
    let data_dir = payload
        .parent()
        .map(|p| p.join("data"))
        .unwrap_or_else(|| payload.join("data"));
    let agent_dir = data_dir.join("agent"); // PI_CODING_AGENT_DIR
    let workspace_dir = data_dir.join("workspace"); // agent 工作目录（安装路径下）
    fs::create_dir_all(&agent_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&workspace_dir).map_err(|e| e.to_string())?;

    init_workspace(&payload, &workspace_dir)?;
    init_agent_dir(&agent_dir, &payload)?;
    create_initial_session(&agent_dir, &workspace_dir)?;

    let web_dir = payload.join("pi-web");
    let web_args: &[&str] = &["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", "30141"];
    let web_envs: Vec<(&str, String)> = vec![
        ("PI_CODING_AGENT_DIR", agent_dir.to_string_lossy().into_owned()),
        ("GBA_STUDIO_DIR", payload.join("gba").to_string_lossy().into_owned()),
        ("GBA_SERVE_PORT", "8645".to_string()),
        ("GBA_WORKSPACE_DIR", workspace_dir.to_string_lossy().into_owned()),
    ];
    // 捆绑的 Git Bash usr/bin 前置到 PATH（bash 工具/子进程可解析 ls、grep 等；
    // msys2 运行时会自动把该 Windows 路径转换为 POSIX /usr/bin）
    let gitbash_bin = payload.join("runtime").join("gitbash").join("usr").join("bin");
    let new_path = format!("{};{}", gitbash_bin.display(), std::env::var("PATH").unwrap_or_default());
    let mut web_envs_owned: Vec<(&str, String)> = web_envs.iter().map(|(k, val)| (*k, val.clone())).collect();
    if gitbash_bin.exists() {
        web_envs_owned.push(("PATH", new_path));
    }
    let env_strs: Vec<(&str, &str)> = web_envs_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();

    // 1) 先用捆绑 node.exe（payload/runtime/node.exe）拉起。
    //    ⚠ 部分安全软件（如腾讯电脑管家）会拦截"新复制的 exe"的回环连接（bind 成功但 accept 被滤），
    //    表现为端口 LISTENING 但 HTTP 永不响应 → 探测失败后杀进程树并回退系统 node（PATH）。
    //    instrumentation 随 next 进程自动拉起 romctl serve（GBA_STUDIO_DIR/GBA_WORKSPACE_DIR 环境继承）。
    eprintln!("[gba-app] 拉起 pi-web …");
    let mut web = spawn_server(&payload.join("runtime").join("node.exe"), &web_dir, web_args, &env_strs, "pi-web", &data_dir)?;
    if wait_http("127.0.0.1", 30141, "/", Duration::from_secs(25)).is_err() {
        eprintln!("[gba-app] 捆绑 node 无响应（疑似安全软件拦截），回退系统 node");
        kill_tree(web.id());
        let sys_node = PathBuf::from("node");
        web = spawn_server(&sys_node, &web_dir, web_args, &env_strs, "pi-web-sysnode", &data_dir)?;
        wait_http("127.0.0.1", 30141, "/", Duration::from_secs(90))?;
    }

    // 2) 等 romctl 就绪（instrumentation 已随 web 进程拉起；端口在 GBA_SERVE_PORT）
    let _ = wait_http("127.0.0.1", 8645, "/status", Duration::from_secs(120));

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("location.replace('http://127.0.0.1:30141/')");
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

/// 去除 Windows verbatim 路径前缀（\\\\?\\ 与 \\\\?\\UNC\\）
fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{}", rest);
    }
    p.strip_prefix("\\\\?\\").map(|x| x.to_string()).unwrap_or_else(|| p.to_string())
}

/// payload 目录探测（兼容 resource_dir 平铺与 _up_ 前缀两种布局）
fn find_payload_dir(resource_dir: &Path) -> Result<PathBuf, String> {
    let candidates = [
        resource_dir.to_path_buf(),
        resource_dir.join("_up_"),
        resource_dir.join("_up_").join("_up_"),
        resource_dir.join("payload"),
    ];
    for c in &candidates {
        if c.join("pi-web").join("package.json").exists() && c.join("gba").join("romctl.js").exists() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "payload 未找到（找过 {:?}；resource_dir={}）",
        candidates,
        resource_dir.display()
    ))
}

fn spawn_server(
    node: &Path,
    cwd: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    tag: &str,
    data_dir: &Path,
) -> Result<std::process::Child, String> {
    let mut cmd = Command::new(node);
    cmd.current_dir(cwd).args(args);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：不弹出 cmd 黑框（日志已重定向到 data/logs）
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // 日志重定向到安装根 data/logs，便于排查
    let log_dir = data_dir.join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let log_path = log_dir.join(format!("{tag}.log"));
    use std::process::Stdio;
    if let Ok(f) = fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        cmd.stdout(Stdio::from(f.try_clone().map_err(|e| e.to_string())?));
        cmd.stderr(Stdio::from(f));
    }
    let child = cmd.spawn().map_err(|e| format!("启动 {tag} 失败: {e}"))?;
    eprintln!("[gba-app] {tag} 已启动 pid={} log={}", child.id(), log_path.display());
    Ok(child)
}

/// 杀整个进程树（Windows: taskkill /T；类 Unix: 直接 kill）
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut tk = Command::new("taskkill");
        tk.args(["/PID", &pid.to_string(), "/T", "/F"]);
        #[cfg(windows)]
        tk.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let _ = tk.output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

/// 极简 HTTP 可达性探测（不做 TLS；目标均为 127.0.0.1）
fn wait_http(host: &str, port: u16, path: &str, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    loop {
        if start.elapsed() > timeout {
            return Err(format!("等待 http://{host}:{port}{path} 超时（服务可能启动失败，见 data/logs/）"));
        }
        if http_ok(host, port, path) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(800));
    }
}

fn http_ok(host: &str, port: u16, path: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect((host, port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = std::io::Read::read(&mut stream, &mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.0 200") || head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.1 30")
}

/// 首次运行：把 payload 内模板复制到 workspace/agent 目录（幂等：不覆盖已有文件）
fn init_workspace(payload: &Path, workspace_dir: &Path) -> Result<(), String> {
    let template = payload.join("workspace-template");
    if !template.exists() {
        return Err(format!("workspace 模板缺失: {}", template.display()));
    }
    copy_tree_if_absent(&template, workspace_dir)
}

fn init_agent_dir(agent_dir: &Path, payload: &Path) -> Result<(), String> {
    // sessions/settings 目录骨架；credentials 由用户在 UI 设置面板里配置
    fs::create_dir_all(agent_dir.join("sessions")).map_err(|e| e.to_string())?;
    // settings.json：把捆绑 Git Bash 的 shellPath 写为安装绝对路径
    // （全新用户机器上 PATH 里的 bash.exe 是 WSL 桩，pi 会报"未安装 WSL"）
    let tpl = payload.join("agent-template").join("settings.json");
    let dst = agent_dir.join("settings.json");
    if tpl.exists() && !dst.exists() {
        fs::copy(&tpl, &dst).map_err(|e| e.to_string())?;
    }
    let shell = payload.join("runtime").join("gitbash").join("usr").join("bin").join("bash.exe");
    if shell.exists() && dst.exists() {
        if let Ok(raw) = fs::read_to_string(&dst) {
            let patched = if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
                v["shellPath"] = serde_json::Value::String(shell.to_string_lossy().into_owned());
                serde_json::to_string_pretty(&v).unwrap_or(raw)
            } else { raw };
            fs::write(&dst, patched).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 递归复制（目标已存在时跳过 → 重装/升级不覆盖用户数据）
fn copy_tree_if_absent(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in fs::read_dir(src).map_err(|e| format!("read_dir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            copy_tree_if_absent(&from, &to)?;
        } else if !to.exists() {
            fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

/// 写入初始会话（pi session v3 JSONL），新用户首次打开即有欢迎会话
fn create_initial_session(agent_dir: &Path, workspace_dir: &Path) -> Result<(), String> {
    let cwd_str = workspace_dir.to_string_lossy().replace('/', "\\");
    // pi 会话目录编码：<cwd> 中 ':' '\' '/' 全部替换为 '-'，两侧包 --…--
    let encoded = format!("--{}--", cwd_str.replace([':', '\\', '/'], "-"));
    let sessions_dir = agent_dir.join("sessions").join(&encoded);
    fs::create_dir_all(&sessions_dir).map_err(|e| e.to_string())?;

    let has_session = fs::read_dir(&sessions_dir)
        .map(|d| d.filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().ends_with(".jsonl")))
        .unwrap_or(false);
    if has_session {
        return Ok(());
    }

    let id = uuid_v4();
    let now = now_ms();
    let ts = iso_from_ms(now);
    let welcome_user = "帮我了解一下这个工作台能做什么？";
    let welcome_assistant = "欢迎使用 GBA 字库工作台！这是一个内置 GBA 模拟器与中文字库/翻译 Agent 的桌面客户端：\n\n\
1. **右侧「GBA 工作台」**：游戏实时画面、翻译流水线看板、码表/字模浏览、翻译审校表、内存/反汇编。\n\
2. **模拟器键盘操作**（模拟器面板激活时；输入框内不触发）：\n\
   - 方向键 = 十字键；Z = A；X = B；A = L；S = R；M = START；N = SELECT\n\
   - 按住即持续生效，屏上按钮同步显示按压动画；也支持鼠标按住屏上按钮\n\
3. **左侧对话**：直接用自然语言让 agent 干活，例如：\n\
   - 「加载 roms/xxx.gba 然后截图看看当前画面」\n\
   - 「把 START 菜单的文字翻译成中文并回填」\n\
4. **首次使用**：推荐 OpenCode Go（注册即用，含 GLM 系列模型）：https://opencode.ai/go?ref=SWSEB5WEP6 ，注册后在 设置 → Models 里配置供应商与模型即可。\n\
5. ROM 可放在本工作区目录，或任意位置用「📂 打开 ROM」加载（会自动重置模拟器状态）。\n\n\
试一试：先让我加载一个 ROM 并截图看看画面吧！";

    let jsonl = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"{ts}\",\"cwd\":\"{cwd}\"}}\n\
{{\"type\":\"session_name\",\"id\":\"n1\",\"name\":\"{name}\",\"timestamp\":{ms}}}\n\
{{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":{ms},\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{u}\"}}],\"timestamp\":{ms}}}}}\n\
{{\"type\":\"message\",\"id\":\"m2\",\"parentId\":\"m1\",\"timestamp\":{ms},\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{a}\"}}],\"api\":\"local\",\"provider\":\"local\",\"model\":\"welcome\",\"usage\":{{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":0,\"cost\":{{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}}}},\"stopReason\":\"stop\",\"timestamp\":{ms}}}}}\n",
        id = id,
        ts = ts,
        cwd = escape_json(&cwd_str),
        name = escape_json("欢迎使用 GBA 字库工作台"),
        ms = now,
        u = escape_json(welcome_user),
        a = escape_json(welcome_assistant),
    );

    let file = sessions_dir.join(format!("{}_{}.jsonl", ts.replace([':', '.'], "-"), id));
    fs::write(&file, jsonl).map_err(|e| e.to_string())?;
    eprintln!("[gba-app] 初始会话已创建: {}", file.display());
    Ok(())
}

fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 民用历算法（UTC ISO8601）
fn iso_from_ms(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, _m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{_m:02}:{s:02}.000Z")
}

/// 依赖 free 的 uuid v4（xorshift64* 播种：纳秒时钟 ^ 进程 id ^ 地址熵）
fn uuid_v4() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x1234_5678_9ABC_DEF0);
    let pid = std::process::id() as u64;
    let mut state = t ^ pid.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (t.wrapping_mul(0xBF58_476D_1CE4_E5B9));
    let mut next = move || {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545_F491_4F6C_DD1D)
    };
    let mut buf = [0u8; 16];
    for chunk in buf.chunks_mut(8) {
        let r = next().to_le_bytes();
        chunk.copy_from_slice(&r[..chunk.len()]);
    }
    buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
    buf[8] = (buf[8] & 0x3f) | 0x80; // variant
    let h = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        h(&buf[0..4]),
        h(&buf[4..6]),
        h(&buf[6..8]),
        h(&buf[8..10]),
        h(&buf[10..16])
    )
}
