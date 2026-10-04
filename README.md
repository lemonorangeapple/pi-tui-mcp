# pi-mcp-status

在 TUI 里显示 pi **built-in MCP** 的启动加载情况。不接管、不替换、不额外连接，built-in MCP 逻辑保持原样。

## 它能显示什么

打开 pi 时在编辑器上方显示一个面板，逐行列出 MCP server：

```
MCP 2/4 connected · 1 unresponsive
 ✓ github        connected · 42 tools · deferred
 ◌ filesystem    connecting…
 ✗ slack         failed or needs sign-in · codemode
 – legacy        disabled
 /mcp-status to toggle · /mcp to manage
```

同时底栏常驻一行：`MCP 2/4`（有 unresponsive 时变成 `MCP 2/4 · 1!`）。

- 面板在**首个 prompt** 后收起；若所有 server 已 settle，也会在 3 秒后自动收起。
- `/mcp-status` 重新展开 / 收起，参数：`toggle`（默认）、`on`、`off`。
- 轮询：连接阶段每 400ms，超过 15s 后每 3s（持续更新，late connect 也会反映）。

## 安装 / 加载

本地开发，直接按文件加载：

```bash
pi -e ./extensions/mcp-status.ts
```

或作为 package 安装到 personal settings：

```bash
pi install ./            # 在本目录执行
```

`package.json` 里通过 `pi.extensions` 声明入口。

## 工作原理与限制

pi 的 built-in MCP（`dist/extensions/mcp/`）把连接状态保存在闭包里，**没有状态 API、没有连接事件、不写状态文件**。因此本扩展只用它确实暴露的东西：工具注册表。

server 连上后，built-in 会注册 `mcp__<server>__<tool>`，namespace 为 `mcp__<server>`。本扩展：

1. 读取 `~/.pi/agent/mcp.json`、受信项目的 `.pi/mcp.json`，以及 `pi.getMcpServers()`（扩展注册的 server），按 built-in 的优先级合并。
2. 轮询 `pi.getAllTools()`，按 namespace 归类，得到连上的 server 和工具数。

由此：

- **无法**拿到真实错误文本。15 秒内没连上的会标为 `no response`（覆盖连接失败和需要登录两种情况）。
- 一个**连上但没有工具**（比如只提供 resources）的 server 无法被检测到，会一直显示 connecting/no response。
- 只读观察，不会触发连接，也不会影响 built-in MCP、`/mcp` 管理器或 codemode。

完整管理（登录、重连、启停、exposure）请用 built-in 的 `/mcp`。
