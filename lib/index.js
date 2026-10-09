/**
 * dsh-restart-button · Host 半
 *
 * 一句话：**宿主只负责点火，收尸和点灯的活交给脚本。**
 *
 * 为什么不能自己重启：宿主自己就是"要被关掉的那个东西"。而且宿主这层
 * 没有 quit / restart 之类的服务或事件（Event 全表里翻过了，没有）。
 * 所以出路是往外递一只手：
 *
 *   宿主点火 → 立刻回 HTTP 响应 → 脚本关掉 DSH → 脚本再拉起新实例。
 *
 * ## 点火引擎（这一版的重点）
 *
 * 前两版都用 `node:child_process.spawn`，实测**从宿主里点不着**：
 * 子进程 63 毫秒就"退出 0"，脚本一行都没执行。而在同一个沙箱里做六组对照
 * （detached / 非 detached / inherit / 空 env / cmd.exe / shell:true）全部失败，
 * 同一个脚本用资源管理器双击却跑得好好的。结论：不是 PowerShell 的问题，
 * 是这一层创建进程的方式不被允许。
 *
 * 于是换成 `ctx.subprocess` —— 这台机器上所有工具调用（pwsh、node）都是它拉起来的，
 * 是唯一被证明能从宿主里跑起进程的路。`node:child_process` 留作兜底。
 *
 * ## 四条纪律
 *
 *   1. **别用裸名字调 PowerShell**：宿主的 PATH 未必带 System32。固定走绝对路径。
 *   2. **spawn 的失败是异步的**，`error` / `exit` / `done` 全都要接住并写日志，
 *      否则未处理的错误会反过来把宿主带走（第一版就是这么翻的车）。
 *   3. **先能自检再动真格**：`dryRun` 只让脚本写日志、报出它打算杀谁，一个进程都不碰。
 *   4. 可执行文件路径**不硬编码**，用 `process.execPath`：宿主自己就是那个 exe
 *      （外壳用 ELECTRON_RUN_AS_NODE 把它跑起来的），版本更新换了目录也不会瞎。
 *
 * 注册面：
 *   - `ctx.inject(['webServer'])` —— 给界面按钮用的三个 POST 路由（status/restart/dryrun）
 *   - `ctx.inject(['commands'])`  —— `/restart` 命令，手感兜底
 *   - 日志落在 `~/.dsh/dsh-restart-button/restart.log`，事后翻它就知道走到哪一步
 */

import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'restart-button';

/** 客户端按钮用的路由前缀。 */
const ROUTE_PREFIX = '/restart-button/api';

/** build 标记：宿主有没有真的重新加载过模块，看这个字段。 */
const BUILD = 'restart-6';

/** 干脏活的脚本，跟着包走。 */
const HELPER_FILE = 'restart-dsh.ps1';

/** 插件自己的小窝：只放日志，不放"产出"。 */
const HOME_DIR = 'dsh-restart-button';
const LOG_FILE = 'restart.log';
const CHILD_LOG_FILE = 'helper-out.log';

const LOG_TAIL_LINES = 14;
const LOG_MAX_TAIL_CHARS = 4000;

const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	/** 软杀之后给多少秒自己体面退出（脚本内部最多只等 2 秒，这套窗口不吃 WM_CLOSE）。 */
	graceSeconds: z.number().default(2).volatile(),
	/**
	 * 重启方式：
	 *   host = 只换宿主（默认）。让宿主进程自己退出，外壳会把它重新拉起来。
	 *          不 spawn 任何东西 —— 因为这台机器上，宿主 spawn 出来的一切都在
	 *          dsh-subprocess 那层沙箱里，看不见也杀不掉别的进程（实测：WMI 拒绝访问、
	 *          计划任务建不了、explorer 转发同样落进沙箱）。
	 *   full = 完整退出再拉起（要靠 helper 脚本，而 helper 只有在你双击桌面那个
	 *          `重启 DSH.cmd` 时才跑得动）。插件里保留这条路，但别指望按钮能走通。
	 */
	mode: z.union([z.const('host'), z.const('full')]).default('full').volatile(),
	/** 留空就用 process.execPath（一般不用填）。 */
	exePath: z.string().default('').volatile(),
	/** 点火引擎：subprocess = ctx.subprocess（默认）｜ node = node:child_process（兜底）。 */
	engine: z.union([z.const('subprocess'), z.const('node')]).default('subprocess').volatile(),
});

/* ------------------------------------------------------------------ 小工具 */

