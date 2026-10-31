; Pi Web 安装钩子（tauri.conf.json → bundle.windows.nsis.installerHooks 引用）
; 背景：客户端用 Job Object 退出即整树终止 sidecar（node pi-web）；本钩子兜底清理
; 旧版本留下的残留进程与错误布局目录（不影响 GBA Font Studio 等其它产品）。

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "清理 Pi Web 残留后台进程（防文件锁）…"
  ; 终止客户端本体（若在运行）
  nsExec::Exec `powershell.exe -NoProfile -Command "Get-Process piweb-desktop -ErrorAction SilentlyContinue | Stop-Process -Force"`
  ; 只终止路径位于本产品安装目录下的 node（不影响用户其它 node 进程）
  nsExec::Exec `powershell.exe -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -like '*Pi Web*' | Stop-Process -Force"`
  Sleep 800
  ; 旧版 resources 绝对路径 bug 装出的错误布局残留：<install>\_root_\<盘符>\…
  IfFileExists `$INSTDIR\_root_` 0 +2
    RMDir /r `$INSTDIR\_root_`
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 换版标后 Windows 图标缓存会让快捷方式/任务栏仍显示旧图标 —— 刷新之
  DetailPrint "刷新系统图标缓存…"
  nsExec::Exec `ie4uinit.exe -show`
  nsExec::Exec `ie4uinit.exe -ClearIconCache`
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'  ; SHCNE_ASSOCCHANGED
  DetailPrint "若任务栏固定图标仍为旧版：取消固定后重新固定，或重启资源管理器"
!macroend
