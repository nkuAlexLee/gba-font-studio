//! Pi Web 桌面客户端（纯净版：不含 GBA 引擎/扩展/skill）
//!
//! 与 GBA Font Studio 客户端（../app/）同构，差异：
//! 1. payload 探测不要求 gba/romctl.js（纯净 payload 无 GBA 引擎）
//! 2. 不设置 GBA_STUDIO_DIR 等环境变量，只置 GBA_STUDIO=0 —— pi-web instrumentation
//!    据此彻底跳过 romctl serve 自动拉起；UI 的 GBA 工作台入口由构建期
//!    NEXT_PUBLIC_GBA_STUDIO=0 内联剔除
//! 3. 不等待 romctl :8645
//! 4. 欢迎会话为 pi-web 通用介绍
//!
//! 其余职责相同：
//! 1. 首次启动：在安装路径下创建 workspace（AGENTS.md）与 agent 数据目录
//!    （PI_CODING_AGENT_DIR：sessions/settings），并写入一个初始会话。
//! 2. 拉起 pi-web（next start，:30141，payload 内自带 node.exe）。
//! 3. 就绪后导航 webview（窗口隐藏启动，避免白屏/报错页闪现）。

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

/// 把自身进程挂入 kill-on-close 的 Job：子进程（pi-web 整棵树）随本进程
/// 退出（窗口关闭/崩溃/被任务管理器杀）全部终止。否则孤儿 node 会锁住 payload 内文件，
/// 升级安装报 "Error opening file for writing"（GBA 版 2026-09-10 教训）。
/// 嵌套 Job 在 Win8+ 受支持；句柄故意不关闭 —— 本进程终止时它是最后一个句柄，触发整树 kill。
#[cfg(windows)]
fn setup_kill_on_exit_job() {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return; // 创建失败不阻断启动，退回旧行为（手动清理）
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok != 0 {
            AssignProcessToJobObject(job, GetCurrentProcess());
        }
        // 不调用 CloseHandle：句柄随进程生命周期存续
    }
}

#[cfg(not(windows))]
fn setup_kill_on_exit_job() {}

