export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // 纯净 pi-web 变体（桌面端 app-pure）：GBA_STUDIO=0 → 完全不触碰 romctl/GBA 引擎
  if (process.env.GBA_STUDIO === "0") return;

  // Node-only：随服务自动拉起 romctl serve（GBA Studio 数据源），不进 Edge bundle
  const { ensureRomctlServe } = await import("@/lib/gba-serve");
  await ensureRomctlServe();
}
