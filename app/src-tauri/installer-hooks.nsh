; GBA Font Studio 安装钩子（tauri.conf.json → bundle.windows.nsis.installerHooks 引用）
; 背景：1.0.0 及以前，客户端退出时不终止 sidecar（node pi-web / romctl serve），残留进程
; 会锁住 payload 内文件，导致升级安装报 "Error opening file for writing"（2026-09-10 教训）。
; 1.0.1 起客户端用 Job Object 退出即整树终止；本钩子兜底清理旧版本留下的残留与错误布局目录。

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "清理 GBA Font Studio 残留后台进程（防文件锁）…"
  ; 终止客户端本体（若在运行）
  nsExec::Exec `powershell.exe -NoProfile -Command "Get-Process gba-font-studio -ErrorAction SilentlyContinue | Stop-Process -Force"`
  ; 只终止路径位于本产品安装目录下的 node（不影响用户其它 node 进程）
  nsExec::Exec `powershell.exe -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -like '*GBA Font Studio*' | Stop-Process -Force"`
  Sleep 800
  ; 旧版 resources 绝对路径 bug 装出的错误布局残留：<install>\_root_\<盘符>\…
  IfFileExists `$INSTDIR\_root_` 0 +2
    RMDir /r `$INSTDIR\_root_`
!macroend
