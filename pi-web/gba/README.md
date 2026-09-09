# gba/ — GBA 字库/翻译引擎（自包含运行时）

本目录是 pi-web 的 GBA 工作台后端，**不依赖外部仓库**（2026-09-08 从 gbajs2 迁移）。

```
gba/
├─ romctl.js          无头调试引擎（serve 模式 = 工作台数据后端，:8645）
├─ js/ resources/     gbajs2 模拟器核心 + BIOS + 反汇编器
├─ memview.html       内存/画面监视页（serve 同源托管）
├─ assets/            码表（wholewords/charmap-base）、11x11 中文字库
├─ scripts/           翻译流水线脚本（validate / insert-strings / export … + lib/）
├─ translation-er/    翻译工程（project.json 已指向本目录； EliteRedux 全量 3.4 万行）
├─ roms/              ROM（pker 测试卡 + 红龙字库版；其他 ROM 用工作台「📂 打开 ROM」任意路径加载）
└─ work/              流水线运行产物（pipeline.json / 报告 / 回填日志）
```

由 pi-web 启动时自动拉起（`instrumentation.ts` → `lib/gba-serve.ts`，`ROMCTL_NO_OPEN=1`），
也可手动：`node gba/romctl.js serve`。

pi 扩展在 `../.pi/extensions/gba-fontpatch.ts`（rom_*/pipeline_*/font_*/text_* 18 个工具），
工作台前端在 `../public/gba-studio/`（pi-web 同源托管，`?api=` 指向本 serve 的跨源数据端点）。
