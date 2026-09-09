"use client";

/**
 * StudioPanel — GBA Font Studio 工作台嵌入面板
 *
 * 通过 iframe 内嵌 romctl serve 同源托管的 studio 页面（游戏画面 / 流水线看板 /
 * 会话回放 / 码表字模 / 翻译审校），并轮询 serve /status 显示连接状态。
 * serve 未运行时给出启动指引。
 * 主题对齐：iframe 加载后把宿主 pi-web 的 CSS 变量计算值 postMessage 注入
 * （gba-theme），studio 页面据此覆盖默认暗色 —— 亮/暗主题自动跟随。
 */
import { useCallback, useEffect, useRef, useState } from "react";

const PORT_KEY = "gba-studio.port";
const THEME_VARS = [
	"--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--tool-bg", "--border",
	"--text", "--text-muted", "--text-dim", "--accent", "--accent-hover", "--bg-subtle",
];

export function StudioPanel({ active }: { active: boolean }) {
	const [port, setPort] = useState("8645");
	const [serveUp, setServeUp] = useState<boolean | null>(null);
	const [serveInfo, setServeInfo] = useState<{ rom: string; frames: number } | null>(null);
	const [busy, setBusy] = useState(false); // serve 单线程：agent 长操作阻塞事件循环 → 探活超时 ≠ 掉线
	const failRef = useRef(0);
	const [nonce, setNonce] = useState(0); // 重连时强制 iframe 重载
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const frameRef = useRef<HTMLIFrameElement | null>(null);

	const poll = useCallback(async (p: string) => {
		try {
			const res = await fetch(`http://127.0.0.1:${p}/status`, { signal: AbortSignal.timeout(2500) });
			if (res.ok) {
				failRef.current = 0;
				setBusy(false);
				setServeUp(true);
				const j = await res.json().catch(() => null) as { ok?: boolean; rom?: string; frames?: number } | null;
				setServeInfo(j && j.ok ? { rom: j.rom ? String(j.rom).split(/[\\/]/).pop() || "" : "", frames: j.frames ?? 0 } : null);
			} else {
				failRef.current += 1;
				setBusy(true); // 非 200：多为长操作排队，暂按繁忙
				if (failRef.current >= 3) setServeUp(false);
			}
		} catch (e) {
			const timedOut = (e as { name?: string })?.name === "TimeoutError";
			failRef.current += 1;
			if (timedOut && failRef.current < 3) {
				setBusy(true); // 超时多为 serve 忙碌（agent rom_run 等），不掉线
			} else {
				setBusy(false);
				setServeUp(false);
				setServeInfo(null);
			}
		}
	}, []);

	useEffect(() => {
		try {
			const saved = localStorage.getItem(PORT_KEY);
			if (saved) setPort(saved);
		} catch { /* ignore */ }
	}, []);

	useEffect(() => {
		if (!active) return; // 非激活面板暂停轮询
		void poll(port);
		if (timerRef.current) clearInterval(timerRef.current);
		timerRef.current = setInterval(() => void poll(port), 3000);
		return () => { if (timerRef.current) clearInterval(timerRef.current); };
	}, [active, port, poll, nonce]);

	// 主题对齐：把宿主计算样式注入 iframe（加载后 + 主题切换时）
	const postTheme = useCallback(() => {
		const win = frameRef.current?.contentWindow;
		if (!win) return;
		const cs = getComputedStyle(document.documentElement);
		const vars: Record<string, string> = {};
		for (const name of THEME_VARS) {
			const v = cs.getPropertyValue(name).trim();
			if (v) vars[name] = v;
		}
		win.postMessage({ t: "gba-theme", vars }, "*");
	}, []);
	useEffect(() => {
		const observer = new MutationObserver(postTheme); // pi-web 切主题 = html.classList 变化
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, [postTheme]);

	const changePort = (value: string) => {
		const p = value.replace(/\D/g, "").slice(0, 5) || "8645";
		setPort(p);
		try { localStorage.setItem(PORT_KEY, p); } catch { /* ignore */ }
		setNonce((n) => n + 1);
	};

	return (
		<div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
			<div style={{
				display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
				padding: "4px 10px", borderBottom: "1px solid var(--border)", fontSize: 12,
			}}>
				<span style={{ fontWeight: 600 }}>GBA 工作台</span>
				<span style={{ color: serveUp ? "var(--accent)" : "var(--text-dim)" }}>
					{serveUp === null ? "检测中…" : serveUp
					? busy
						? `● 繁忙（agent 执行中，完成即恢复）${serveInfo ? ` · ${serveInfo.rom || ""} · 帧 ${serveInfo.frames}` : ""}`
						: `● 已连接 :${port}${serveInfo ? ` · ${serveInfo.rom || "未加载 ROM"} · 帧 ${serveInfo.frames}` : ""}`
					: "● serve 未连接（工作台只读，无法加载 ROM）"}
				</span>
				<label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, color: "var(--text-dim)" }}>
					端口
					<input
						value={port}
						onChange={(e) => changePort(e.target.value)}
						style={{ width: 64, padding: "2px 6px", background: "var(--bg-selected)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, fontSize: 12 }}
					/>
				</label>
				<button
					type="button"
					onClick={() => { void poll(port); setNonce((n) => n + 1); }}
					style={{ padding: "3px 10px", background: "var(--bg-selected)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
				>
					重连
				</button>
			</div>
			{serveUp ? (
				<iframe
					key={`${port}:${nonce}`}
					ref={frameRef}
					src={`/gba-studio/index.html?api=http://127.0.0.1:${port}`}
					title="GBA Font Studio"
					onLoad={postTheme}
					style={{ flex: 1, width: "100%", border: "none", background: "var(--bg)" }}
					allow="clipboard-write"
				/>
			) : (
				<div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--text-dim)", fontSize: 13, padding: 24, textAlign: "center" }}>
					<div>需要先启动 romctl 调试服务器（GBA Font Studio 由它同源托管）：</div>
					<code style={{ background: "var(--bg-selected)", color: "var(--text)", padding: "8px 14px", borderRadius: 6, fontSize: 13 }}>
						node romctl.js serve
					</code>
					<div style={{ fontSize: 12 }}>
						在 gbajs2 仓库根目录运行（默认端口 8645），然后点「重连」。<br />
						正常经 pi-web 启动时会自动拉起，无需手动操作。
					</div>
				</div>
			)}
		</div>
	);
}
