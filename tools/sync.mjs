/**
 * dsh-restart-button · 把源码同步进运行时那份拷贝
 *
 * 为什么需要它：profile 的 pnpm-workspace.yaml 设了 `nodeLinker: hoisted`，
 * 本地 `file:` 依赖不是软链，而是装的时候抄一份（两份独立的数据，实测不是硬链接）。
 * 于是改了 lib/ 或 client/ 之后：
 *   1. 运行时那份 node_modules\dsh-restart-button 还是旧的（脚本负责这一步）
 *   2. 宿主进程里已加载的 ESM 模块还是旧的（只能重启，脚本只能提醒）
 *
 * 这个插件多同步一个 tools/：helper 脚本也得跟着过去，
 * 否则运行时那份找不到 restart-dsh.ps1，点了按钮只会写字说找不到文件。
 *
 * 用法：node tools/sync.mjs [profileName]
 * 默认 profile 是 desktop。
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));

const profile = process.argv[2] ?? 'desktop';
const runtime = join(homedir(), '.dsh', 'profiles', profile, 'node_modules', pkg.name);

if (!existsSync(runtime)) {
	console.error(`找不到运行时目录：${runtime}`);
	console.error(`先在 DSH 里把 ${pkg.name} 装成 bundle，或确认 profile 名字。`);
	process.exit(1);
}

let copied = 0;
for (const dir of ['lib', 'client', 'tools']) {
	const from = join(source, dir);
	if (!existsSync(from)) continue;
	cpSync(from, join(runtime, dir), { recursive: true, force: true });
	copied++;
}

console.log(`已同步 ${copied} 个目录 -> ${runtime}`);

// 核对：逐文件比内容。
// 比大小不够 —— 改完长度没变的情况会被漏掉，而那恰恰是最难发现的一种。
const md5 = (file) => createHash('md5').update(readFileSync(file)).digest('hex');
const check = ['lib/index.js', 'client/index.js', 'tools/restart-dsh.ps1', 'tools/restart-dsh.cmd'];
for (const rel of check) {
	const a = join(source, rel);
	const b = join(runtime, rel);
	if (!existsSync(a) || !existsSync(b)) {
		console.log(`缺失 ${rel}`);
		continue;
	}
	const same = md5(a) === md5(b);
	console.log(
		`${same ? 'OK  ' : '差异'} ${rel}${same ? '' : `  source=${statSync(a).size}  runtime=${statSync(b).size}`}`,
	);
}

console.log('');
console.log('还差一步：完全退出并重开 DeepSeek Harness。');
console.log('宿主进程里已加载的模块不会被换掉，改了代码必须重启才生效。');
console.log('（装好之后这件事就可以点侧边栏底部那个「重启」了。）');
