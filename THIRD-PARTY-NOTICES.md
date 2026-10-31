# 第三方组件与许可声明（THIRD-PARTY NOTICES）

GBA Font Studio 安装包捆绑了以下第三方组件。分发时必须保留本声明；
各组件以其上游许可为准，本文件仅作索引，不替代各组件完整许可文本。

| 组件 | 在安装包中的位置 | 许可 | 上游 |
|---|---|---|---|
| gbajs2 模拟器引擎（GBA.js / gbajs2 衍生） | `payload/gba/` | BSD-3-Clause（全文随附 `payload/gba/LICENSE`） | github.com/endrift/gbajs · github.com/andychase/gbajs2 |
| Node.js 运行时 | `payload/runtime/node.exe` | MIT（Node 捆绑的第三方组件见其随附许可文档） | nodejs.org |
| Git for Windows（bash 工具，仅 usr/bin） | `payload/runtime/gitbash/` | Git 本体 GPLv2；其捆绑的 MSYS2 运行时 msys-2.0.dll 为 GPLv3 | gitforwindows.org · msys2.org |
| pi agent 内核 `@earendil-works/pi-coding-agent` | `payload/pi-web/node_modules/` | MIT（以 npm 包内 LICENSE 为准） | npm: @earendil-works/pi-coding-agent |
| Next.js 及 pi-web 其余 npm 依赖 | `payload/pi-web/` | 以各自包内 LICENSE 为准（Next.js 为 MIT） | nextjs.org |

## 本项目自研部分

- pi-web 工作台（`@agegr/pi-web`）：MIT。
- gba 领域扩展、romctl 增量、skill/案例文档、Tauri 客户端 bootstrap：
  © 本项目作者，许可以仓库根声明为准。

## GPL 再分发提示

Git Bash（usr/bin）与 msys-2.0.dll 按 GPLv2/GPLv3 再分发，对应源码可从
上游官方渠道免费获取；发行时如需随附源码或书面获取 offer（GPLv2/GPLv3
第 3 条），请遵照相应条款执行。
