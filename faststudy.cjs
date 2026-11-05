#!/usr/bin/env node
/**
 * 大川学堂 学习时长加速器（交互版 v2）
 * 双击运行：自动连浏览器 → 按「未完成 / 已完成」分类列课 → 选课 → 指定刷几节 → 回菜单。
 *
 * 原理：learntime 的计时令牌「读一次就消费」，令牌缺失时按上限 45000ms 记账。
 * 构造「课程有效、资源无效」的请求把令牌吃掉不写回，下一条真实上报即白拿 45 秒。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const PORT = 9222;
const BASE = "https://ecourse.scu.edu.cn";
const LOG = path.join(os.homedir(), ".ecourse-faststudy.log");
const log = (...a) => {
	const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
	try { fs.appendFileSync(LOG, line + "\n"); } catch (e) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) =>
	new Promise((res) => {
		let done = false;
		const finish = (v) => { if (!done) { done = true; rl.removeListener("close", onClose); res(v); } };
		const onClose = () => finish("");
		rl.once("close", onClose);
		try { rl.question(q, (a) => finish(a.trim())); } catch (e) { onClose(); }
	});

const ARGV = process.argv.slice(2);
const argOf = (k) => { const a = ARGV.find((x) => x.startsWith("--" + k + "=")); return a ? a.split("=")[1] : null; };
const COURSE_ARG = argOf("course");
const LIMIT_ARG = argOf("limit");
const MENU_ONLY = ARGV.includes("--menu");

// ---------------- CDP ----------------
async function cdpAlive() {
	try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; }
	catch (e) { return false; }
}
function findEdge() {
	return ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
}
async function ensureBrowser() {
	if (await cdpAlive()) return;
	const edge = findEdge();
	if (!edge) { console.log("没找到 Microsoft Edge。"); process.exit(1); }
	const profile = path.join(os.homedir(), "AppData", "Local", "ecourse-faststudy-profile");
	fs.mkdirSync(profile, { recursive: true });
	console.log("正在启动专用浏览器窗口……（首次使用需要在这个窗口里登录，之后会自动记住）");
	spawn(edge, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", BASE + "/learn/portal"], { detached: true, stdio: "ignore" }).unref();
	for (let i = 0; i < 40; i++) { await sleep(500); if (await cdpAlive()) return; }
	console.log("浏览器启动超时。"); process.exit(1);
}
async function pickTab() {
	const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const hit = list.filter((t) => t.type === "page").find((t) => (t.url || "").includes("ecourse.scu.edu.cn"));
	if (hit) return hit;
	const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE + "/learn/portal")}`, { method: "PUT" });
	const t = await r.json();
	await sleep(2500);
	return t;
}
class Tab {
	constructor(target) { this.ws = new WebSocket(target.webSocketDebuggerUrl); this.id = 0; this.waiting = new Map(); }
	async open() {
		await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
		this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)(m); this.waiting.delete(m.id); } };
	}
	send(method, params) {
		const id = ++this.id;
		return new Promise((res) => { this.waiting.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
	}
	async eval(expr) {
		const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 300000 });
		if (r.result && r.result.exceptionDetails) {
			const d = r.result.exceptionDetails;
			throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || "JS 异常");
		}
		return r.result && r.result.result ? r.result.result.value : undefined;
	}
	goto(url) { return this.send("Page.navigate", { url }); }
}

// ---------------- 页面脚本 ----------------
const S = {
	courses: `(async () => {
		const out = [];
		for (let pg = 1; pg <= 6; pg++) {
			const r = await fetch('/learn/v1/learningsituation/teaching/course/get/participated/courses/list?pageIndex=' + pg + '&pageSize=50', { credentials: 'include' });
			const j = await r.json();
			if (!j || j.status !== 200) return { err: (j && j.message) || ('HTTP ' + r.status) };
			const res = (j.data && j.data.results) || [];
			for (const x of res) {
				const e = x.entityData || {};
				out.push({ cid: x.contentId_ || e.contentId_, name: x.name || e.name || e.name_ || '', sem: e.course_semester_id || 1, term: e.semester_show_name || '', type: e.courseType, join: e.join });
			}
			if (res.length < 50) break;
		}
		return { list: out };
	})()`,
	tree: (C, SEM, T) => `(async () => {
		const types = ${JSON.stringify([T == null ? "" : String(T), "", "2", "1"].filter((v, i, a) => a.indexOf(v) === i))};
		for (const t of types) {
			const r = await fetch('/learn/v1/homepage/chapter/info?courseId=${C}&type=' + t + '&semester=${SEM}&metadataType=chapter_contents', { credentials: 'include' });
			const j = await r.json().catch(() => null);
			if (!j || !j.data) continue;
			const out = [];
			const walk = (n) => { if (!n) return; if (Array.isArray(n)) return n.forEach(walk); const i = n.info;
				if (i && i.resourse_type) out.push({ o: i.order, name: i.chapter_name, sub: i.guid_, st: i.status });
				(n.childInfo || []).forEach(walk); };
			walk(j.data);
			if (out.length) return { list: out };
		}
		return { list: [] };
	})()`,
	one: (C, SEM, SUB, USER) => `(async () => {
		const g = async () => { const j = await (await fetch('/learn/v1/learningsituation?courseId=${C}&subsectionId=${SUB}&courseSemester=${SEM}', { credentials: 'include' })).json(); return j.data || null; };
		const status = async (st, total, event) => {
			const body = { courseId: '${C}', courseType: 1, subsectionId: '${SUB}', status: st, resourceType: 'video', courseSemester: ${SEM}, userCode: '${USER}', studyTotalTime: Math.round(total || 0), serviceVersion: 'v2610161507', event, currentTime: '0' };
			return await (await fetch('/learn/v1/learningsituation/resource/study/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' })).json();
		};
		const credit = async (b) => await (await fetch('/learn/v1/statistics/course/learntime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), credentials: 'include' })).json();
		const mk = (o) => Object.assign({ courseId: '${C}', timeInterval: 45000, courseType: 1, resourceId: '${SUB}', courseSemester: ${SEM}, serviceVersion: 'v2610161507', event: 'interval', currentTime: '45', extend: JSON.stringify({ currentTime: '45' }), doubleSpeed: 1 }, o || {});

		if (!(await g())) {
			const c = await status(0, 0, 'create');
			if (c.status !== 200) return { err: '建行失败: ' + (c.message || c.status) };
		}
		const first = await status(2, 0, 'complate');
		if (first.status === 200) return { ok: true, already: true, st: (await g()).studyTime };
		const m = String(first.message || '').match(/需至少学习\\s*(\\d+)/);
		if (!m) return { err: '未知返回: ' + (first.message || first.status) };
		const need = Number(m[1]);
		const t0 = performance.now();
		let st = 0, prev = -1, stagnant = 0, lastMark = '';
		// 不设固定轮数：按门槛×3 作为硬顶，主靠“连续不涨就停”保护
		const hardCap = Math.ceil((need * 3) / 45000) + 30;
		for (let i = 0; i < hardCap; i++) {
			await credit(mk({ resourceId: '00000000000000000000000000000000' }));
			await credit(mk());
			st = (await g()).studyTime || 0;
			if (st + 60000 >= need) {
				const fin = await status(2, st, 'complate');
				if (fin.status === 200) return { ok: true, need, st, ms: Math.round(performance.now() - t0), rounds: i + 1 };
				lastMark = String(fin.message || fin.status);
			}
			if (st <= prev) stagnant++; else stagnant = 0;
			prev = st;
			if (stagnant >= 5) return { ok: false, need, st, msg: '连续 5 轮学习时长没有增加（' + Math.round(st / 1000) + 's / 门槛 ' + Math.round(need / 1000) + 's），服务端可能在拒绝记账：' + (lastMark || '无返回') };
		}
		return { ok: false, need, st, msg: '已刷到门槛的 3 倍仍无法标记（' + Math.round(st / 1000) + 's / 门槛 ' + Math.round(need / 1000) + 's）：' + (lastMark || '无返回') };
	})()`,
	me: `(async () => {
		try { const t = await (await fetch('/unifiedplatform/v1/user/current', { credentials: 'include' })).text();
			const m = t.match(/"userCode"\\s*:\\s*"([^"]+)"/); return m ? m[1] : null; } catch (e) { return null; }
	})()`,
};

async function waitLogin(tab) {
	let lastErr = "";
	let hinted = false;
	for (let i = 0; i < 300; i++) {
		let href = "";
		try { href = String(await tab.eval("location.href")); } catch (e) {}
		if (!href.includes("ecourse.scu.edu.cn")) {
			if (!hinted) {
				console.log("\n>>> 请在弹出的窗口里登录大川学堂（当前页面：" + href.slice(0, 60) + "）");
				console.log("    登录成功后程序会自动继续，不用关窗口。");
				hinted = true;
			}
		} else {
			try {
				const r = await tab.eval(S.courses);
				if (r && r.list && r.list.length) return r.list;
				if (r && r.err) lastErr = String(r.err).slice(0, 80);
			} catch (e) { lastErr = String((e && e.message) || e || "未知").slice(0, 80); }
		}
		if (i % 30 === 29) console.log("   仍在等待登录……（已等 " + (i + 1) * 2 + "s" + (lastErr ? "，最近错误：" + lastErr : "") + "）");
		await sleep(2000);
	}
	return null;
}

// ---------------- 主流程 ----------------
(async () => {
	console.log("==============================================");
	console.log("   大川学堂 学习时长加速器");
	console.log("==============================================");

	await ensureBrowser();
	const tab = new Tab(await pickTab());
	await tab.open();
	await tab.send("Runtime.enable");
	await tab.send("Page.enable");

	// 如果拿到的不是本站页面（或停在旧的 404 页），先导到工作台
	try {
		const cur = String(await tab.eval("location.href"));
		if (!cur.includes("ecourse.scu.edu.cn") || cur.includes("/learn/index")) {
			await tab.goto(BASE + "/learn/portal");
			await sleep(2500);
		}
	} catch (e) {}

	const courses = await waitLogin(tab);
	if (!courses) { console.log("\n未能获取课程列表（未登录或网络异常）。"); rl.close(); process.exit(0); }
	const USER = process.env.ECOURSE_USER || (await tab.eval(S.me)) || "";
	console.log("\n当前账号：" + (USER || "未知"));

	// 去重 + 只要已加入且有名字的
	const seen = new Set();
	const all = courses.filter((c) => {
		if (!c.cid || seen.has(c.cid)) return false;
		seen.add(c.cid);
		return !!c.name && Number(c.join) !== 0;
	});

	// 扫描每门课的完成情况
	const state = { pending: [], finished: [], empty: [] };
	const doScan = async () => {
		process.stdout.write(`\n正在扫描 ${all.length} 门课……`);
		for (const c of all) {
			try {
				const t = await tab.eval(S.tree(c.cid, c.sem, c.type));
				const list = (t && t.list) || [];
				c.total = list.length;
				c.done = list.filter((x) => x.st === 2).length;
			} catch (e) { c.total = 0; c.done = 0; }
			process.stdout.write('.');
		}
		state.pending = all.filter((c) => c.total > 0 && c.done < c.total);
		state.finished = all.filter((c) => c.total > 0 && c.done === c.total);
		state.empty = all.filter((c) => c.total === 0);
		console.log(' 完成');
	};
	await doScan();

	const choose = async () => {
		console.log("=============== 课程列表 ===============");
		let n = 0;
		const index = new Map();
		const show = (c, tag) => {
			const i = ++n;
			index.set(i, c);
			console.log(`  [${i}] ${c.name.slice(0, 26).padEnd(28)} ${tag}`);
		};
		const { pending, finished, empty } = state;
		if (pending.length) {
			console.log("\n【未学完】");
			for (const c of pending) show(c, `未完成 ${c.done}/${c.total}（还差 ${c.total - c.done} 节）`);
		} else console.log("\n【未学完】\n  （无）");
		if (finished.length) {
			console.log("\n【已完成】");
			for (const c of finished) show(c, `${c.total}/${c.total} 全部完成`);
		} else console.log("\n【已完成】\n  （无）");
		if (empty.length) {
			console.log("\n【没有视频资源】");
			for (const c of empty) show(c, "无资源");
		}
		console.log("\n输入序号可多选（如 1 或 1,3）；r 重新扫描；0 退出。");
		return { index, n };
	};

	for (;;) {
		const { index } = await choose();
		const ans = (COURSE_ARG || (await ask("\n选择："))).trim();
		if (!ans || ans === "0") break;
		if (ans.toLowerCase() === "r") { await doScan(); continue; }
		const picks = ans.split(/[,，\s]+/).map((x) => index.get(Number(x))).filter(Boolean);
		if (!picks.length) { console.log("序号无效。"); continue; }

		for (const c of picks) {
			if (c.total === 0) { console.log(`\n《${c.name}》没有视频资源，跳过。`); continue; }
			if (c.done === c.total) { console.log(`\n《${c.name}》已经全部完成，无需处理。`); continue; }

			const tree = await tab.eval(S.tree(c.cid, c.sem, c.type));
			const todo = ((tree && tree.list) || []).filter((x) => x.st !== 2);
			console.log(`\n《${c.name}》共 ${c.total} 节，未完成 ${todo.length} 节。`);
			let limRaw = LIMIT_ARG;
			if (limRaw === null) limRaw = await ask(`这次刷几节？（回车=全部 ${todo.length} 节，0=跳过）: `);
			if (String(limRaw) === "0") continue;
			const limit = limRaw ? Math.max(1, Math.min(Number(limRaw) || todo.length, todo.length)) : todo.length;
			const queue = todo.slice(0, limit);

			console.log(`开始处理 ${queue.length} 节（预计 ${Math.ceil(queue.length * 4 / 60)} 分钟，全程不播放视频）\n`);
			let ok = 0, bad = 0, credited = 0;
			const t0 = Date.now();
			for (let i = 0; i < queue.length; i++) {
				const it = queue[i];
				const tag = `${String(i + 1).padStart(3)}/${queue.length} ${it.o} ${it.name}`.slice(0, 46);
				try {
					const r = await tab.eval(S.one(c.cid, c.sem, it.sub, USER));
					if (r && r.ok) {
						ok++; credited += (r.st || 0) / 1000;
						log("OK", c.name, it.o, it.name, "need=" + Math.round(r.need / 1000) + "s", "st=" + Math.round(r.st / 1000) + "s");
						console.log(`${tag}  ✓ ${r.already ? "本就完成" : `门槛 ${Math.round(r.need / 1000)}s → ${Math.round(r.st / 1000)}s`}`);
					} else {
						bad++;
						const why = (r && (r.err || r.msg)) || "未知错误";
						log("FAIL", c.name, it.o, it.name, why);
						console.log(`${tag}  ✗ ${why}`);
					}
				} catch (e) { bad++; console.log(`${tag}  ! ${String(e).slice(0, 80)}`); }
			}
			c.done += ok;
			state.pending = all.filter((x) => x.total > 0 && x.done < x.total);
			state.finished = all.filter((x) => x.total > 0 && x.done === x.total);
			console.log(`\n—— 《${c.name}》完成：成功 ${ok}，失败 ${bad}，记入 ${(credited / 3600).toFixed(2)} 小时，用时 ${Math.round((Date.now() - t0) / 1000)} 秒。`);
		}

		console.log("\n全部处理完毕，回到课程列表。");
		if (COURSE_ARG) break; // 参数模式跑一轮就退出
		await ask("按回车返回课程列表……");
	}

	console.log("\n已退出。日志：" + LOG);
	rl.close();
	process.exit(0);
})().catch((e) => { console.error("出错：", e); process.exit(1); });
