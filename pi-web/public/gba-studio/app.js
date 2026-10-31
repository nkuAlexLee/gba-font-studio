/* GBA Font Studio — 前端逻辑（无依赖，romctl serve 同源）
 * 面板：模拟器(WS推帧) / 流水线看板 / 会话回放 / 码表字模 / 翻译审校
 * 数据端点全部来自 romctl serve（/status /play /shot.png /pipeline /sessions
 * /session /review /insert /tmpfile /workfile 及静态文件）。
 */
'use strict';
(function () {
	// API base：由 pi-web 托管时通过 ?api= 指向 romctl serve（跨源，serve 端已开 CORS）；独立部署时空 = 同源
	// API 基址：显式 ?api= 优先（StudioPanel 注入）；缺省走同源 /gba-api 代理（pi-web rewrite → romctl serve）
	// API 基址：显式 ?api= 优先（StudioPanel 注入）；缺省先走 /gba-api 代理（HTTP 可用），
	// 再异步经 /gba-port 解析出绝对地址（WebSocket 只能直连 serve，代理不转发 upgrade）
	let API = (new URLSearchParams(location.search).get('api') ?? '/gba-api').replace(/\/$/, '');
	if (!new URLSearchParams(location.search).get('api')) {
		fetch('/gba-port').then((r) => r.json()).then((j) => {
			API = 'http://127.0.0.1:' + (j.port || '8645');
			if (WS) { try { WS.close(); } catch (e) {} WS = null; }
			wsConnect();
		}).catch(() => { /* 保持在 /gba-api 代理（无实时帧，仅 HTTP 可用） */ });
	}
	const $ = (id) => document.getElementById(id);
	const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	async function jget(url) {
		const r = await fetch(url);
		const ct = r.headers.get('content-type') || '';
		if (!ct.includes('json')) throw new Error('romctl serve 无响应（收到 HTML，' + r.status + '）— serve 可能已退出：请确认 GBA Font Studio 应用在运行（被关闭会连带停止 serve），或从工作台「GBA」标签点「重连」');
		const j = await r.json();
		if (!j.ok) throw new Error(j.error || r.status);
		return j;
	}

	/* ================= Tabs ================= */
	for (const btn of document.querySelectorAll('#tabs .tab')) {
		btn.addEventListener('click', () => {
			document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
			document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + btn.dataset.tab));
			if (btn.dataset.tab === 'pipeline') refreshPipeline();
			if (btn.dataset.tab === 'replay' && !replay.loaded) loadSessionList();
			if (btn.dataset.tab === 'charmap') charmap.ensure();
			if (btn.dataset.tab === 'review') review.ensure();
		});
	}

	/* ================= 顶栏状态 ================= */
	let lastStatus = null;
	// 模拟倍速：功能栏按钮循环 1x→2x→3x→1x（初始 1x；/status 轮询回显 serve 端状态）
	let emuSpeed = 1;
	const applySpeedLabel = () => { $('speedBtn').textContent = emuSpeed + 'x'; };
	async function pollStatus() {
		try {
			lastStatus = await jget(API + '/status');
			const s = lastStatus;
			// 重新加载按钮：有 ROM 才可用（以 /status 的完整路径重发 /load）
			$('reloadRomBtn').disabled = !(s && s.rom);
			// 倍速同步：serve 端被外部改过（如另一面板/CLI）时回显
			if (s && s.speed && s.speed !== emuSpeed) { emuSpeed = s.speed; applySpeedLabel(); }
			$('reloadRomBtn').disabled = !(s && s.rom);
			// ROM/帧信息已移至 pi-web 工作台「GBA」面板连接行；此处只保留 serve 版本与 hook 状态
			const bits = []; // ROM/帧/版本已移至 pi-web 连接行
			// hooks 通知不再进顶栏（该行只放功能按钮）；hook 流仍实时推送到模拟器面板
			$('statusLine').textContent = bits.length ? bits.join('   ') : '';
		} catch (e) {
			$('statusLine').textContent = 'serve 未连接：先运行 node romctl.js serve（' + e.message + '）';
		}
	}
	setInterval(pollStatus, 2000);
	pollStatus();
	// serve 托管的页面链接指向 API base（memview / work/）
	for (const a of document.querySelectorAll('#topbar .links a')) {
		const path = a.getAttribute('href');
		if (path && path.startsWith('/')) a.href = API + path;
	}

	/* ================= 主题注入（pi-web StudioPanel postMessage） ================= */
	window.addEventListener('message', (ev) => {
		const d = ev.data || {};
		if (d.t === 'gba-theme' && d.vars) {
			for (const [k, v] of Object.entries(d.vars)) {
				if (typeof k === 'string' && k.startsWith('--') && typeof v === 'string') document.documentElement.style.setProperty(k, v);
			}
		}
		if (d.t === 'gba-open-rom') openRomBrowser();
	});

	/* ================= ROM 浏览对话框（/browse + /load） ================= */
	const ROM_DIR_KEY = 'gba-studio.romDir'; // 记住上次打开的文件夹（localStorage 持久化）
	function savedRomDir() { try { return localStorage.getItem(ROM_DIR_KEY) || ''; } catch { return ''; } }
	function rememberRomDir(d) { try { localStorage.setItem(ROM_DIR_KEY, d || ''); } catch { /* ignore */ } }
	function openRomBrowser() {
		$('romModal').hidden = false;
		// 上次打开的文件夹优先；目录已失效时 renderRomList 内部自动回退盘符根
		renderRomList(savedRomDir());
	}
	function closeRomBrowser() { $('romModal').hidden = true; }
	$('openRomBtn').addEventListener('click', openRomBrowser);
	$('romCloseBtn').addEventListener('click', closeRomBrowser);
	$('romModal').addEventListener('click', (ev) => { if (ev.target === $('romModal')) closeRomBrowser(); });

	/* 重新加载当前 ROM：以 /status 返回的完整路径重发 /load（重置状态与 hook） */
	$('reloadRomBtn').addEventListener('click', async () => {
		const romPath = (lastStatus || {}).rom || '';
		if (!romPath) return;
		if (!confirm('重新加载 ' + romPath + '？\n会重置模拟器状态与 hook（可用快照恢复）。')) return;
		const btn = $('reloadRomBtn');
		btn.disabled = true;
		try {
			await jget(API + '/load?rom=' + encodeURIComponent(romPath));
		} catch (e) { alert('重新加载失败: ' + e.message); }
		pollStatus();
		btn.disabled = false;
	});
	async function renderRomList(dir) {
		const list = $('romList');
		list.innerHTML = '<div class="empty">加载中…</div>';
		try {
			const j = dir ? await jget(API + '/browse?dir=' + encodeURIComponent(dir)) : await jget(API + '/browse');
			rememberRomDir(j.isRoot ? '' : j.dir); // 浏览过的目录都记住，下次对话框从这里开始
			const sep = j.dir && (j.dir.endsWith('\\') || j.dir.endsWith('/')) ? '' : '\\';
			const childDir = (e) => j.isRoot ? e.name : (j.dir + sep + e.name); // 根列表的条目名已是完整盘符
			$('romCurDir').textContent = j.isRoot ? '（选择盘符）' : j.dir;
			list.innerHTML = (j.parent !== null && j.parent !== undefined
				? `<div class="rom-row" data-dir="${esc(j.parent)}"><span class="rom-name">📁 ..</span></div>` : '') +
				j.entries.map((e) => e.type === 'dir'
					? `<div class="rom-row" data-dir="${esc(childDir(e))}"><span class="rom-name">📁 ${esc(e.name)}</span></div>`
					: `<div class="rom-row" data-rom="${esc(childDir(e))}"><span class="rom-name">🎮 ${esc(e.name)}</span><span class="hint">${(e.size / 1024 / 1024).toFixed(1)}MB</span><button class="rom-load">加载</button></div>`
				).join('') || '<div class="empty">（空目录）</div>';
			for (const row of list.querySelectorAll('.rom-row[data-dir]')) {
				row.addEventListener('click', () => renderRomList(row.dataset.dir));
			}
			for (const btn of list.querySelectorAll('.rom-load')) {
				btn.addEventListener('click', async (ev) => {
					ev.stopPropagation();
					const romPath = btn.closest('.rom-row').dataset.rom;
					if (!confirm('加载 ' + romPath + '？\n会重置模拟器状态与 hook（可用快照恢复）。')) return;
					try {
						await jget(API + '/load?rom=' + encodeURIComponent(romPath));
						rememberRomDir(romPath.slice(0, Math.max(romPath.lastIndexOf('\\'), romPath.lastIndexOf('/')))); // 加载成功 → 记住所在文件夹
						closeRomBrowser();
						pollStatus();
					} catch (e) { alert('加载失败: ' + e.message); }
				});
			}
		} catch (e) {
			if (dir) { // 上次记忆的目录可能已不存在 → 回退盘符根（仅回退一次，避免死循环）
				rememberRomDir('');
				return renderRomList('');
			}
			list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
		}
	}

	/* ================= 面板 1: 模拟器 ================= */
	let WS = null, playing = true, wsRetryTimer = null; // 默认自动播放：ROM 加载后即订阅帧流
	const wsBase = API ? API.replace(/^http/, 'ws') : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
	function wsConnect() {
		if (WS) return;
		try { WS = new WebSocket(wsBase + '/ws'); } catch (e) { return; }
		WS.binaryType = 'arraybuffer';
		WS.onopen = () => { WS.send(JSON.stringify({ t: 'hello' })); if (playing) WS.send(JSON.stringify({ t: 'play', on: 1 })); };
		WS.onmessage = (ev) => {
			if (typeof ev.data === 'string') { const m = JSON.parse(ev.data); if (m.t === 'hook') hookFeed(m.events); return; }
			wsOnBinary(ev.data);
		};
		WS.onclose = () => { WS = null; if (playing) { clearTimeout(wsRetryTimer); wsRetryTimer = setTimeout(wsConnect, 2000); } };
		WS.onerror = () => { try { WS.close(); } catch (e) { /* ignore */ } };
	}
	function wsOnBinary(ab) {
		if (ab.byteLength < 4) return;
		const dv = new DataView(ab);
		if (dv.getUint8(0) !== 1) return; // 1=BMP 帧
		const cv = $('screen'), ctx = cv.getContext('2d');
		ctx.imageSmoothingEnabled = false;
		const blob = new Blob([ab.slice(4)], { type: 'image/bmp' });
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = function () { ctx.drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); };
		img.onerror = () => URL.revokeObjectURL(url);
		img.src = url;
	}
	wsConnect();

	$('playBtn').textContent = '⏸ 暂停'; // 默认自动播放
	$('playBtn').addEventListener('click', () => {
		playing = !playing;
		$('playBtn').textContent = playing ? '⏸ 暂停' : '▶ 连续播放';
		if (WS) WS.send(JSON.stringify({ t: 'play', on: playing ? 1 : 0 }));
	});
	$('stepBtn').addEventListener('click', () => jget(API + '/run?frames=1').then(pollStatus).catch((e) => alert(e.message)));
	$('run60Btn').addEventListener('click', () => jget(API + '/run?frames=60').then(pollStatus).catch((e) => alert(e.message)));
	// 模拟倍速：点击循环 1x → 2x → 3x → 1x（状态以 serve /speed 为准）
	$('speedBtn').addEventListener('click', async () => {
		const next = emuSpeed >= 3 ? 1 : emuSpeed + 1;
		applySpeedLabel();
		try { const r = await jget(API + '/speed?v=' + next); emuSpeed = r.speed || next; } catch (e) { /* serve 未连：仅本地标记 */ }
		applySpeedLabel();
	});
	$('shotBtn').addEventListener('click', async () => {
		try {
			const r = await fetch(API + '/shot.png?file=studio-manual.png');
			const blob = await r.blob();
			const url = URL.createObjectURL(blob);
			const img = new Image();
			img.onload = () => { $('screen').getContext('2d').drawImage(img, 0, 0, 240, 160); URL.revokeObjectURL(url); };
			img.src = url;
		} catch (e) { alert(e.message); }
	});
	// 按住式按键：pointerdown 按下 / pointerup 松开（与 memview 的 held 语义一致，经 WS /pad 生效）
	const padHeld = new Set();
	const padBtnByKey = {};
	for (const btn of document.querySelectorAll('.pad button[data-key]')) {
		padBtnByKey[btn.dataset.key] = btn;
		btn.addEventListener('pointerdown', (e) => { e.preventDefault(); padPress(btn.dataset.key); });
		btn.addEventListener('pointerup', () => padRelease(btn.dataset.key));
		btn.addEventListener('pointerleave', () => padRelease(btn.dataset.key));
		btn.addEventListener('contextmenu', (e) => e.preventDefault());
	}
	function padPress(key) {
		if (padHeld.has(key)) return;
		padHeld.add(key);
		const b = padBtnByKey[key]; if (b) { b.classList.add('hold'); b.blur(); }
		sendPad();
	}
	function padRelease(key) {
		if (!padHeld.delete(key)) return;
		const b = padBtnByKey[key]; if (b) b.classList.remove('hold');
		sendPad();
	}
	function sendPad() {
		const keys = [...padHeld];
		if (WS && WS.readyState === 1) { try { WS.send(JSON.stringify({ t: 'pad', keys })); return; } catch (e) {} }
		jget(API + '/pad?keys=' + encodeURIComponent(keys.join(','))).catch(() => {});
	}
	// 键盘 → 按键（模拟器面板激活时；输入框内不触发）
	const KB_KEYS = {
		KeyZ: 'A', KeyX: 'B', KeyM: 'START', KeyN: 'SELECT',
		ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', KeyA: 'L', KeyS: 'R',
	};
	window.addEventListener('keydown', (e) => {
		if (!document.getElementById('panel-screen').classList.contains('active')) return;
		const tag = (document.activeElement && document.activeElement.tagName) || '';
		if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
		const k = KB_KEYS[e.code];
		if (!k) return;
		e.preventDefault();
		if (!e.repeat) padPress(k); else padHeld.has(k) && e.preventDefault();
	});
	window.addEventListener('keyup', (e) => {
		const k = KB_KEYS[e.code];
		if (!k) return;
		padRelease(k);
	});
	window.addEventListener('blur', () => { [...padHeld].forEach(padRelease); });
	function hookFeed(events) {
		const bd = $('hookFeedBody');
		if (bd.textContent === '（无）') bd.textContent = '';
		for (const ev of events.slice(-8)) {
			const line = document.createElement('div');
			line.textContent = `f${ev.frame} ${ev.name || ''} ${Object.entries(ev).filter(([k]) => !['frame', 'name'].includes(k)).map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' ')}`.slice(0, 200);
			bd.prepend(line);
		}
		while (bd.children.length > 60) bd.lastChild.remove();
	}

	/* ================= 面板 2: 流水线看板 ================= */
	const STAGE_STATUS_CN = { pending: '待开始', running: '进行中', done: '已完成', blocked: '受阻' };
	function evLink(ev) {
		// 证据 → 链接：tmp/*.png|bmp → /tmpfile；work/*.md|log → /workfile；其余纯文本
		const m = String(ev);
		if (/^tmp[\\/].+\.(png|bmp)$/i.test(m)) return `<a href="${API}/tmpfile?name=${encodeURIComponent(m.replace(/^tmp[\\/]/, ''))}" target="_blank">🖼 ${esc(m.split(/[\\/]/).pop())}</a>`;
		if (/^work[\\/].+(md|log|txt)$/i.test(m)) return `<a href="${API}/workfile?name=${encodeURIComponent(m.replace(/^work[\\/]/, ''))}" target="_blank">📄 ${esc(m.split(/[\\/]/).pop())}</a>`;
		return `<span class="tl-chip" title="${esc(m)}">${esc(m)}</span>`;
	}
	async function refreshPipeline() {
		try {
			const { pipeline: p } = await jget(API + '/pipeline');
			const board = $('pipelineBoard');
			if (!p || !p.stages || !p.stages.length) { board.innerHTML = '<div class="empty">流水线为空 — 让 agent 调 pipeline_stage 工具记录阶段</div>'; return; }
			board.innerHTML = p.stages.map((s) => {
				const st = s.status || 'pending';
				return `<div class="stage-card" data-id="${esc(s.id)}">
					<div class="st-title"><span class="stage-jump" data-id="${esc(s.id)}" title="点击跳到回放面板对应事件" style="cursor:pointer;color:var(--accent)">${esc(s.name || s.id)}</span><span class="stage-badge ${st}">${STAGE_STATUS_CN[st] || st}</span></div>
					${s.progress !== undefined ? `<div class="stage-progress"><div style="width:${Math.round(s.progress * 100)}%"></div></div>` : ''}
					${s.evidence && s.evidence.length ? `<div class="stage-evidence">${s.evidence.map(evLink).join('')}</div>` : ''}
					${s.notes ? `<div class="stage-notes" title="${esc(s.notes)}">${esc(s.notes)}</div>` : ''}
					<div class="stage-notes">${esc(s.updated || '')}</div>
				</div>`;
			}).join('') + (p.rom ? `<div class="stage-card"><div class="st-title"><span>ROM</span></div><div class="stage-notes">${esc(p.rom)}</div>${p.base ? `<div class="stage-notes">基座: ${esc(p.base)}</div>` : ''}</div>` : '');
			// 看板 → 回放联动：点阶段名跳到回放面板并按阶段 id 过滤 gba.event
			for (const el of board.querySelectorAll('.stage-jump')) {
				el.addEventListener('click', () => {
					document.querySelector('[data-tab="replay"]').click();
					if (!replay.loaded) loadSessionList();
					$('replayFilter').value = el.dataset.id;
					if (replay.entries.length) renderReplay();
				});
			}
		} catch (e) {
			$('pipelineBoard').innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`;
		}
	}
	setInterval(() => { if (document.querySelector('#panel-pipeline.active')) refreshPipeline(); }, 2000);

	/* 导出 HTML 报告（P5）：流水线 + 证据链接 → 单文件 HTML 下载 */
	// 导出 HTML 报告功能已移除（原实现有 bug 且使用率低）


	/* ================= 面板 3: 会话回放 ================= */
	const replay = { loaded: false, file: null, entries: [] };
	async function loadSessionList() {
		try {
			const { sessions } = await jget(API + '/sessions');
			const el = $('sessionList');
			if (!sessions.length) { el.innerHTML = '<div class="empty">没有会话文件（~/.pi/agent/sessions）</div>'; return; }
			el.innerHTML = sessions.map((s) => `<div class="session-item" data-file="${esc(s.file)}">
				<div class="t">${esc(s.firstUser || '(空会话)')}</div>
				<div class="m">${esc(s.file.split('/')[0].replace(/^--|--$/g, ''))} · ${new Date(s.mtime).toLocaleString()} · ${(s.size / 1024).toFixed(0)}KB</div>
			</div>`).join('');
			for (const item of el.querySelectorAll('.session-item')) {
				item.addEventListener('click', () => loadReplay(item.dataset.file, item));
			}
		} catch (e) { $('sessionList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
	}
	async function loadReplay(file, itemEl) {
		try {
			const { entries } = await jget(API + '/pisession?file=' + encodeURIComponent(file));
			replay.file = file; replay.entries = entries; replay.loaded = true;
			document.querySelectorAll('.session-item').forEach((i) => i.classList.toggle('active', i === itemEl));
			renderReplay();
		} catch (e) { $('replayTimeline').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
	}
	function entryText(e) {
		if (e.content) return e.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
		return '';
	}
	function renderReplay() {
		const filter = $('replayFilter').value.trim().toLowerCase();
		const tl = $('replayTimeline');
		const msgs = replay.entries.filter((e) => {
			if (e.kind === 'session' || e.kind === 'session_name') return false;
			if (!filter) return true;
			const hay = JSON.stringify(e).toLowerCase();
			return hay.includes(filter);
		});
		$('replayMeta').textContent = `${replay.file} · ${msgs.length}/${replay.entries.length} 条`;
		tl.innerHTML = msgs.map((e) => {
			if (e.kind === 'custom') {
				const d = e.data || {};
				const isStage = d.kind === 'stage';
				return `<div class="tl-entry"><div class="tl-card custom gba"><div class="tl-head"><span class="role">gba.event</span><span class="tl-chip">${esc(d.kind || e.customType)}</span><span>${esc(d.id || '')}</span><span>${esc(iso(e.ts))}</span></div>
					<div class="tl-body">${isStage ? `<b>${esc(d.name || d.id)} → ${esc(d.status)}</b>` : `<code>${esc(JSON.stringify(d)).slice(0, 300)}</code>`}</div></div></div>`;
			}
			if (e.kind === 'branchSummary') return `<div class="tl-entry"><div class="tl-card"><div class="tl-head"><span class="role">分支摘要</span></div><div class="tl-body">${esc(e.summary)}</div></div></div>`;
			const role = e.role;
			if (role === 'user' || role === 'assistant') {
				const body = (e.content || []).map((c) => {
					if (c.type === 'text') return esc(c.text);
					if (c.type === 'thinking') return `<div class="collapsible thinking">💭 ${esc(c.text)}</div>`;
					if (c.type === 'toolCall') return `<div class="collapsible">🔧 <b>${esc(c.name)}</b> <span class="tl-args">${esc(JSON.stringify(c.arguments)).slice(0, 400)}</span></div>`;
					if (c.type === 'image') return `<span class="collapsible tl-chip">[图片 ${(c.len / 1024).toFixed(0)}KB]</span>`;
					return '';
				}).join('');
				const head = `${role === 'user' ? '👤 用户' : '🤖 ' + esc(e.model || 'assistant')}${e.usage ? ' · ' + e.usage.totalTokens + ' tok' : ''} · ${esc(iso(e.ts))}`;
				return `<div class="tl-entry"><div class="tl-card ${role}"><div class="tl-head" onclick="this.nextElementSibling.classList.toggle('collapsed')"><span class="role">${head}</span>${e.stopReason === 'error' ? '<span class="tl-error">✘ ' + esc(e.errorMessage || '') + '</span>' : ''}</div><div class="tl-body ${role === 'assistant' ? 'collapsed' : ''}">${body}</div></div></div>`;
			}
			if (role === 'toolResult') {
				const body = (e.content || []).map((c) => {
					if (c.type === 'text') return esc(c.text.length > 1500 ? c.text.slice(0, 1500) + '…[截]' : c.text);
					if (c.type === 'image') return `<span class="tl-chip">[图片 ${(c.len / 1024).toFixed(0)}KB — Studio 证据链接见流水线看板]</span>`;
					return '';
				}).join('');
				return `<div class="tl-entry"><div class="tl-card toolResult ${e.isError ? 'error' : ''}"><div class="tl-head" onclick="this.nextElementSibling.classList.toggle('collapsed')"><span class="role">${e.isError ? '✘' : '✔'} 工具结果</span><span class="tl-chip">${esc(e.toolName)}</span><span>${esc(iso(e.ts))}</span></div><div class="tl-body collapsed">${body}</div></div></div>`;
			}
			if (role === 'custom') {
				return `<div class="tl-entry"><div class="tl-card custom"><div class="tl-head"><span class="role">扩展消息</span><span class="tl-chip">${esc(e.customType)}</span></div><div class="tl-body">${esc(entryText(e)).slice(0, 500)}</div></div></div>`;
			}
			if (role === 'bashExecution') {
				return `<div class="tl-entry"><div class="tl-card toolResult"><div class="tl-head" onclick="this.nextElementSibling.classList.toggle('collapsed')"><span class="role">⌨ bash</span><span class="tl-args">${esc((e.command || '').slice(0, 120))}</span> exit=${esc(e.exitCode)}</div><div class="tl-body collapsed">${esc(entryText(e) || JSON.stringify(e.content || '')).slice(0, 800)}</div></div></div>`;
			}
			return '';
		}).join('') || '<div class="empty">无匹配条目</div>';
		tl.querySelectorAll('.tl-body.collapsed').forEach((b) => { if (b.scrollHeight <= b.clientHeight) b.classList.remove('collapsed'); });
	}
	$('replayFilter').addEventListener('input', () => renderReplay());
	const iso = (ts) => (ts ? new Date(typeof ts === 'number' ? ts : Date.parse(ts)).toLocaleTimeString() : '');

	/* ================= 面板 4: 码表/字模 ================= */
	const charmap = {
		ready: false, entries: [], fontBytes: null,
		async ensure() {
			if (this.ready) return;
			try {
				const [txt, fontBuf] = await Promise.all([
					fetch('assets/wholewords.txt').then((r) => r.text()),
					fetch('assets/gba_chs_font_11x11.bin').then((r) => r.arrayBuffer()),
				]);
				this.fontBytes = new Uint8Array(fontBuf);
				for (const line of txt.split('\n')) {
					const t = line.trim();
					if (!t || t.startsWith('/') || t.startsWith('#')) continue;
					const eq = t.indexOf('=');
					if (eq <= 0) continue;
					const hex = t.slice(0, eq).trim().toLowerCase();
					if (!/^[0-9a-f]{1,4}$/.test(hex)) continue;
					this.entries.push({ code: parseInt(hex, 16), hex, value: t.slice(eq + 1) });
				}
				this.ready = true;
				renderSlotMap();
				renderCharmap('');
				$('charmapStats').textContent = `${this.entries.length} 条 · 字库 ${(this.fontBytes.length / 1024).toFixed(0)}KB`;
			} catch (e) { $('charmapTable').innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`; }
		},
	};
	function renderCharmap(filter) {
		const f = filter.trim().toLowerCase();
		let hits = charmap.entries;
		if (f) {
			if (/^[0-9a-f]{1,4}$/.test(f)) hits = hits.filter((e) => e.hex.startsWith(f));
			else hits = hits.filter((e) => e.value.includes(filter.trim()));
		}
		hits = hits.slice(0, 500);
		$('charmapTable').innerHTML = hits.map((e) => `<div class="cm-row${e.code < 0x100 ? ' sbc' : ''}" data-code="${e.code}">
			<span class="code">0x${e.hex}</span><span class="glyph-ch">${esc(e.value.slice(0, 6))}</span>
			${e.code < 0x100
				? `<span class="raw">半角 · 原英文字库</span>`
				: `<span class="raw">${esc(e.value)} · 字模 #${GlyphFormat.glyphId(e.code)}</span>`}
		</div>`).join('') || '<div class="empty">无匹配</div>';
		for (const row of document.querySelectorAll('.cm-row')) row.addEventListener('click', () => showGlyph(+row.dataset.code, row));
	}
	$('charmapFilter').addEventListener('input', (ev) => { if (charmap.ready) renderCharmap(ev.target.value); });
	function drawMat(canvas, mat, w, h, scale, withGrid) {
		canvas.width = w * scale + 1; canvas.height = h * scale + 1;
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const v = mat[y * w + x];
			if (v === 1) { ctx.fillStyle = '#111'; ctx.fillRect(x * scale + 1, y * scale + 1, scale, scale); }
			else if (v === 2) { ctx.fillStyle = '#b8b8b8'; ctx.fillRect(x * scale + 1, y * scale + 1, scale, scale); }
		}
		if (withGrid) {
			ctx.strokeStyle = 'rgba(120,130,200,0.35)'; ctx.beginPath();
			for (let x = 0; x <= w; x++) { ctx.moveTo(x * scale + 1, 0); ctx.lineTo(x * scale + 1, canvas.height); }
			for (let y = 0; y <= h; y++) { ctx.moveTo(0, y * scale + 1); ctx.lineTo(canvas.width, y * scale + 1); }
			ctx.stroke();
		}
	}
	function showGlyph(code, rowEl) {
		document.querySelectorAll('.cm-row').forEach((r) => r.classList.toggle('active', r === rowEl));
		const entry = charmap.entries.find((e) => e.code === code);
		if (!entry) return;
		if (code < 0x100) {
			// 单字节 = 半角字符（ASCII/符号/数字），由游戏原英文小字库渲染，不在本 11x11 中文库
			$('glyphTitle').textContent = entry.value.slice(0, 6) + '  码 0x' + entry.hex + ' — 半角字符：由游戏原英文小字库渲染（不在 11x11 中文字库内）';
			for (const id of ['glyphCanvas', 'glyphGridCanvas']) { const c = $(id); c.style.display = 'none'; }
			return;
		}
		for (const id of ['glyphCanvas', 'glyphGridCanvas']) $(id).style.display = '';
		let mat;
		try { mat = GlyphFormat.decodeGlyph(charmap.fontBytes, code); } catch (e) { $('glyphTitle').textContent = '解码失败: ' + e.message; return; }
		const id = GlyphFormat.glyphId(code);
		const totalSlots = Math.floor(charmap.fontBytes.length / 16);
		const inRange = id < totalSlots;
		$('glyphTitle').textContent = `${entry.value.slice(0, 4)}  码 0x${entry.hex}  字模序号 #${id}（字节 ${id * 16}–${id * 16 + 15}）${inRange ? '' : ' — 超出 11x11 字库范围（控制码/非汉字，无字模）'}`;
		drawMat($('glyphCanvas'), mat.data, 11, 11, 16, true);
		drawMat($('glyphGridCanvas'), GlyphFormat.toGameGrid(mat.data).flat(), 16, 16, 15, true); // 1=墨 2=影
	}
	function renderSlotMap() {
		const occ = GlyphFormat.occupancy(charmap.fontBytes);
		const used = occ.reduce((a, b) => a + b, 0);
		const firstEmpty = occ.findIndex((v) => !v);
		const kb = (charmap.fontBytes.length / 1024).toFixed(0);
		// 纯文字信息：槽位图对排障意义有限，改为关键事实一行呈现
		$('slotStats').innerHTML =
			`字库 ${kb}KB · ${occ.length} 槽 × 16B（11x11 点阵）· <b>${used}/${occ.length}</b> 有字模` +
			(firstEmpty >= 0 ? ` · 首个空槽 #${firstEmpty}` : ' · 无空槽') +
			' · 双字节汉字专用（半角字符走游戏原英文小字库，不占槽）';
	}

	/* ================= 面板 5: 翻译审校 ================= */
	const review = { ready: false, project: null, scene: null, scenes: {}, dirty: false };
	async function ensureReview() {
		if (review.ready) return;
		try {
			// 工程动态发现：工程与 ROM 绑定、运行时创建；单工程自动选用，多工程出选择器
			const pj = await jget(API + '/projects');
			const list = pj.projects || [];
			const sel = $('reviewProjectSel');
			if (!list.length) { $('reviewTable').innerHTML = '<div class="empty">尚无翻译工程 —— 用 gba-text-translate skill 的 export-strings init 创建（工程名与 ROM 绑定，由 agent/用户指定）</div>'; return; }
			if (list.length > 1) {
				sel.hidden = false;
				sel.innerHTML = list.map((p) => `<option value="${esc(p.name)}">${esc(p.title || p.name)}</option>`).join('');
				sel.addEventListener('change', () => { review.ready = false; review.project = sel.value; ensureReview(); });
			}
			review.project = review.project || sel.value || list[0].name;
			await loadReview();
		} catch (e) { $('reviewTable').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
	}
	async function loadReview() {
		const data = await jget(API + '/review?project=' + encodeURIComponent(review.project));
		review.scenes = data.scenes;
		review.ready = true;
		$('reviewProject').textContent = `${data.project.name || review.project} → ${data.project.out_rom || ''}`;
		const sel = $('reviewScene');
		sel.innerHTML = Object.keys(data.scenes).map((s) => `<option>${esc(s)}</option>`).join('');
		if (!sel.dataset.bound) { sel.dataset.bound = '1'; sel.addEventListener('change', () => { review.scene = sel.value; renderReview(); }); }
		review.scene = sel.value;
		renderReview();
	}
	function encodeLenCJK(text) { // 粗估：CJK/全角 = 3B（ESC 基座）或 2B（双字节），ASCII = 1B
		if (!text) return 0;
		let n = 0;
		for (const ch of text) n += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60\u3000-\u303F]/.test(ch) ? 3 : 1;
		return n;
	}
	/* ================= 审校：左侧条目列表 + 右侧原文/译文详情 ================= */
	// 渲染行数上限：全量塞 DOM（3 万+ 行）会让窗口宽度调整时的重排明显卡顿；
	// 用筛选缩小范围即可看到其余条目（统计区有提示）
	const REVIEW_RENDER_CAP = 500;
	// 预览截断长度随列表宽度自适应（resize 后由防抖重渲染刷新）
	function previewLen() {
		const w = ($('reviewList') || {}).clientWidth || 380;
		return Math.max(16, Math.floor(w / 7.5));
	}
	function renderReview() {
		const sc = review.scenes[review.scene];
		if (!sc) return;
		const filter = $('reviewFilter').value.trim().toLowerCase();
		const stSel = $('reviewStatus').value;
		const rows = sc.rows.filter((r) => {
			if (filter && !(r.en || '').toLowerCase().includes(filter) && !(r.final || r.mt || '').includes(filter)) return false;
			if (stSel === '__over') { const e2 = encodeLenCJK(r.final || r.mt || '') + 1; return r.max_bytes && e2 > +r.max_bytes; }
			return !stSel || (r.status || 'untranslated') === stSel;
		});
		const counts = Object.entries(sc.counts).map(([k, v]) => `<span class="stat-chip${k === 'machine-translated' ? ' b' : ''}${stSel === k ? ' active' : ''}" data-st="${esc(k)}" title="点击按此状态筛选">${esc(k)}: ${v}</span>`).join('')
			+ `<span class="stat-chip${stSel === '__over' ? ' active' : ''}" data-st="__over" title="点击筛选超预算条目">⚠ 超预算</span>`
			+ `<span class="stat-chip${!stSel ? ' active' : ''}" data-st="" title="点击清除筛选">全部</span>`;
$('reviewStats').innerHTML = counts + `<span class="stat-chip">条目 ${sc.total}${rows.length > REVIEW_RENDER_CAP ? ` · 已渲染前 ${REVIEW_RENDER_CAP}（筛选可缩小）` : ''}</span>`;
		if (!review.sel || !rows.some((r) => r.id === review.sel)) review.sel = rows.length ? rows[0].id : null;
		const shown = rows.slice(0, REVIEW_RENDER_CAP);
		let html = '';
		for (const r of shown) {
			const finalText = r.final || r.mt || '';
			const est = encodeLenCJK(finalText) + 1;
			const over = r.max_bytes && est > +r.max_bytes;
			const st = r.status || 'untranslated';
			const stCls = st === 'human-reviewed' ? 'ok' : st === 'machine-translated' ? 'warn' : 'dim';
			html += `<div class="rl-row${r.id === review.sel ? ' sel' : ''}${over ? ' over' : ''}" data-id="${esc(r.id)}">
				<div class="rl-top"><span class="id-col">${esc(r.id)}</span><span class="rl-status ${stCls}">${esc(st)}</span><span class="rl-bytes${over ? ' tl-error' : ''}">${est}/${r.max_bytes || '?'}B</span></div>
				<div class="rl-prev">${esc(finalText.slice(0, previewLen())) || '<span class="dim">（未译）</span>'}</div>
			</div>`;
		}
		$('reviewTable').innerHTML = html || '<div class="empty">无匹配</div>';
		for (const el of document.querySelectorAll('.rl-row')) {
			el.addEventListener('click', () => { review.sel = el.dataset.id; renderReview(); });
		}
		for (const chip of document.querySelectorAll('#reviewStats .stat-chip[data-st]')) {
			chip.addEventListener('click', () => {
				$('reviewStatus').value = chip.dataset.st;
				renderReview();
			});
		}
		renderDetail();
	}

	// 窗口宽度变化：防抖重渲染审校列表（预览截断长度随宽度自适应；行数已封顶，重排很轻）
	let reviewResizeTimer = null;
	window.addEventListener('resize', () => {
		if (!review.ready) return;
		const panel = $('panel-review');
		if (!panel || panel.offsetParent === null) return; // 面板未显示时不重渲染
		clearTimeout(reviewResizeTimer);
		reviewResizeTimer = setTimeout(() => { if (review.ready) renderReview(); }, 200);
	});
	function renderDetail() {
		const sc = review.scenes[review.scene];
		const r = sc && sc.rows.find((x) => x.id === review.sel);
		const box = $('reviewDetail');
		if (!r) { box.innerHTML = '<div class="empty">← 点击左侧条目查看/编辑</div>'; return; }
		const finalText = r.final || '';
		const mtText = r.mt || '';
		const est = encodeLenCJK(finalText) + 1;
		const over = r.max_bytes && est > +r.max_bytes;
		box.innerHTML = `
			<div class="rd-meta"><span class="id-col">${esc(r.id)}</span>${r.addr_gba ? `<span class="hint">${esc(r.addr_gba)}</span>` : ''}<span class="rl-status ${r.status === 'human-reviewed' ? 'ok' : 'warn'}">${esc(r.status || '')}</span></div>
			<div class="rd-sec"><div class="rd-label">原文</div><div class="rd-en">${esc(r.en)}</div></div>
			<div class="rd-sec"><div class="rd-label">译文（写入 final）<span id="rdBytes" class="hint" style="margin-left:10px">${est}/${r.max_bytes || '?'}B${over ? ' ⚠超长' : ''}</span></div>
				<textarea id="rdText">${esc(finalText)}</textarea>
				${mtText && mtText !== finalText ? `<div class="rd-mt hint">机翻参考：${esc(mtText)}</div>` : ''}</div>
			<div class="btnrow">
				<button id="rdSaveBtn" class="primary">保存此条</button>
				<button id="rdApproveBtn">✔ 通过并保存</button>
			</div>`;
		const ta = $('rdText');
		const updBytes = () => {
			const e2 = encodeLenCJK(ta.value) + 1;
			const o2 = r.max_bytes && e2 > +r.max_bytes;
			$('rdBytes').textContent = `${e2}/${r.max_bytes || '?'}B${o2 ? ' ⚠超长' : ''}`;
			$('rdBytes').className = 'hint' + (o2 ? ' tl-error' : '');
		};
		ta.addEventListener('input', updBytes);
		const save = async (approve) => {
			if (!ta.value.trim()) { alert('译文为空，不能通过'); return; }
			const patch = { id: r.id, final: ta.value };
			if (approve || r.status === 'human-reviewed') patch.status = 'human-reviewed';
			const btn = $(approve ? 'rdApproveBtn' : 'rdSaveBtn');
			btn.disabled = true;
			try {
				await jpost(API + '/review', { project: review.project, scene: review.scene, updates: [patch] });
				r.final = ta.value;
				if (approve) r.status = 'human-reviewed';
				review.dirty = true;
				btn.textContent = '已保存 ✓';
				setTimeout(() => { btn.textContent = approve ? '✔ 通过并保存' : '保存此条'; btn.disabled = false; renderReview(); }, 500);
			} catch (e) { alert('保存失败: ' + e.message); btn.disabled = false; }
		};
		$('rdSaveBtn').addEventListener('click', () => save(false));
		$('rdApproveBtn').addEventListener('click', () => save(true));
	}
	$('reviewFilter').addEventListener('input', () => renderReview());
	$('reviewStatus').addEventListener('change', () => renderReview());
	async function jpost(url, body) {
		const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		const ct = r.headers.get('content-type') || '';
		if (!ct.includes('json')) throw new Error('romctl serve 响应异常（' + r.status + '）— 请点「重连」或重启 serve');
		const j = await r.json();
		if (!j.ok) throw new Error(j.error || r.status);
		return j;
	}
	$('reviewInsertBtn').addEventListener('click', async () => {
		if (!confirm('回填会写 out_rom（32MB 指针扫描可能较慢）。继续？')) return;
		try {
			await jpost(API + '/insert', { project: review.project, allowMt: true });
			pollInsertLog('回填已启动，日志：');
		} catch (e) { alert('启动失败: ' + e.message); }
	});
	function pollInsertLog(prefix) {
		fetch(API + '/workfile?name=insert-latest.log').then((r) => (r.ok ? r.text() : '')).then((t) => {
			if (t) $('insertLogBody').textContent = (prefix || '') + t.slice(-4000);
			setTimeout(() => pollInsertLog(), 3000);
		}).catch(() => {});
	}

			/* ================= 面板: 内存/反汇编（参照 memview.html 实现） ================= */
	const MREGIONS = [
		{ id: 'iwram', name: 'IWRAM (32K)', base: 0x03000000, size: 0x8000 },
		{ id: 'ewram', name: 'EWRAM (256K)', base: 0x02000000, size: 0x40000 },
		{ id: 'io',    name: 'IO (1K)',      base: 0x04000000, size: 0x400 },
		{ id: 'pal',   name: 'Palette (1K)', base: 0x05000000, size: 0x400 },
		{ id: 'vram',  name: 'VRAM (96K)',   base: 0x06000000, size: 0x18000 },
		{ id: 'oam',   name: 'OAM (1K)',     base: 0x07000000, size: 0x400 },
		{ id: 'rom',   name: 'ROM (前128K)', base: 0x08000000, size: 0x20000 },
	];
	const MROW_BYTES = 16, MVIEW_ROWS = 24;
	const memState = { base: 0x03000000, prev: null };
	const parseAddrS = (s) => {
		const t = String(s || '').trim();
		if (!t) return NaN;
		return /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10);
	};
	$('memRegion').innerHTML = MREGIONS.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
	function memClamp(a) {
		const r = MREGIONS.find((x) => a >= x.base && a < x.base + x.size) || MREGIONS[0];
		return Math.max(r.base, Math.min(a, r.base + r.size - MROW_BYTES * MVIEW_ROWS));
	}
	function memAlign(a) { return (a & ~0xf) >>> 0; }
	async function memRead() {
		try {
			const len = MROW_BYTES * MVIEW_ROWS;
			const r = await jget(API + '/memread?addr=0x' + (memState.base >>> 0).toString(16) + '&len=' + len);
			const bytes = (r.hex.match(/.{2}/g) || []).map((b) => parseInt(b, 16));
			let html = '', changes = 0;
			for (let row = 0; row < MVIEW_ROWS; row++) {
				const rowAddr = memState.base + row * MROW_BYTES;
				let hex = '', asc = '';
				for (let c = 0; c < MROW_BYTES; c++) {
					const b = bytes[row * MROW_BYTES + c];
					const prev = memState.prev ? memState.prev[row * MROW_BYTES + c] : b;
					const changed = memState.prev && b !== prev;
					if (changed) changes++;
					hex += `<span class="${changed ? 'chg' : ''}">${b.toString(16).padStart(2, '0')}</span> `;
					asc += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
				}
				html += `<div class="hrow"><span class="addr">0x${(rowAddr >>> 0).toString(16).padStart(8, '0')}</span><span class="hexv">${hex}</span><span class="asc">|${asc}|</span></div>`;
			}
			memState.prev = bytes;
			$('memDump').innerHTML = html;
			$('memChangeHint').textContent = memState.prev ? (changes ? `变化 ${changes} 字节` : '无变化') : '';
		} catch (e) {
			$('memDump').textContent = '读取失败: ' + e.message;
		}
	}
	function memGoto(addr) {
		memState.base = memAlign(memClamp(addr >>> 0));
		prevNone();
		const r = MREGIONS.find((x) => memState.base >= x.base && memState.base < x.base + x.size);
		if (r) $('memRegion').value = r.id;
		memRead();
	}
	function prevNone() { memState.prev = null; }
	$("memRegion").addEventListener("change", () => {
		const r = MREGIONS.find((x) => x.id === $("memRegion").value);
		if (r) memGoto(r.base);
	});
	$("memReadBtn").addEventListener("click", () => {
		const a = parseAddrS($("memAddr").value);
		if (!isNaN(a)) memGoto(a); else memRead();
	});
	$("memPrevBtn").addEventListener("click", () => { memState.base = memClamp(memState.base - MROW_BYTES * MVIEW_ROWS); prevNone(); memRead(); });
	$("memNextBtn").addEventListener("click", () => { memState.base = memClamp(memState.base + MROW_BYTES * MVIEW_ROWS); prevNone(); memRead(); });
	$("memAddr").addEventListener("keydown", (e) => { if (e.key === "Enter") $("memReadBtn").click(); });
	let memTimer = null;
	$("memAutoChk").addEventListener("change", () => {
		if ($("memAutoChk").checked) { memTimer = setInterval(memRead, 1000); memRead(); }
		else { clearInterval(memTimer); memTimer = null; }
	});
	async function disasmRefresh() {
		try {
			const rg = await jget(API + '/regs');
			const mode = (rg.mode || 'arm').toLowerCase();
			const pc = parseInt(rg.gprs.pc, 16) >>> 0;
			// Thumb PC 读数为当前指令+4；ARM 为 +8
			const execAddr = (pc - (mode === 'thumb' ? 4 : 8)) >>> 0;
			const modeEl = $('cpuMode');
			modeEl.textContent = 'CPU: ' + mode.toUpperCase();
			$('pcLabel').textContent = 'PC=0x' + pc.toString(16).toUpperCase() + '  执行于 0x' + execAddr.toString(16).toUpperCase();
			let start;
			if ($("lockPcChk").checked) {
				start = (execAddr & ~3) >>> 0;
				$("disAddr").value = "0x" + start.toString(16).toUpperCase();
			} else {
				const typed = parseAddrS($("disAddr").value);
				start = (isNaN(typed) ? 0x08000000 : typed) & ~3;
			}
			const n = Math.max(1, Math.min(500, parseInt($("disN").value || "40", 10)));
			const r = await jget(API + '/disasm?addr=0x' + (start >>> 0).toString(16) + '&n=' + n + '&mode=' + mode);
			let html = '';
			for (const ln of r.lines) {
				const a = parseInt(ln.addr, 16) >>> 0;
				const isPc = a === execAddr;
				const isBranch = /^b|bl /.test(ln.text);
				const mnc = ln.text.replace(/^([a-z][a-z0-9]*)(s)/, '<span class="mnc">$1</span>$2');
				html += `<div class="drow${isPc ? ' pc' : ''}${isBranch ? ' branch' : ''}"><span class="addr">0x${a.toString(16).toUpperCase().padStart(8, '0')}</span><span class="raw">${esc(ln.bytes || '')}</span><span class="ins">${mnc}</span></div>`;
			}
			$('disOut').innerHTML = html;
		} catch (e) {
			$('disOut').textContent = '反汇编失败: ' + e.message;
		}
	}
	$("disBtn").addEventListener("click", disasmRefresh);
	$("disAddr").addEventListener("keydown", (e) => { if (e.key === "Enter") disasmRefresh(); });
	$("lockPcChk").addEventListener("change", () => { if ($("lockPcChk").checked) disasmRefresh(); });
	$("memPcBtn").addEventListener("click", async () => {
		try {
			const rg = await jget(API + '/regs');
			const mode = (rg.mode || 'arm').toLowerCase();
			const pc = parseInt(rg.gprs.pc, 16) >>> 0;
			const execAddr = (pc - (mode === 'thumb' ? 4 : 8)) >>> 0;
			memGoto(execAddr);
			$("disAddr").value = "0x" + (execAddr & ~3).toString(16).toUpperCase();
			disasmRefresh();
		} catch (e) { alert(e.message); }
	});

	/* ================= 快照存档（10 槽，经 romctl /snap） ================= */
	let snapMode = "save";
	const snapModeBtns = { save: $("snapModeSave"), load: $("snapModeLoad"), del: $("snapModeDel") };
	function setSnapMode(m) {
		snapMode = m;
		for (const [k, b] of Object.entries(snapModeBtns)) b.classList.toggle("primary", k === m);
	}
	snapModeBtns.save.addEventListener("click", () => setSnapMode("save"));
	snapModeBtns.load.addEventListener("click", () => setSnapMode("load"));
	snapModeBtns.del.addEventListener("click", () => setSnapMode("del"));
	async function snapList() {
		try {
			const r = await jget(API + '/snap?op=list');
			const byName = new Map((r.snaps || []).map((s) => [s.name, s]));
			let html = "";
			for (let i = 1; i <= 10; i++) {
				const name = "slot-" + i;
				const s = byName.get(name);
				const occ = s && s.verMatch !== false;
				const st = s ? new Date(s.savedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + " 帧" + s.frames : "空";
				html += `<button class="snap-slot${occ ? ' occupied' : ''}" data-slot="${i}" title="${occ ? esc(s.savedAt) : '空槽'}"><span class="sn">槽 ${i}</span><span class="st">${st}</span></button>`;
			}
			$("snapGrid").innerHTML = html;
			for (const b of document.querySelectorAll(".snap-slot")) {
				b.addEventListener("click", async () => {
					const i = b.dataset.slot;
					const name = "slot-" + i;
					try {
						if (snapMode === "save") {
							const occupied = b.classList.contains("occupied");
							if (occupied && !confirm(`槽 ${i} 已有存档，覆盖？`)) return;
							await jget(API + '/snap?op=save&name=' + name);
						} else if (snapMode === 'load') {
							if (!b.classList.contains('occupied')) { alert('槽 ' + i + ' 是空的'); return; }
							const r = await jget(API + '/snap?op=load&name=' + name + '&force=1');
							if (r.warnings && r.warnings.length) alert('已读取（有警告）：' + r.warnings.join('; '));
						} else {
							if (!b.classList.contains('occupied')) return;
							if (!confirm('删除槽 ' + i + ' 的存档？')) return;
							await jget(API + '/snap?op=del&name=' + name);
						}
						snapList(); pollStatus();
					} catch (e) { alert((snapMode === "load" ? "读取失败: " : "操作失败: ") + e.message); }
				});
			}
		} catch (e) {
			$('snapGrid').innerHTML = `<div class=\"empty\">快照列表加载失败：${esc(e.message)}</div>`;
		}
	}
	snapList();

	/* 惰性初始化 */
	review.ensure = ensureReview;
	charmap.ensure = charmap.ensure.bind(charmap);
	window.__studio = { refreshPipeline, loadSessionList };
})();
