# dsh-live-run

任务运行时的**实时运行面板**：一个侧栏 tab 里同时看到

1. **当前文件** — 模型此刻正在读/写/改的文件，正文带行号；编辑显示行级 diff（红删绿增）
2. **写入过程** — 每一次 read / write / edit，时间、类型、路径、行数变化；点一行钉住它
3. **命令输出** — 运行中的 pwsh/bash 任务，stdout/stderr **流式滚动**，可切换多个任务

## 数据从哪来（没有任何新采集）

| 面板 | 来源 | 说明 |
|---|---|---|
| 当前文件 / 写入过程 | 会话的 Chat 快照（`uiSession` → `hooks.conversation`） | 模型工具调用与结果本来就在会话里，含**正在执行**的调用；工具从 `run_code`/`pwsh` 里直接调 `writeFileSync` / `Set-Content` 也会被识别 |
| 命令输出 | `ctx.jobs`（client jobs 服务） | job 注册表的环形输出缓冲，`observe(jobId)` 是**只读观察**，不移动模型自己的读取游标 |
| 面板位置 | `betterSidebar.registerTab` | 出现在侧栏「+」菜单里，单实例 |

不需要 host 路由、不需要 RPC、不需要构建步骤：`lib/client.js` 是手写的 CJS 工厂 bundle（`react` 是页面模块表的平台种子）。

## 用法

1. 右侧栏（better-sidebar）**+** → 选「实时运行」
2. 让 agent 干活：读写文件、跑命令，面板自动跟随
3. 想看某个历史文件 → 在「写入过程」里点它（钉住，不再跟随最新）；点「跟随最新」恢复
4. 有多个命令任务时，用标题栏右侧的小按钮切换
5. **长命令**：标题栏只显示一行摘要；面板里有完整的 `$ 命令` 块——默认折叠成一行（悬停可看全文），点「展开」自动换行并可滚动，点「折叠」收回去；旁边「复制」直接复制整条命令。标题栏本身禁止收缩，不会被长命令挤成竖排。
6. **展开状态会被记住**：按「会话 + 命令」记，不是全局开关——展开 A 命令不会让 B 也展开；关掉面板再打开、切换会话再回来、刷新页面（同一标签页）都保持你上次的选择。新命令默认折叠。

## 设置（设置 → 侧边卡 → 实时运行）

两个开关都是插件私有的（better-sidebar 的 `settings.pluginToggles`，存在侧边卡的 `pluginSettings['dsh-live-run:pane']` 里，不走宿主 schema，改完立即生效）：

| 开关 | 默认 | 开 | 关 |
|---|---|---|---|
| 记住展开/折叠状态 | 开 | 按会话 + 命令记忆，重挂载/刷新都不丢 | 只用组件状态；**关闭时立即折叠当前命令块并清空该会话已存记录**（再打开不会复活旧状态） |
| 复制为可粘贴的一行 | 关 | 安全时折成一行；不安全时按原样复制并说明原因 | 复制命令原文 |

「折成一行」的规则与边界：

- 语句之间用 `; ` 拼；续行符（`|` `,` `{` `(` `[` `&` `=` `+` `-` `*` `/` `%` 等）、行尾反引号后的续行用空格拼
- **拒绝折叠**（改为原样复制并提示）：here-string / heredoc、注释、跨行字符串——这三类拼起来要么报错，要么**静默改语义**（跨行字符串会把 `; ` 塞进字符串内容里）
- PowerShell 规则用本机真实解析器验证过：`node tools/feasibility-one-line.mjs` 产出候选，再用 `[System.Management.Automation.Language.Parser]::ParseInput` 判分（12 个样本：9 个可安全一行化且解析 0 错误，3 类拒绝）。bash 分支同一套形状，但只做了保守实现，未做同类实测。

## 能力边界（如实说明）

- **前台命令**同样会出现在面板里：`dsh-tool-pwsh` 每次调用（含前台）都会先在 jobs 注册表登记，再等待结果，所以面板能看到它**边跑边输出的过程**——对话里的工具卡片要等跑完才有结果，这里不用。
- **前台命令结束后**，它的 job 记录会被注册表 `remove()` 掉（给前台调用者的清理约定）。面板因此保留"结束前观测到的最后一段输出"，并在没有活动 job 时自动回落到**会话记录里的 shell 调用结果**（标「会话记录」）。三层来源：实时 job → 最后观测 → 会话历史。
- 「写入过程」按 **op 粒度**（一次 read/write/edit 一条），不是逐字符输入流；正在执行的那条显示 `…`，结束后补上正文与行数。
- 环形缓冲有上限：输出过长时最早的部分会被丢弃，面板会标出「输出被丢弃」。
- 面板依赖 better-sidebar 提供 tab 位；未安装时不会渲染任何东西（不会报错，也不影响 DSH 启动）。
- 展开状态存在两层：模块内存（页面生命周期，一次挂载到另一次挂载都有效）+ `sessionStorage`（按会话 id 存，刷新页面仍在）。关掉整个标签页会清掉 sessionStorage 那份；内存那份也不跨页面。默认折叠的命令不占存储（折叠即删除该条），每个会话最多记 200 条。
- 本部署若没有 `jobs` 客户端服务，命令区不会假装有实时流，而是直接用会话记录里的 shell 结果；一个 shell 调用都没有时明确提示。

## 文件构成

```
package.json                 dsh.client(platform:web) + dsh.bundle(patch)
cordis.patch.yml             一条 insert 层
lib/index.js                 host 半体：只保留插件身份（无路由、无服务）
lib/client.js                浏览器半体：数据钩子 + tab 注册 + UI（手写 CJS 工厂 bundle，无构建）
locale/zh.json               插件市场展示文案
tools/smoke.mjs              37 项离线测试（自写迷你 React 运行时，真跑数据通路）
tools/verify-install.mjs     校验 profile 解析到的就是我这份字节、且只请求 react
tools/feasibility-one-line.mjs  一行化规则的可行性实验（供 PowerShell 解析器判分）
LICENSE                      MIT
```

## 安装

需要先有 **dsh-better-sidebar**（本插件通过它的 `registerTab` 提供面板），以及一个 DSH Web profile。

```bash
git clone https://github.com/Prcjimmy1015/dsh-live-run.git
cd ~/.dsh
dsh plugin --profile desktop add "file:<clone 的绝对路径>"
```

装完刷新页面，右侧栏 **+** → 「实时运行」。

> 用 `file:` 而不是 `github:`：本机 codeload.github.com 经代理不可用，`github:`/`git+https://` 形式的依赖会 fetch failed（这是环境限制，不是插件问题）。

## 验证

```bash
node tools/smoke.mjs          # 37 项，必须全绿
node tools/verify-install.mjs # 需要已装到某个 profile；用 DSH_LIVE_RUN_PROFILE 指定其它 profile 绝对路径
```

## 许可

MIT

