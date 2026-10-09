/**
 * dsh-restart-button · 客户端半（会话头部右侧那一排里的一个纯图标按钮）
 *
 * 形态照已在跑的 dsh-memory-gate / dsh-emotion：`window.__ModuleLoader__.load` +
 * 裸 ESM、无构建步骤、只注册一个槽位。
 *
 * 座位：`conversation.session.header.utilities`（会话头部右侧的那排工具）。
 * 那一排现有的住户与顺序是：
 *   -10  open-in-app         ← 就是那颗"文件夹"
 *     0  session-log-download
 *    10  dsh-better-sidebar:bottom-toggle
 * 我们取 -5：紧挨着文件夹的右边一格，不打扰任何人。
 *
 * 三条纪律：
 *   1. 顶层除了 loader 调用不干别的 —— 客户端加载失败会拖垮整个界面；
 *   2. 宿主路由拿不到就降级成不可点，绝不抛出去；
 *   3. 这是唯一一个"点下去页面注定会消失"的按钮，所以给了 3 秒反悔时间：
 *      点一下开始倒计时（图标位置显示剩余秒数），再点一下取消。
 *
 * 图标是手写的 16px 细描边 SVG（Feather 的 rotate-cw 形状），
 * 不 require 任何 UI 基础包 —— 免得版本一变整个半区加载失败。
 * 重启成没成不由这里判断：页面会先死掉，结果在
 * `~/.dsh/dsh-restart-button/restart.log` 末尾。
 */

