// release 构建：无控制台窗口（黑框）；debug 构建保留控制台便于看日志
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    piweb_desktop_lib::run();
}
