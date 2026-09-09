# GBA Font Studio — 工作台前端（pi-web 同源托管）

由 pi-web 的 `public/` 直接托管（不再是 romctl serve 的 iframe 外部页面）：
- 游戏画面/流水线/回放/码表/审校 五面板，与 pi-web 亮/暗主题自动对齐
  （StudioPanel 在 iframe 加载与主题切换时 postMessage 注入宿主 CSS 变量）。
- 数据后端是 `../gba/romctl.js serve`（默认 :8645，跨源访问；serve 端已全量开 CORS）。
  嵌入部署通过 `?api=http://127.0.0.1:8645` 指定 API base；独立部署（同源）不带参数即可。
- ROM 加载：顶栏「📂 打开 ROM」对话框（盘符→目录→.gba，确认后经 /load 加载），
  agent 侧用 rom_load 工具（gba/roms 相对路径或绝对路径均可）。

启动：pi-web 目录 `npx next dev -p 30141`（instrumentation 自动拉起 romctl serve），
pi-web 右侧「GBA」tab 打开；测试见 `test/README.md`。