/** 宿主 Config 字段可能是引用也可能是值，两种都容忍（照 dsh-memory-gate）。 */
function readConfig(config, key, fallback) {
	const raw = config?.[key];
	if (raw === undefined || raw === null) return fallback;
	if (typeof raw === 'object') {
		if (typeof raw.get === 'function') {
			try {
				const value = raw.get();
				return value === undefined || value === null ? fallback : value;
			} catch {
				return fallback;
			}
		}
		if ('value' in raw) return raw.value ?? fallback;
	}
	return raw;
}

function writeJson(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(payload));
}

/** 读一个小的 JSON 请求体。超过 1MB 直接拒绝。 */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1024 * 1024) throw new Error('body too large');
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	if (raw === '') return {};
	return JSON.parse(raw);
}

function clampGrace(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 8;
	return Math.max(0, Math.min(60, Math.round(n)));
}

function pluginHome() {
	try {
		return dshHomePath(HOME_DIR);
	} catch {
		return undefined;
	}
}

function helperPath() {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return resolve(here, '..', 'tools', HELPER_FILE);
	} catch {
		return '';
	}
}

/**
 * PowerShell 的绝对路径。理由见文件头第 1 条纪律。
 * 返回 { path, exists }：exists=false 表示连绝对路径都没找到。
 */
function resolvePowerShell() {
	const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
	const candidates = [
		join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
		'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { path: candidate, exists: true };
	}
	return { path: 'powershell.exe', exists: false };
}

/** 资源管理器的绝对路径：借它启动的进程不在 DSH 的进程树里。 */
function resolveExplorer() {
	const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
	const candidate = join(root, 'explorer.exe');
	return existsSync(candidate) ? candidate : '';
}

/* ------------------------------------------------------------------ 插件本体 */