fn main_inner() {
    setup_kill_on_exit_job();
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = bootstrap(&handle) {
                    eprintln!("[piweb-app] bootstrap 失败: {e}");
                    show_error_window(&handle, &format!("启动失败：{e}\n\n日志见安装目录 data/logs/"));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running pi web desktop");
}

/// 独立错误窗（bootstrap 失败时给出可见反馈）。
/// 详细错误经 initialization_script 注入（页面脚本执行前生效），规避旧 eval 早于页面
/// 加载、被后续导航冲掉导致只显示静态占位文案的竞态（2026-10-01 实机踩坑）。
fn show_error_window(app: &tauri::AppHandle, msg: &str) {
    use tauri::WebviewWindowBuilder;
    let json = serde_json::to_string(msg).unwrap_or_else(|_| "\"启动失败\"".into());
    let init = format!("window.__PIWEB_BOOTSTRAP_ERROR = {json};");
    let _ = WebviewWindowBuilder::new(app, "error", tauri::WebviewUrl::App("error.html".into()))
        .title("Pi Web — 启动失败")
        .inner_size(640.0, 320.0)
        .visible(true)
        .initialization_script(&init)
        .build();
}

/// bootstrap 过程日志（release GUI 子系统没有 stderr，eprintln 全部丢失；
/// 排障全靠本文件：data/logs/bootstrap.log）
fn bootstrap_log(data_dir: &Path, line: &str) {
    let log_dir = data_dir.join("logs");
    let _ = fs::create_dir_all(&log_dir);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(log_dir.join("bootstrap.log")) {
        let _ = writeln!(f, "[{}] {}", iso_from_ms(now_ms()), line);
    }
}

fn bootstrap(app: &tauri::AppHandle) -> Result<(), String> {
    eprintln!("[piweb-app] bootstrap: 开始");
    let raw_resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?;
    // Tauri 在 Windows 返回 verbatim 前缀路径（两个反斜杠+问号）；子进程 cwd 不接受该前缀（os error 123）
    let resource_dir = PathBuf::from(strip_verbatim(&raw_resource_dir.to_string_lossy()));
    let payload = find_payload_dir(&resource_dir)?;
    eprintln!("[piweb-app] payload = {}", payload.display());

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
        // 纯净版标记：pi-web instrumentation 见此值即完全跳过 romctl/GBA 自动拉起
        ("GBA_STUDIO", "0".to_string()),
    ];
    // Git Bash 的 bash.exe 启动时检查 <gitbash根>/tmp 目录，缺失会每次 spawn bash 都打印
    // "could not find /tmp, please create!" 警告（与 TMP/TEMP 环境变量无关；详见 build-payload.mjs 同注释）。
    // 幂等创建，兜底覆盖旧版 payload 升级或用户误删的情况。
    let _ = fs::create_dir_all(payload.join("runtime").join("gitbash").join("tmp"));
    // 捆绑的 Git Bash usr/bin 前置到 PATH（bash 工具/子进程可解析 ls、grep 等；
    // msys2 运行时会自动把该 Windows 路径转换为 POSIX /usr/bin）
    let gitbash_bin = payload.join("runtime").join("gitbash").join("usr").join("bin");
    let new_path = format!("{};{}", gitbash_bin.display(), std::env::var("PATH").unwrap_or_default());
    let mut web_envs_owned: Vec<(&str, String)> = web_envs.iter().map(|(k, val)| (*k, val.clone())).collect();
    if gitbash_bin.exists() {
        web_envs_owned.push(("PATH", new_path));
    }
    let env_strs: Vec<(&str, &str)> = web_envs_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();

    // 就绪探测（分类判定）：连接/读写均设短超时（被拦截的端口 connect 可能永久悬挂）。
    // 每次尝试分三类：连接被拒（回环上瞬时失败）= 还没监听 = 只是冷启动慢 → 继续等；
    // 连接成功/悬挂但 HTTP 永不响应 = 安全软件拦回环特征（bind 成功 accept 被滤）→ 快速判定。
    // ⚠ 勿改回固定时限一票否决：捆绑 node 冷启动实测可达 ~10s（杀软逐个扫描 payload 内
    // 数千文件），8s 固定窗会把它误杀成 loopback-blocked（2026-10-01 实机：pi-web.log
    // 打出 Ready in 9.6s，探测窗却只有 8s → 好端端被杀树+冤枉落标，回退路径冷启动再付一遍）。
    let probe = |secs: u64| wait_http("127.0.0.1", 30141, "/", Duration::from_secs(secs));

    // 回退标记：捆绑 node.exe 是安装时新复制的 exe，部分安全软件（腾讯电脑管家等）会拦截其
    // 回环连接。仅当分类探测确认拦截特征（http-silent）或始终未就绪（not-ready）才落盘 →
    // 后续启动直接用系统 node；标记 7 天过期重试一次（AV 可能已放行；放行后自动清标）。
    let flag_path = data_dir.join("node-fallback.json");
    let flag_fresh = fs::read_to_string(&flag_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("ts").and_then(|t| t.as_u64()))
        .map(|ts| now_ms().saturating_sub(ts as u128) < 7 * 24 * 3600 * 1000)
        .unwrap_or(false);

    bootstrap_log(&data_dir, &format!("启动开始（bundled-node 回退标记: {flag_fresh}）"));
    eprintln!("[piweb-app] 拉起 pi-web …（bundled-node 回退标记: {flag_fresh}）");
    // 主窗口初始页为捆绑加载页（frontend-dist/index.html）—— 启动即显示，
    // 就绪后再 location.replace 到 30141；消除“点击后长时间无窗口”的感知。
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }

    let bundled_node = payload.join("runtime").join("node.exe");
    let sys_node = PathBuf::from("node");
    let mut web: Option<std::process::Child> = None;
    // 捆绑 node 失败原因（系统 node 也起不来时给出准确指引）
    let mut bundled_issue: Option<&'static str> = None;

    if !flag_fresh && bundled_node.exists() {
        // 1) 先用捆绑 node.exe（payload/runtime/node.exe）拉起；20s 内就绪则直接用
        //    （覆盖 ~10s 冷启动；拦截特征约 6s 即提前判定，不必等满）。
        let child = spawn_server(&bundled_node, &web_dir, web_args, &env_strs, "pi-web", &data_dir)?;
        match probe(20) {
            WaitOutcome::Ready => {
                let _ = fs::remove_file(&flag_path); // 捆绑 node 已恢复 → 清除回退标记
                web = Some(child);
            }
            outcome => {
                let reason = if matches!(outcome, WaitOutcome::Blocked) { "http-silent" } else { "not-ready" };
                eprintln!("[piweb-app] 捆绑 node 未就绪（{reason}），回退系统 node");
                kill_tree(child.id());
                bundled_issue = match outcome {
                    WaitOutcome::Blocked => Some("捆绑 node 被安全软件拦截（端口连得上但 HTTP 无响应）"),
                    _ => Some("捆绑 node 启动超时（20s 内未就绪）"),
                };
                let _ = fs::write(&flag_path, format!("{{\"ts\":{},\"reason\":\"{reason}\"}}", now_ms()));
            }
        }
    }
    if web.is_none() {
        // 2) 回退/直接使用系统 node（PATH）。
        match spawn_server(&sys_node, &web_dir, web_args, &env_strs, "pi-web-sysnode", &data_dir) {
            Ok(child) => {
                match probe(60) {
                    WaitOutcome::Ready => web = Some(child),
                    outcome => {
                        // ⚠ 不杀 server、不报错（2026-10-01 16:44 实机案例）：sysnode 日志
                        // Ready in 141ms，但 piweb-desktop（新装 exe）自身的探测连接被
                        // 安全软件拦截 → 旧逻辑把好端端的服务杀掉并弹错误窗。
                        // WebView（msedgewebview2，微软签名）不受拦，加载页的 no-cors
                        // 轮询会自愈并自动跳转 30141；此处只记录诊断日志。
                        let why = if matches!(outcome, WaitOutcome::Blocked) {
                            "HTTP 无响应（疑似安全软件拦截 piweb-desktop 自身的回环探测）"
                        } else {
                            "启动超时（多为冷启动过慢或 pi-web 启动失败，见 pi-web-sysnode.log）"
                        };
                        bootstrap_log(&data_dir, &format!("系统 node 探测未就绪（{why}）→ 交由加载页轮询自愈，不再杀服务"));
                        eprintln!("[piweb-app] 系统 node 探测未就绪（{why}）→ 加载页轮询自愈");
                    }
                }
            }
            Err(e) => {
                if let Some(issue) = bundled_issue {
                    return Err(format!("{issue}，且系统 node 启动失败：{e}\n提示：将安装目录加入安全软件白名单后重试"));
                }
                return Err(e);
            }
        }
    }
    // web 不再显式 drop：Child drop 只关句柄不杀进程，服务在 Job Object（kill-on-close）
    // 保护下随主进程退出整树终止
    if web.is_some() {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.eval("location.replace('http://127.0.0.1:30141/')");
            let _ = win.set_focus();
        }
    }
    // web == none：探测未通但服务可能活着 → 加载页持续轮询自愈，不弹错误窗
    bootstrap_log(&data_dir, "bootstrap 结束");
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
/// 纯净版只要求 pi-web 存在（GBA 版还要求 gba/romctl.js）
fn find_payload_dir(resource_dir: &Path) -> Result<PathBuf, String> {
    let candidates = [
        resource_dir.to_path_buf(),
        resource_dir.join("_up_"),
        resource_dir.join("_up_").join("_up_"),
        resource_dir.join("payload"),
    ];
    for c in &candidates {
        if c.join("pi-web").join("package.json").exists() {
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
    eprintln!("[piweb-app] {tag} 已启动 pid={} log={}", child.id(), log_path.display());
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

/// 单次探测结果
enum Attempt {
    Ready,   // HTTP 已响应
    Refused, // 连接被拒（回环上瞬时失败）= 还没监听，与拦截无关
    Silent,  // 连接成功/悬挂但无 HTTP 响应 = 安全软件拦回环特征
}

/// 就绪探测最终结论
enum WaitOutcome {
    Ready,
    Blocked, // 确认拦截特征（连续多次 Silent）
    Timeout, // 截止时间内始终未就绪（多为冷启动过慢或启动失败）
}

/// 单次探测分类（不做 TLS；目标均为 127.0.0.1）。连接/读写均设短超时：
/// 被拦截的端口 connect 可能永久悬挂，不设超时会拖慢整个启动判定。
fn probe_once(addr: &std::net::SocketAddr, path: &str) -> Attempt {
    match TcpStream::connect_timeout(addr, Duration::from_millis(1000)) {
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => Attempt::Refused,
        Err(_) => Attempt::Silent, // connect 悬挂（1s 超时）等其他错误 → 疑似拦截
        Ok(mut stream) => {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
            let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
            let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
            if stream.write_all(req.as_bytes()).is_err() {
                return Attempt::Silent;
            }
            let mut buf = [0u8; 64];
            let n = std::io::Read::read(&mut stream, &mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]);
            if head.starts_with("HTTP/1.0 200") || head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.1 30") {
                Attempt::Ready
            } else {
                Attempt::Silent // 连上但无/非 HTTP 响应
            }
        }
    }
}

/// 分类探测主循环：HTTP 就绪 → Ready；连续 3 次「连上无响应」→ Blocked 提前判定
/// （约 6s，快于旧的固定 8s）；连接被拒只说明还没监听，重置连击并继续等满窗口
/// （冷启动慢 ≠ 被拦截，2026-10-01 教训：Ready in 9.6s 被 8s 固定窗误杀）。
fn wait_http(host: &str, port: u16, path: &str, timeout: Duration) -> WaitOutcome {
    let Ok(addr) = format!("{host}:{port}").parse::<std::net::SocketAddr>() else {
        return WaitOutcome::Timeout;
    };
    let start = Instant::now();
    let mut silent_streak = 0u32;
    loop {
        if start.elapsed() > timeout {
            return WaitOutcome::Timeout;
        }
        match probe_once(&addr, path) {
            Attempt::Ready => return WaitOutcome::Ready,
            Attempt::Refused => silent_streak = 0,
            Attempt::Silent => {
                silent_streak += 1;
                if silent_streak >= 3 {
                    return WaitOutcome::Blocked;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// 首次运行：把 payload 内模板复制到 workspace/agent 目录（幂等：不覆盖已有文件）；
/// 升级时按模板指纹自动刷新 .pi/ 与未被改动的 AGENTS.md（见 refresh_workspace_templates）
fn init_workspace(payload: &Path, workspace_dir: &Path) -> Result<(), String> {
    let template = payload.join("workspace-template");
    if !template.exists() {
        return Err(format!("workspace 模板缺失: {}", template.display()));
    }
    copy_tree_if_absent(&template, workspace_dir)?;
    refresh_workspace_templates(&template, workspace_dir);
    Ok(())
}

/// 升级刷新：payload 模板带 .pi/.template-id 指纹（build-payload 写入：构建时间 +
/// .pi 子树 FNV-1a 指纹 + AGENTS.md 指纹）。指纹与工作区现存不一致 → 覆盖刷新 .pi/ 子树
/// （扩展/skill 随安装包更新，老用户不再拿旧版工具）；AGENTS.md 仅当工作区现存内容
/// 与上次应用的模板指纹一致（未被 agent/用户改过）时替换，改过则保留。用户数据
/// （projects/work/sessions）永远不碰。纯净版模板无 .pi/ → 无指纹 → 跳过刷新（行为同首建）。
fn refresh_workspace_templates(template: &Path, ws: &Path) {
    let tpl_id_path = template.join(".pi").join(".template-id");
    let Ok(new_id_raw) = fs::read_to_string(&tpl_id_path) else { return };
    let Ok(new_id) = serde_json::from_str::<serde_json::Value>(&new_id_raw) else { return };
    let ws_id_path = ws.join(".pi").join(".template-id");
    let old_id = fs::read_to_string(&ws_id_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or(serde_json::json!({}));

    // 1) .pi 子树：指纹不同 → 覆盖复制（新增/更新文件；不删除工作区自有文件，避免误伤自定义内容）
    let tpl_pi = new_id.get("pi").and_then(|v| v.as_str()).unwrap_or("");
    let old_pi = old_id.get("pi").and_then(|v| v.as_str()).unwrap_or("");
    if !tpl_pi.is_empty() && tpl_pi != old_pi {
        eprintln!("[piweb-app] workspace .pi 模板更新，刷新中…");
        if copy_tree_overwrite(&template.join(".pi"), &ws.join(".pi")).is_err() {
            eprintln!("[piweb-app] workspace .pi 刷新失败（保留旧版继续启动）");
        }
    }

    // 2) AGENTS.md：仅当未被改动（现存哈希 == 上次应用的模板哈希）时替换
    let tpl_agents = template.join("AGENTS.md");
    let ws_agents = ws.join("AGENTS.md");
    if tpl_agents.exists() {
        let applied = old_id.get("agentsMd").and_then(|v| v.as_str()).unwrap_or("");
        let cur = fs::read(&ws_agents).ok().map(|b| fnv1a64(&b));
        match cur {
            None => { let _ = fs::copy(&tpl_agents, &ws_agents); } // 首建（copy_tree_if_absent 已处理，双保险）
            Some(h) if !applied.is_empty() && &h == applied => { let _ = fs::copy(&tpl_agents, &ws_agents); }
            Some(_) => {} // 用户/agent 改过 → 保留
        }
    }

    let _ = fs::create_dir_all(ws.join(".pi"));
    let _ = fs::write(&ws_id_path, &new_id_raw);
}

/// FNV-1a 64 位（与 build-payload.mjs 的 fnv64 同算法，跨版本稳定）
fn fnv1a64(buf: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in buf {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

/// 递归复制（目标存在时覆盖 → 仅用于模板刷新，不用于用户数据）
fn copy_tree_overwrite(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in fs::read_dir(src).map_err(|e| format!("read_dir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            copy_tree_overwrite(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
        }
    }
    Ok(())
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
    // models.json：预置 ark plan 供应商（仅首次安装写入；升级/重装不覆盖用户已改的模型配置）
    let mtpl = payload.join("agent-template").join("models.json");
    let mdst = agent_dir.join("models.json");
    if mtpl.exists() && !mdst.exists() {
        fs::copy(&mtpl, &mdst).map_err(|e| e.to_string())?;
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

/// 写入初始会话（pi session v3 JSONL），新用户首次打开即有欢迎会话（纯净版：无 GBA 内容）
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
    let welcome_assistant = "欢迎使用 Pi Web 桌面版！这是 pi coding agent 的本地工作台：\n\n\
1. **左侧对话**：用自然语言让 agent 干活 —— 读改文件、跑命令、检索代码，过程与工具调用全程可见。\n\
2. **会话管理**：按项目分组浏览/恢复/重命名/导出会话；支持「新会话」独立分叉与「从此编辑」分支。\n\
3. **项目文件工具**：侧边栏浏览/上传项目文件、查看 Git diff、预览源码/Markdown/图片/PDF/DOCX。\n\
4. **终端**：内置工作区终端（右侧 Terminal 标签），agent 与你可以共用同一个 shell。\n\
5. **配置**：顶栏 设置 → Models 里配置模型供应商与 API key；Skills / Plugins 面板管理扩展能力。\n\
6. **首次使用**：推荐 OpenCode Go（注册即用，含 GLM 系列模型）：https://opencode.ai/go?ref=SWSEB5WEP6 ，注册后在 设置 → Models 里配置供应商与模型即可。\n\n\
试一试：让我列出当前工作区的文件并总结这个项目是做什么的吧！";

    let jsonl = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"{ts}\",\"cwd\":\"{cwd}\"}}\n\
{{\"type\":\"session_name\",\"id\":\"n1\",\"name\":\"{name}\",\"timestamp\":{ms}}}\n\
{{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":{ms},\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{u}\"}}],\"timestamp\":{ms}}}}}\n\
{{\"type\":\"message\",\"id\":\"m2\",\"parentId\":\"m1\",\"timestamp\":{ms},\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{a}\"}}],\"api\":\"local\",\"provider\":\"local\",\"model\":\"welcome\",\"usage\":{{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":0,\"cost\":{{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}}}},\"stopReason\":\"stop\",\"timestamp\":{ms}}}}}\n",
        id = id,
        ts = ts,
        cwd = escape_json(&cwd_str),
        name = escape_json("欢迎使用 Pi Web"),
        ms = now,
        u = escape_json(welcome_user),
        a = escape_json(welcome_assistant),
    );

    let file = sessions_dir.join(format!("{}_{}.jsonl", ts.replace([':', '.'], "-"), id));
    fs::write(&file, jsonl).map_err(|e| e.to_string())?;
    eprintln!("[piweb-app] 初始会话已创建: {}", file.display());
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
