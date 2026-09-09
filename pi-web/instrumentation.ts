export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Node-only：随服务自动拉起 romctl serve（GBA Studio 数据源），不进 Edge bundle
  const { ensureRomctlServe } = await import("@/lib/gba-serve");
  await ensureRomctlServe();
}
