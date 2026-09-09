# pi-web 测试（GBA 工作台）

| 脚本 | 内容 | 前置 |
|------|------|------|
| `node test/gba-workbench-test.mjs` | gba/ 引擎 serve + public/gba-studio 五面板浏览器冒烟（画面居中/主题/回放/字模/审校） | 无（自起进程） |
| `node test/piweb-integration-test.mjs` | 端到端：`next dev` 单命令自动拉起 romctl → 面板主题对齐 → ROM 对话框实际加载 | playwright |