window.__ModuleLoader__.load({
	id: 'dsh-restart-button',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require('react');

		var SLOT = 'conversation.session.header.utilities';
		var API = '/restart-button/api';
		var ID = 'restart-button';
		var ORDER = -5;
		var COUNTDOWN = 3;

		var css = [
			'.dsrb-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;line-height:1;vertical-align:middle}',
			'.dsrb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dsrb-btn:focus-visible{outline:1px solid var(--dsw-alias-label-primary);outline-offset:1px}',
			'.dsrb-btn[data-state="counting"]{color:var(--dsw-alias-label-primary)}',
			'.dsrb-btn[data-state="firing"],.dsrb-btn[data-state="dead"]{opacity:.5;cursor:default}',
			'.dsrb-btn[data-state="firing"]:hover,.dsrb-btn[data-state="dead"]:hover{background:0 0;color:var(--dsw-alias-label-tertiary)}',
			'.dsrb-btn[data-state="firing"] svg{animation:dsrb-spin .9s linear infinite}',
			'.dsrb-num{font-size:12.5px;font-variant-numeric:tabular-nums;line-height:1}',
			'@keyframes dsrb-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
		].join('\n');

		try {
			if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-restart-button/styles"]') === null) {
				var tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-restart-button';
				tag.dataset.pluginCss = 'dsh-restart-button/styles';
				tag.textContent = css;
				document.head.appendChild(tag);
			}
		} catch (_) {}

		function post(action, body) {
			return fetch(API + '/' + action, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body || {}),
			}).then(function (response) {
				return response.ok ? response.json() : null;
			});
		}

		/** 16px 细描边刷新图标；跟那一排其他图标一样吃 currentColor。 */
		function refreshIcon() {
			return react.createElement(
				'svg',
				{
					key: 'icon',
					width: 16,
					height: 16,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				react.createElement('polyline', { key: 'head', points: '23 4 23 10 17 10' }),
				react.createElement('path', { key: 'arc', d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }),
			);
		}

		function RestartButton() {
			var useState = react.useState;
			var useEffect = react.useEffect;
			// hooks 拿不到就退回一个静态图标，绝不因为版本差异炸掉整个头部
			if (typeof useState !== 'function' || typeof useEffect !== 'function') {
				return react.createElement('span', { className: 'dsrb-btn', 'data-state': 'dead' }, refreshIcon());
			}

			var viewPair = useState(null);
			var view = viewPair[0];
			var setView = viewPair[1];
			var deadPair = useState(false);
			var dead = deadPair[0];
			var setDead = deadPair[1];
			var leftPair = useState(0);
			var left = leftPair[0];
			var setLeft = leftPair[1];
			var firingPair = useState(false);
			var firing = firingPair[0];
			var setFiring = firingPair[1];
			var notePair = useState('');
			var note = notePair[0];
			var setNote = notePair[1];

			useEffect(
				function () {
					var alive = true;
					post('status', {})
						.then(function (payload) {
							if (!alive) return;
							if (payload && payload.ok) {
								setView(payload.value);
								setDead(false);
							} else {
								setDead(true);
							}
						})
						.catch(function () {
							if (alive) setDead(true);
						});
					return function () {
						alive = false;
					};
				},
				[],
			);

			function go() {
				setFiring(true);
				setLeft(0);
				post('restart', { caller: 'header-button' })
					.then(function (payload) {
						if (!payload || !payload.ok) {
							setFiring(false);
							setDead(true);
							setNote('宿主拒绝了这次重启');
							return;
						}
						// 宿主应该在 1.5 秒后自己退出；6 秒还没动静，就是没退成
						setTimeout(function () {
							setFiring(false);
							setDead(true);
							setNote('宿主没有按预期退出，看日志');
						}, 6000);
					})
					.catch(function () {
						// 宿主正在退出，fetch 断掉是预期内的，不当错误
						setFiring(false);
					});
			}

			useEffect(
				function () {
					if (left <= 0) return undefined;
					var timer = setTimeout(function () {
						if (left <= 1) go();
						else setLeft(left - 1);
					}, 1000);
					return function () {
						clearTimeout(timer);
					};
				},
				[left],
			);

			function onClick() {
				if (dead || firing) return;
				if (left > 0) {
					setLeft(0); // 再点一下 = 取消
					return;
				}
				setLeft(COUNTDOWN);
			}

			var state = firing ? 'firing' : left > 0 ? 'counting' : dead ? 'dead' : 'idle';
			var mode = view && view.mode === 'full' ? 'full' : 'host';
			var title = dead
				? '重启：' + (note || '宿主路由不可用（插件可能没装好，或者宿主已经不在了）')
				: firing
					? '宿主正在退出。页面会失联十几秒，回来之后按一下 F5 就是新代码。'
					: left > 0
						? '再点一下取消。' + COUNTDOWN + ' 秒后重启。'
						: [
								mode === 'host'
									? '重启 DSH：让当前宿主进程退出，外壳会把它重新拉起来。'
									: '完整退出并重新拉起 DSH（helper 脚本负责收尸和点灯）。',
								'当前会话会保存；正在跑的回合会被打断。',
								'页面若失联就按 F5；半分钟还没回来，双击桌面的「重启 DSH.cmd」。',
								view && view.logFile ? '日志：' + view.logFile : '',
								view && view.problems && view.problems.length > 0 ? '注意：' + view.problems.join('；') : '',
							]
								.filter(function (line) {
									return line;
								})
								.join('\n');

			var content =
				left > 0 && !firing
					? react.createElement('span', { className: 'dsrb-num', key: 'num' }, String(left))
					: refreshIcon();

			return react.createElement(
				'button',
				{
					type: 'button',
					className: 'dsrb-btn',
					'data-state': state,
					'data-dsh-restart-button': 'true',
					title: title,
					'aria-label': title,
					onClick: onClick,
				},
				content,
			);
		}

		var inject = ['slots'];

		function apply(ctx) {
			if (!ctx || !ctx.slots) return;
			try {
				ctx.slots.inject(SLOT, function () {
					return ctx.slots.register({ name: SLOT, id: ID, order: ORDER }, RestartButton);
				});
			} catch (error) {
				try {
					window.__dshRestartButtonError = String((error && error.message) || error);
				} catch (_) {}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
