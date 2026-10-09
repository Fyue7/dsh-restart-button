# dsh-restart-button

会话头部右侧那一排里的那颗「⟳」（就在那颗文件夹图标右边一格，纯图标，不带字）：**完全退出 DeepSeek Harness，再把新实例拉起来。**

给"改了插件代码 → 必须重启才生效"这件事准备的。点击到界面回来约 8 秒，全程没有终端窗口。

## 怎么工作的

宿主自己就是那个要被关掉的东西，而且**它所在的那棵进程树是一个作业对象：树里的一切连同宿主一起死**。
所以流程分成"找死"和"活着"两只手：

```
点 ⟳（3 秒倒计时，可取消）
  └─ 宿主：spawn helper（PowerShell）→ 立刻回 HTTP 响应
       └─ helper（restart-dsh.ps1）：
            1. 写 relay-config.json（参数）和 relay-launch.vbs（无窗口入口）
            2. schtasks 建一次性任务并运行：
               动作 = wscript.exe //B relay-launch.vbs
               wscript 是 GUI 子系统程序，系统不给它建控制台；VBS 再以窗口样式 0 跑拉起器
               不成就退到 WMI，再退到 Shell.Application，最后才是自己拉
            3. 回读日志，确认出现新的 `relay start` —— 确认它活着，才继续
            4. 软杀 2 秒 → 强杀（CloseMainWindow / Stop-Process）
            5. 退出。它会被作业对象带走，无所谓了
       └─ 拉起器（relaunch-dsh.ps1，隐藏运行，活在外面）：
            读 relay-config.json
            → 等旧实例真的消失（每 250ms 轮询，最多 20 秒；等不到就退出不启动）
            → 用 explorer.exe 起 DSH（不继承控制台）
            → 等 127.0.0.1:19387 重新监听 → 删掉计划任务 → 记一行 ok
```

## 为什么是这些形状（每条都是实测换来的）

1. **不能用 `node:child_process`**：从宿主里 spawn 出来的子进程 63 毫秒就"退出 0"，脚本一行都没跑。
   改用 DSH 自己的 `ctx.subprocess`（工具调用走的就是它）。
2. **拉起器必须由服务创建**：作业对象连坐。`Shell.Application` 转发看着成功，实测那个进程仍在作业里，
   在宿主死的同一瞬间被杀。只有计划任务 / WMI 创建的进程能活。
3. **必须先确认它活着才动刀**：不然杀了之后没人拉，DSH 就死在那儿。
4. **DSH 必须由 explorer 起**：`Start-Process` 会让 DSH 成为当前控制台的子进程，Chromium 会主动 attach 上去，
   于是那个窗口在 DSH 活着期间不会关，而关掉它会给 DSH 发 CTRL_CLOSE —— DSH 跟着死。
5. **计划任务的动作必须是 GUI 子系统程序**：这台机器默认终端是 Windows Terminal，
   `powershell.exe -WindowStyle Hidden` 拦不住 WT 窗口（`GetConsoleWindow` 都返回 0）。wscript 才真没有窗口。
6. **`.ps1` / `.cmd` 一律纯 ASCII**：PowerShell 5.1 读没有 BOM 的 .ps1 按 ANSI/GBK 解释，
   UTF-8 中文注释会**吃掉换行**，把下一行代码并进注释里静默不执行（曾让 `$alive = Get-Targets` 消失，
   日志显示 `alive=0`，我为此查了三轮）。校验：`Select-String -Pattern '[^\x00-\x7F]'` 应为空。
7. **别用 `$home`**：它和自动变量 `$HOME` 同名（不区分大小写），赋值静默失效，
   relay-config.json 曾被写到 `C:\Users\<user>\` 根下。用 `$pluginHome`。
8. **`schtasks /TR` 上限 261 字符**：所以任务不传参数，参数走 relay-config.json。

## 装法

```powershell
# 1. 接进 profile（file: 依赖 + bundles 行 + pnpm install）
#    推荐直接用 DSH 的插件管理器装这个 spec：
#    file:E:/agent/projects/dsh-restart-button

# 2. 刷新页面（Ctrl+Shift+R）
```

改这个插件的代码：

```powershell
node E:\agent\projects\dsh-restart-button\tools\sync.mjs
# 然后点会话头部那颗 ⟳
```

`sync.mjs` 那一步不能省：profile 用的是 `nodeLinker: hoisted`，`file:` 依赖是硬链接拷贝。
但两个 `.ps1` 不需要 —— 它们每次都是现读的。

## 用法

- **界面**：会话头部右侧那一排，文件夹图标右边一格，只有一个 ⟳。点一下 3 秒倒计时，再点一下取消。
- **命令**：`/restart now`、`/restart dry`（空转自检，只报账不动手）、`/restart status`。
- **桌面兜底**：`重启 DSH.cmd`（界面挂了也能用，走同一个 helper）。

## 日志

`~/.dsh/dsh-restart-button/restart.log`。一次成功的重启：

```
helper start: pid=4516 exe='E:\DeepSeek Harness\DeepSeek Harness.exe' grace=2s caller='header-button' consoleHidden=False
relay: arming (baseline relay-start lines = 8, config = '...\relay-config.json', launcher = '...\relay-launch.vbs', taskCmdLength = 92)
relay: schtasks create -> 成功: 成功创建计划任务 "dsh-restart-button-relay"。
relay start: pid=35280 exe='E:\DeepSeek Harness\DeepSeek Harness.exe' wait=20s port=19387
relay armed via: schtasks
stage1: alive=7 pid=16928,20316,27764,34312,35084,35612,35664
stage2: force kill 7 pid=...
relay: old instance is gone, launching in 600ms
relay launched via explorer: E:\DeepSeek Harness\DeepSeek Harness.exe
relay: new instance visible = True
ok: 127.0.0.1:19387 is listening again
relay: scheduled task removed
```

## 已知边界

- **只支持 Windows**：计划任务、WMI、镜像名收尸、控制台语义，全是 Win32 玩法。
- **会打断正在跑的回合**：所以有 3 秒倒计时。
- **需要计划任务或 WMI 至少一个可用**：都被策略封掉的机器上，会退到 shell / inline，那时窗口可能又出现
  且不一定起得来；`relay abort` 那几行会说明是卡在哪一步。
- **helper 自己那个控制台窗口**：它由插件的 `ctx.subprocess` 拉起，可能闪一下（约 8 秒内随 helper 退出消失）。
  要彻底消除得让插件改走 `wscript` 调 helper，那是宿主半的改动，需要一次宿主重载。
- **不是官方插件**：跟着 DSH 版本走，宿主那层的服务名变了就得跟着改。
