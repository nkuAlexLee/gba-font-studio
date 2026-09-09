import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

/* ==================== GBA Studio：随 pi-web 自动拉起 romctl serve ====================
 * 一个命令启动全套：`npx next dev` / `next start` 时自动在 gbajs2 仓库根拉起
 * `node romctl.js serve`（模拟器 + Studio 数据源，默认 :8645）。
 * 环境变量：
 *   GBA_STUDIO_DIR   引擎目录（默认本仓库 gba/，即自包含运行时）
 *   GBA_SERVE_PORT   serve 端口（默认 8645，与 StudioPanel 默认端口一致）
 * 若端口已有 serve 在跑则不重复启动；pi-web 进程退出时连带回收子进程。
 *
 * 仅从 instrumentation.ts 的 nodejs 运行时分支动态导入（不进 Edge bundle）。
 */
const GBA_DIR = path.resolve(process.cwd(), process.env.GBA_STUDIO_DIR ?? "gba");
const GBA_PORT = process.env.GBA_SERVE_PORT ?? "8645";

export async function ensureRomctlServe(): Promise<void> {
  if (!fs.existsSync(path.join(GBA_DIR, "romctl.js"))) {
    console.log(`[gba] 未找到 ${GBA_DIR}\\romctl.js，跳过 GBA Studio 自动启动（用 GBA_STUDIO_DIR 指定仓库根）`);
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${GBA_PORT}/status`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      console.log(`[gba] romctl serve :${GBA_PORT} 已在运行，不重复启动`);
      return;
    }
  } catch { /* 端口无响应 → 需要启动 */ }

  const child = spawn(process.execPath, ["romctl.js", "serve", GBA_PORT], {
    cwd: GBA_DIR,
    stdio: "inherit", // romctl 日志直通当前终端
    windowsHide: true, // 不弹 cmd 黑框
    env: { ...process.env, ROMCTL_NO_OPEN: "1" }, // 不自动弹 memview 浏览器窗口
  });
  console.log(`[gba] romctl serve :${GBA_PORT} 已随 pi-web 启动 (pid ${child.pid})`);
  console.log(`[gba] Studio 工作台: http://127.0.0.1:${GBA_PORT}/studio/index.html （pi-web 右侧「GBA」tab 可直接打开）`);
  child.on("exit", (code) => console.log(`[gba] romctl serve 退出 (${code})`));

  const kill = () => { try { child.kill(); } catch { /* ignore */ } };
  process.once("exit", kill);
  process.once("SIGINT", kill);
  process.once("SIGTERM", kill);
}
