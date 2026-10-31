# GBA Font Studio 桌面客户端（Tauri）

面向新用户的开箱即用客户端：内置 pi agent + pi-web 工作台 + GBA 模拟器引擎 +
中文字库/翻译技能（skill md）+ 扩展，首次启动自动在安装路径创建工作区与欢迎会话。

## 构建

```bash
cd app
npm install                      # @tauri-apps/cli
# 前置：pi-web 已执行 `npx next build`（Turbopack，勿用 --webpack，会 OOM）
node build-payload.mjs           # 组装 payload → D:\gbfp\payload（junction 挂回 src-tauri/payload；resources 用相对路径 payload/**/*）
npx tauri build                  # 产物: src-tauri/target/release/bundle/nsis/*-setup.exe
```

增量：`node build-payload.mjs --skip-node-modules --skip-next-build`（复用已有产物）。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `GBA_PAYLOAD_DIR` | `D:\gbfp` | payload 实体存放目录（须短路径，NSIS 限制 >260 字符源路径；注意 resources 必须写相对路径 `payload/**/*`，绝对路径会装成 `_root_/<盘符路径>` 嵌套布局导致探测失败） |

## 安装后布局（currentUser 模式，默认 %LOCALAPPDATA%\Programs\GBA Font Studio）

```
<安装目录>/
├─ gba-font-studio.exe
└─ payload/                    引擎与运行时（升级时整体替换，勿放个人数据）
   ├─ pi-web/  gba/  runtime/node.exe
   └─ workspace-template/  agent-template/
└─ data/                       ★ 首启自动创建（用户数据，升级不覆盖）
   ├─ workspace/               ← agent 的工作区：AGENTS.md、.pi/skills、.pi/extensions、
   │                             roms/（放 ROM）、projects/（翻译工程，与 ROM 绑定）、work/（流水线产物）
   │                             升级时 .pi/ 模板按指纹自动刷新；AGENTS.md 未被改动则同步更新，
   │                             改过则保留；roms/projects/work 永不触碰
   ├─ agent/                   ← PI_CODING_AGENT_DIR：sessions/（含初始欢迎会话）、设置与凭证
   └─ logs/                    pi-web.log / romctl 日志 / bootstrap.log（客户端启动诊断）
```

## 运行

双击 exe → 先显示捆绑加载页（启动即出窗口）→ 自动拉起 pi-web(:30141) 与 romctl serve(:8645)
→ 加载页轮询到 pi-web 就绪后自动进入工作台。
（或浏览器打开 http://127.0.0.1:30141 —— 与窗口内容一致。）

新用户三步：
1. 设置 → Models 配置模型（如 OpenCode Go / API Key）；
2. 把 ROM 放进 `data/workspace/roms/`（或工作台「📂 打开 ROM」选任意位置）；
3. 对 agent 说「加载 roms/xxx.gba 截图看看画面」。

## 故障排查

- **升级安装报 `Error opening file for writing`**（锁的是 payload 内文件）：旧版本退出时残留的
  后台 node（pi-web/romctl serve）锁住了文件。1.0.1 起已双重修复：客户端退出即整树终止
  （Job Object），安装器安装前自动清理残留。手动救急：任务管理器结束路径位于安装目录
  `payload\runtime\` 下的 node.exe（不要杀其它 node），或安装弹窗点 Retry。
- **安全软件拦截**（腾讯电脑管家等会拦截“新复制的 exe”的回环连接：端口 LISTEN 但 HTTP 无响应）：
  客户端已内置自愈——捆绑 node 无响应时自动杀进程树并回退系统 node；若连客户端自身的探测
  连接也被拦，加载页会继续轮询并自动进入工作台（不再杀服务、不再弹错误窗）。
  建议把安装目录加入安全软件信任区。
- **bash 工具警告 `could not find /tmp, please create!`**：Git for Windows 的 bash.exe 启动时检查
  `<gitbash根>/tmp` 目录（与 `TMP`/`TEMP` 环境变量无关）。客户端已在打包时（build-payload）与
  首启时（bootstrap 幂等创建）自动建好 `payload/runtime/gitbash/tmp/`；若手动精简过 payload，
  重建该空目录即可消除。
- 日志：`data/logs/pi-web.log`、`data/logs/romctl.log`；客户端自身的启动流程与回退决策在
  `data/logs/bootstrap.log`（release 无控制台，eprintln 不可见，排障看这个）。
- 换 ROM / 工程定位：翻译工程在 `data/workspace/projects/<工程名>`（与具体 ROM 绑定，按需创建）。
