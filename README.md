# pi-mcp-status

在 TUI 里显示 pi **built-in MCP** 的启动加载情况。不接管、不替换、不额外连接，built-in MCP 逻辑保持原样。

## 它能显示什么

打开 pi 时在编辑器上方显示一个面板，逐行列出 MCP server（最差的排在最前）：

```
MCP 1/3 connected · 1 unresponsive
 ✗ slack       failed or needs sign-in · codemode
 ◌ filesystem  connecting 23s · codemode
 ✓ github      42 tools · deferred
 – legacy      codemode
 /mcp-status to toggle · /mcp to manage
```

同时底栏常驻一行：`MCP 1/3`（有 unresponsive 时变成 `MCP 1/3 · 1!`）。

### 面板何时收起

`/mcp-status` 把面板分为三种状态：

| 状态 | 怎么进入 | 行为 |
| --- | --- | --- |
| auto | 每次 session 启动 | 首个 prompt 后收起；所有 server 都 settle 后 3 秒也会自动收起 |
| pinned | `/mcp-status on`，或收起后再 `toggle` | 常驻，不会被自动收起，也不会被下一个 prompt 收起 |
| hidden | `/mcp-status off`，或 auto 面板收起后 | 不显示 |

命令参数：`toggle`（默认）、`on`、`off`、`color [on|off]`。

只有配置错误、没有任何有效 server 时，面板也会显示，并一直留到首个 prompt，避免错误被悄悄吞掉。

### 状态怎么判定

- **connected**：该 server 的工具已注册（被 built-in 撤回的 `hidden` 工具不计入）。
- **connecting**：还没有工具。超过 10 秒后行内显示已等待的秒数。
- **unresponsive**：等待超过该 server 的 `timeout`（默认 60 秒，与 built-in 一致）再加 2 秒。它覆盖“连接失败”和“需要登录”两种情况，因为 built-in 不在这里报告区别。之后一旦连上，状态会自行恢复。
- **disabled**：`enabled: false`。

轮询：存在 connecting 的 server 时每 400ms，否则每 3 秒。每次轮询还会检查配置有没有变化（两个 `mcp.json`、项目是否受信、扩展注册的 server），因此在 `/mcp` 里启停 server、手改 `mcp.json`、或有扩展延后注册 server，面板都会跟着更新，不需要重启 session。每个 server 单独计时：新加入或重新启用的 server 从那一刻开始等待。

### 配置错误

配置的校验规则与 built-in 一致（`type: "sse"`、`enabled` 不是布尔值、`timeout` 非正数、`args/env/headers` 类型错误、`oauth`/`auth` 规则、项目文件里的 `auth`、override 带了 `enabled/exposure/toolExposure` 以外的字段等）。built-in 会拒绝的条目显示为配置错误，而不是一个永远无响应的 server。`a-b` 与 `a_b` 同属 `mcp__a_b` 命名空间，后者报 `conflicts with`，与 built-in 一致。

## 安装 / 加载

```bash
pi install git:github.com/lemonorangeapple/pi-tui-mcp
```

本地开发，直接按文件加载：

```bash
pi -e ./extensions/mcp-status.ts
```

或作为 package 安装到 personal settings：

```bash
pi install ./            # 在本目录执行
```

`package.json` 里通过 `pi.extensions` 声明入口。入口会引用 `src/` 下的模块，请保持整个目录一起安装。

## 工作原理与限制

pi 的 built-in MCP（`dist/extensions/mcp/`）把连接状态保存在闭包里，**没有状态 API、没有连接事件、不写状态文件**。因此本扩展只用它确实暴露的东西：工具注册表。

server 连上后，built-in 会注册 `mcp__<server>__<tool>`，namespace 为 `mcp__<server>`。本扩展：

1. 读取 `~/.pi/agent/mcp.json`、受信项目的 `.pi/mcp.json`，以及 `pi.getMcpServers()`（扩展注册的 server），按 built-in 的优先级合并。
2. 轮询 `pi.getAllTools()`，按 namespace 归类，得到连上的 server 和工具数。

由此：