function apply(ctx, config) {
	const conf = (key, fallback) => readConfig(config, key, fallback);
	const home = pluginHome();
	const logFile = home ? join(home, LOG_FILE) : '';
	const childLogFile = home ? join(home, CHILD_LOG_FILE) : '';
	const helper = helperPath();

	function appendLog(line) {
		if (!logFile) return;
		try {
			mkdirSync(home, { recursive: true });
			appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
		} catch {
			/* 日志写不进去也不许影响重启本身 */
		}
	}

	function tailOf(file, lines) {
		try {
			if (!file || !existsSync(file)) return [];
			return readFileSync(file, 'utf8')
				.split('\n')
				.filter((line) => line.trim() !== '')
				.slice(-lines);
		} catch {
			return [];
		}
	}

	function tailLog() {
		return tailOf(logFile, LOG_TAIL_LINES).join('\n').slice(-LOG_MAX_TAIL_CHARS).split('\n');
	}

	/** 要拉起来的那个 exe。默认就是宿主自己，不需要任何硬编码路径。 */
	function resolvedExe() {
		const configured = String(conf('exePath', '') ?? '').trim();
		if (configured !== '') return configured;
		return typeof process.execPath === 'string' ? process.execPath : '';
	}

	/** 当前可用的点火引擎。subprocess 服务在不在，决定这条路走不走得通。 */
	function subprocessService() {
		try {
			const service = ctx.get('subprocess');
			return service && typeof service.spawn === 'function' ? service : undefined;
		} catch {
			return undefined;
		}
	}

	function activeEngine() {
		const preferred = String(conf('engine', 'subprocess'));
		if (preferred === 'node') return 'node';
		return subprocessService() ? 'subprocess' : 'node';
	}

	/** 点火前的体检：缺什么就说清楚，别让脚本默默失败。 */
	function inspect() {
		const exe = resolvedExe();
		const ps = resolvePowerShell();
		const problems = [];
		if (process.platform !== 'win32') problems.push(`只支持 Windows（当前 ${process.platform}）`);
		if (exe === '' || !existsSync(exe)) problems.push(`找不到可执行文件：${exe === '' ? '(空)' : exe}`);
		if (helper === '' || !existsSync(helper)) problems.push(`找不到 helper 脚本：${helper === '' ? '(空)' : helper}`);
		if (!ps.exists) problems.push(`找不到 powershell.exe（试过绝对路径），只能退回 PATH 查找`);
		return { exe, ps, problems };
	}

	function statusView() {
		const { exe, ps, problems } = inspect();
		let logMtime = 0;
		try {
			if (logFile && existsSync(logFile)) logMtime = statSync(logFile).mtimeMs;
		} catch {
			logMtime = 0;
		}
		return {
			build: BUILD,
			platform: process.platform,
			hostPid: process.pid,
			execPath: process.execPath,
			exe,
			helper,
			helperExists: helper !== '' && existsSync(helper),
			powershell: ps.path,
			powershellExists: ps.exists,
			engine: activeEngine(),
			mode: String(conf('mode', 'host')),
			enginePreferred: String(conf('engine', 'subprocess')),
			subprocessAvailable: Boolean(subprocessService()),
			launcher: String(conf('launcher', 'explorer')),
			explorer: resolveExplorer(),
			runCmd: home ? join(home, 'run-restart.cmd') : '',
			childLogFile,
			childLogTail: tailOf(childLogFile, 10),
			logFile,
			logMtime,
			logTail: tailLog(),
			enabled: conf('enabled', true) !== false,
			graceSeconds: clampGrace(conf('graceSeconds', 2)),
			problems,
		};
	}

	/**
	 * 写一个一次性入口，交给资源管理器执行。
	 *
	 * 为什么不把 PowerShell 命令行直接递给资源管理器：explorer 只认一个路径，
	 * 不认识参数。中间垫一个 .cmd，参数全写在文件里，省掉整条命令行转义的麻烦。
	 */
	function writeRunCmd(spec) {
		if (!home) return '';
		try {
			mkdirSync(home, { recursive: true });
			const file = join(home, 'run-restart.cmd');
			const q = (value) => `"${value}"`;
			const line = [
				'@echo off',
				`rem generated by dsh-restart-button at ${new Date().toISOString()} - safe to overwrite`,
				'rem launched by explorer.exe on purpose: the helper must outlive the DSH host it kills',
				`start "" /min ${q(spec.psPath)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ${q(spec.helper)} -ExePath ${q(spec.exe)} -LogPath ${q(spec.logFile)} -GraceSeconds ${spec.grace} -Caller ${q(spec.caller)}${spec.dryRun ? ' -DryRun' : ''}`,
				'exit /b 0',
				'',
			].join('\r\n');
			writeFileSync(file, line, 'utf8');
			return file;
		} catch {
			return '';
		}
	}

	/**
	 * 只换宿主：让当前的宿主进程自己退出。
	 *
	 * 为什么这是这台机器上唯一走得通的路：宿主 spawn 出来的一切都落在
	 * dsh-subprocess 那一层里，被沙箱圈着 —— 数不到进程、杀不动进程，
	 * WMI 和计划任务都被拒。而"宿主自己退出"什么都不用创建。
	 * 外壳（Electron 主进程）是它的父进程，会把新的宿主拉起来。
	 *
	 * 延迟 1.5 秒是为了让那个 HTTP 响应先回到浏览器；页面随后会失联，
	 * 宿主回来之后刷一下就是新代码。
	 */
	function retireHost(reason, delayMs, dryRun) {
		if (dryRun) {
			appendLog(`host mode dryrun: would exit host pid=${process.pid} in ${delayMs}ms (caller="${reason}")`);
			return { ok: true, mode: 'host', dryRun: true, etaMs: delayMs, hostPid: process.pid };
		}
		appendLog(`host mode: exiting host pid=${process.pid} in ${delayMs}ms — the shell is expected to respawn it (caller="${reason}")`);
		const timer = setTimeout(() => {
			appendLog('host mode: process.exit(0) now');
			try {
				process.exit(0);
			} catch {
				/* 已经没什么可做的了 */
			}
		}, delayMs);
		// 故意不 unref：这个定时器必须活到把宿主送走。
		void timer;
		return { ok: true, mode: 'host', etaMs: delayMs, hostPid: process.pid };
	}

	/* --- 两个引擎 --- */
	/** 引擎一：ctx.subprocess。工具调用走的就是它，所以它在这台机器上是被证明能用的。 */
	function fireViaSubprocess(service, argv, dryRun) {
		let handle;
		try {
			handle = service.spawn({
				argv,
				cwd: dirname(helper),
				stdio: {
					stdin: 'ignore',
					stdout: { maxBytes: 65536, spill: { maxBytes: 262144 } },
					stderr: { maxBytes: 65536, spill: { maxBytes: 262144 } },
				},
				graceMs: 2000,
				env: { ...process.env },
			});
		} catch (error) {
			const message = String(error?.message ?? error);
			appendLog(`subprocess spawn threw: ${message}`);
			return { ok: false, error: message };
		}

		appendLog(`subprocess spawn returned a handle (dryRun=${dryRun})`);

		Promise.resolve(handle.done)
			.then((outcome) => {
				const out = readCollected(handle, 'stdout');
				const err = readCollected(handle, 'stderr');
				appendLog(`subprocess done: exitCode=${outcome?.exitCode} signal=${outcome?.signal}${dryRun ? ' (dry-run)' : ''}`);
				if (out !== '') appendLog(`subprocess stdout: ${out}`);
				if (err !== '') appendLog(`subprocess stderr: ${err}`);
			})
			.catch((error) => {
				appendLog(`subprocess rejected: ${String(error?.message ?? error)}`);
			});

		return { ok: true, engine: 'subprocess', command: argv[0], dryRun };
	}

	function readCollected(handle, stream) {
		try {
			const reader = handle?.collected?.[stream];
			if (!reader) return '';
			const read = reader.readFrom(0);
			const text = String(read?.text ?? '').trim();
			return text.length > 800 ? `${text.slice(0, 800)}…` : text;
		} catch {
			return '';
		}
	}

	/** 引擎二：node:child_process。前两版用的就是它，从宿主里点不着，留作兜底。 */
	function fireViaNode(psPath, argv, dryRun) {
		let outFd = -1;
		try {
			if (childLogFile) {
				mkdirSync(home, { recursive: true });
				outFd = openSync(childLogFile, 'a');
			}
		} catch {
			outFd = -1;
		}

		const stdio = outFd >= 0 ? ['ignore', outFd, outFd] : 'ignore';
		let child;
		try {
			child = spawn(psPath, argv, {
				cwd: dirname(helper),
				detached: true,
				stdio,
				windowsHide: true,
				env: { ...process.env },
			});
		} catch (error) {
			if (outFd >= 0) {
				try {
					closeSync(outFd);
				} catch {}
			}
			const message = String(error?.message ?? error);
			appendLog(`node spawn threw synchronously: ${message}`);
			return { ok: false, error: message };
		}
		if (outFd >= 0) {
			try {
				closeSync(outFd);
			} catch {}
		}

		child.on('spawn', () => appendLog('node spawn event: spawn'));
		child.on('error', (error) => {
			appendLog(`node spawn error: code=${error?.code ?? ''} message=${error?.message ?? String(error)}`);
		});
		child.on('exit', (code, signal) => {
			appendLog(`node child exited: code=${code} signal=${signal}${dryRun ? ' (dry-run)' : ''}`);
		});
		try {
			child.unref();
		} catch {
			/* 不影响点火 */
		}

		return { ok: true, engine: 'node', helperPid: child.pid, command: psPath, dryRun, childLogFile };
	}

	/**
	 * 点火。返回 ok 只代表"脚本已经派出去了"，不代表重启已经成功 ——
	 * 成功与否看日志末尾那几行（helper start / dryrun / clean / launched / ok）。
	 *
	 * dryRun=true 时脚本只报账不动手，用来先验证这条链路能不能走通。
	 */
	function fire(reason, options) {
		const dryRun = options?.dryRun === true;
		if (conf('enabled', true) === false) {
			return { ok: false, error: '插件在配置里被关掉了' };
		}
		const { exe, ps, problems } = inspect();
		// dryRun 只要求"脚本能跑"：连 powershell 都找不到时，跑也白跑。
		const blocking = problems.filter((line) => !line.startsWith('找不到 powershell.exe'));
		if (blocking.length > 0) {
			appendLog(`fire aborted: ${blocking.join('；')}`);
			return { ok: false, error: blocking.join('；') };
		}

		const grace = clampGrace(conf('graceSeconds', 2));
		const argvTail = [
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-File',
			helper,
			'-ExePath',
			exe,
			'-LogPath',
			logFile,
			'-GraceSeconds',
			String(grace),
			'-Caller',
			String(reason ?? ''),
		];
		if (dryRun) argvTail.push('-DryRun');

		const mode = String(conf('mode', 'full'));
		if (mode === 'host') {
			const result = retireHost(String(reason ?? ''), 1500, dryRun);
			appendLog(`fire: mode=host dryRun=${dryRun} caller="${reason ?? ''}"`);
			return { ...result, exe, helper, logFile, graceSeconds: grace };
		}

		const engine = activeEngine();
		const argv = [ps.path, ...argvTail];

		appendLog(`fire: engine=${engine} dryRun=${dryRun} powershell="${ps.path}" cwd="${dirname(helper)}"`);

		const result =
			engine === 'subprocess'
				? fireViaSubprocess(subprocessService(), argv, dryRun)
				: fireViaNode(ps.path, argvTail, dryRun);

		if (!result.ok) return result;

		appendLog(`fire: dispatched exe="${exe}" grace=${grace}s caller="${reason ?? ''}"${dryRun ? ' [DRY RUN]' : ''}`);
		return { ...result, exe, helper, logFile, graceSeconds: grace };
	}

	/* --- 1. 界面按钮的三个 POST 路由 --- */

	ctx.inject(['webServer'], (webCtx) => {
		const handler = async (req, res) => {
			try {
				if (req.method !== 'POST') {
					writeJson(res, 405, { ok: false, error: 'method not allowed' });
					return;
				}
				const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
				const action = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : '';

				if (action === 'status') {
					writeJson(res, 200, { ok: true, value: statusView() });
					return;
				}

				if (action === 'restart' || action === 'dryrun') {
					const body = await readJsonBody(req);
					const caller =
						typeof body.caller === 'string' && body.caller !== ''
							? body.caller
							: action === 'dryrun'
								? 'web-dryrun'
								: 'web-button';
					const result = fire(caller, { dryRun: action === 'dryrun' });
					if (!result.ok) {
						writeJson(res, 500, { ok: false, error: result.error });
						return;
					}
					appendLog(`${action} accepted from "${caller}"`);
					writeJson(res, 200, { ok: true, value: result });
					return;
				}

				writeJson(res, 404, { ok: false, error: `unknown action "${action}"` });
			} catch (error) {
				writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
			}
		};

		ctx.effect(
			() => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
			'dsh-restart-button: /restart-button/api routes',
		);
	});

	/* --- 2. `/restart` 命令：不想摸鼠标的时候用 --- */

	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.commands.register({
			name: 'restart',
			description: '完全退出并重新启动 DSH（dry = 空转自检，status = 只看不点）',
			input: { hint: '[now|dry|status]' },
			handler: (invocation) => {
				const arg = String(invocation?.rawInput ?? '').trim().toLowerCase();

				if (arg === 'status') {
					const view = statusView();
					return {
						kind: 'success',
						text: [
							`点火条件：${view.problems.length === 0 ? '齐了' : view.problems.join('；')}`,
							`要拉起的 exe：${view.exe}`,
							`helper：${view.helper}${view.helperExists ? '' : '（不存在）'}`,
							`powershell：${view.powershell}${view.powershellExists ? '' : '（绝对路径没找到）'}`,
							`点火引擎：${view.engine}（偏好 ${view.enginePreferred}，subprocess 服务${view.subprocessAvailable ? '在' : '不在'}）`,
							`重启方式：${view.mode === 'host' ? '只换宿主（让宿主自己退出，外壳重拉）' : '完整退出再拉起（需要 helper，只在桌面脚本里跑得动）'}`,
							`宿主 pid：${view.hostPid}`,
							`宽限：软杀后等 ${view.graceSeconds} 秒`,
							`日志：${view.logFile || '(不可用)'}`,
							'',
							'最近几行日志：',
							...(view.logTail.length > 0 ? view.logTail : ['（还没有）']),
						].join('\n'),
					};
				}

				const dryRun = arg === 'dry';
				const result = fire(dryRun ? 'command-dry' : 'command', { dryRun });
				if (!result.ok) return { kind: 'error', text: `没点着：${result.error}` };
				if (dryRun) {
					return {
						kind: 'success',
						text: [
							`空转自检已发出（引擎 ${result.engine}）：helper 会写日志、报出它打算杀谁，一个进程都不碰。`,
							`命令：${result.command}`,
							'等一下看日志尾部有没有 `helper start` 和 `dryrun:` 两行 —— 有就说明链路通了。',
						].join('\n'),
					};
				}
				return {
					kind: 'success',
					text: [
						`已点火（引擎 ${result.engine}）：两秒后关掉 DSH，然后拉起新实例。`,
						`日志：${result.logFile || '(不可用)'}`,
						'回来看日志末尾是 ok 还是 warn，就知道起没起来。',
					].join('\n'),
				};
			},
		});
	});

	// 每次加载都留一条自述：引擎、服务在不在、脚本在哪。纯诊断，失败无所谓。
	try {
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, 'last-ready.json'),
			JSON.stringify({ build: BUILD, pid: process.pid, at: new Date().toISOString(), engine: activeEngine(), helper }, null, 2),
			'utf8',
		);
	} catch {}
	appendLog(
		`plugin ready: build=${BUILD} pid=${process.pid} engine=${activeEngine()} subprocess=${Boolean(subprocessService())} helper=${helper} powershell=${resolvePowerShell().path}`,
	);
}

export { Config, apply, name };