- **无法**拿到真实错误文本。真正失败的 server（命令不存在、需要登录）要等到 `timeout` 之后才会标成 `unresponsive`，默认约 62 秒；在此之前显示 `connecting`。
- 一个**连上但没有工具**（比如只提供 resources）的 server 无法被检测到，会一直显示 connecting，之后是 unresponsive。
- 用 `toolExposure` 把一个 server 的**全部**工具都设为 `hidden`，同样会被看成没有工具。
- 连上之后**掉线**无法被感知：built-in 不会撤回已注册的工具，所以仍显示 connected。
- 只读观察，不会触发连接，也不会影响 built-in MCP、`/mcp` 管理器或 codemode。本扩展**不**订阅 `mcp_servers_change`：处理该事件会让扩展被标记为“负责连接 registered server”的那一个，干扰 built-in。

完整管理（登录、重连、启停、exposure）请用 built-in 的 `/mcp`。

## 与 pi-footer 联动

装了 [pi-footer](https://github.com/wobondar/pi-footer) 时，本扩展会把同一份 MCP 状态按它的事件控件契约发出去（`pi.events` → `pi-footer:update-widget`）：

| Widget ID | 内容 |
| --- | --- |
| `mcp_status` | `MCP 1/3`，有 unresponsive 时 `MCP 1/3 · 1!` |
| `mcp_servers` | `✗slack ◌filesystem ✓github(42) –legacy` |
| `mcp_indicator` | 紧凑状态 token，适合塞进任意 footer 行：`● MCP 2/4`（全部连上）、`◌ MCP 1/4`（仍在连）、`✗ MCP 1/4`（有失败）、`– MCP`（全 disabled） |
| `mcp_indicator_color` | 同 `mcp_indicator` 的内容，但自带 ANSI 颜色，随状态自动变化：全连上=success、仍在连=accent、有 unresponsive=error、全 disabled=dim。颜色取自 pi 主题，所以“绿/黄/红”取决于主题 |

用法：在 pi-footer 里加一个 **Pi Event Value** 控件，Widget ID 填其中之一。要行内变色指示时选 `mcp_indicator_color`（自动变色，别再给控件设 fg，否则会在 token 结束后重置回默认色）；要由控件 fg 统一控制颜色时选 `mcp_indicator`。也可以继续用 **Pi Extension Status** 控件或 `Pi extensions` 菜单读取 status key `mcp`（内容等同 `mcp_status`）。

### 自动变色

`mcp_indicator_color` 的颜色由扩展在 value 里嵌入 ANSI 实现（pi-footer 默认保留 event value 的 ANSI）。状态取“最差优先”：只要有一个 server unresponsive 就是 error，其次是 connecting 的 accent，然后是全 disabled 的 dim，其余为 success。

- `/mcp-status color` 切换自动变色，`/mcp-status color on` / `color off` 显式开关。关闭时会向 `mcp_indicator_color` 发送 `null` 清空。
- 开关是运行时状态，不写入配置。改主题后，颜色会在下一次轮询（最多 3 秒）内刷新。
- 主题暂时取不到颜色时，该 widget 回退为不带颜色的 token，而不是被清空。

其他约定：

- 值只在变化时发布；session 启动会重发当前值，`session_shutdown` 发送 `null` 清空（pi-footer 的值是内存态）。
- pi-footer 不在也不报错，事件总线没有监听者而已；未来 pi 没有 `pi.events` 时会被静默忽略。
- 本扩展不调用 `ctx.ui.setFooter`，不接管 footer，显示什么完全由 pi-footer 配置决定。

## 开发

```bash
npm install
npm run typecheck   # tsc --strict
npm test            # node:test，假 pi + 假 TUI + mock timers，不需要真实 pi 进程
```

- `extensions/mcp-status.ts`：只做 pi 接线（命令、事件、定时器）。
- `src/config.ts`：读取并合并配置、namespace 判重、配置签名。
- `src/validate.ts`：**手工镜像** built-in 的 `validateMcpServerConfig`（pi-coding-agent 1.1.0，该函数没有导出）。升级 pi 时先对照其 `core/mcp-servers.js`，并同步 `test/validate.test.ts`。
- `src/status.ts`：从工具注册表推断状态、按 server 计时。
- `src/format.ts`：面板与 footer 文案。
- `src/panel.ts`：面板 auto/pinned/hidden 状态机。
