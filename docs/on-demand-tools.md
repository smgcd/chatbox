# MCP 工具与 Skill 的按需加载

每个请求原本都要带上「所有已装 MCP 工具的完整 JSON schema」和「所有已启用 skill 的名称+描述」。
工具越多，这部分越像固定税：它和当前任务无关，却按请求、按轮次重复计费，还挤占上下文窗口。

本仓库（`cd-main` 分支，自编译线）把它改成按需加载：**首包只带工具名字**，模型需要时自己把定义拉进来。

## 实测成本（2026-11-02，本机 4 个 MCP 服务器）

用 `@modelcontextprotocol/sdk` 直连各服务器 `listTools()`，对 `name + description + inputSchema`
做 `JSON.stringify` 取真实字符数（不是估算）：

| 项 | 改前 | 改后 |
|---|---:|---:|
| local-llm（3 个工具） | 1,962 | 68 |
| scrapling（13 个） | 57,177 | 211 |
| playwright（25 个） | 18,365 | 498 |
| chrome-devtools（32 个） | 27,742 | 506 |
| **MCP 合计（73 个）** | **105,246** | **1,286** |
| Skill（43 个，名称+描述） | 13,327 | 732 |
| `search_tools` / `search_skills` 自身定义 | 0 | ≈900 |
| **每次请求合计** | **≈118,600** | **≈2,900（−97.5%）** |

≈ 33,000 → 800 token/请求（英文按 ~3.6 字符/token）。一轮 18 次请求的任务少发约 210 万字符。

## 机制

**MCP 工具**：仍然照旧注册进 `ToolSet`（这样被加载后能真正执行），但每个都打上 `deferLoading: true`。
AI SDK 在生成循环里对每一步执行 `filterActiveTools` → `prepareToolSearch`，把「尚未被发现的 deferred 定义」
从请求中移除；模型调用搜索工具后，命中的工具从**下一步**开始进入请求。

```ts
// src/renderer/packages/model-calls/toolsets/tool-search.ts
markToolsAsDeferred(mcpController.getAvailableTools(allowedServers))  // 打 deferLoading
tools[SEARCH_TOOLS_TOOL_NAME] = toolSearch({ maxResults: 8, search: rankDeferredToolNames })
```

- **不要自己再用 `prepareStep` 的 `activeTools` 去门控 deferred 工具**：SDK 的 `prepareToolSearch` 跑在
  `filterActiveTools` **之后**（`ai/dist/index.js` 里 `stepActiveTools` → `prepareToolSearch(stepActiveTools)`），
  自己再筛一遍会让搜索候选集变成空，永远搜不到东西。
- 排序用我们自己的 `rankDeferredToolNames`：官方默认分词按 camelCase 切词、按整词匹配，**中文 query
  匹配不到英文描述**；这套按服务器名加权 + 子串匹配，并支持 `*` 列全表。
- 官方会 rebind 搜索工具的 `execute`（把候选注入），但保留我们塞进去的 `toModelOutput`，所以工具结果
  文本仍能截断成一行预览。

**Skill**：启用数量超过 6 个（`COMPACT_SKILL_LIST_THRESHOLD`）时，提示词只列名字，描述改为
`search_skills` 按关键词按需返回；6 个以内仍带描述（短列表读全文比多一次往返便宜）。

**提示词**：`instructions` 末尾追加 `## Tools on Demand`，内容是**按服务器分组的纯名字目录**加加载步骤说明，
约 1.3KB，让模型能瞄准搜索而不是瞎猜。

## 取舍（明确写下来）

1. **加载工具会把 schema 加回来**：本轮真要用哪几个就为哪几个付钱。加载 3–5 个 playwright 工具约 2–5KB，
   仍远低于 105KB；只有 73 个全加载才会超过旧成本。
2. **加载状态只在本轮生成内有效**，下一轮请求重置。这样每次请求开头的工具表完全一致 —— 对 provider
   的前缀缓存友好（deferred 工具被发现时，工具表会变，对应前缀缓存会失效，这是该方案的固有代价）。
3. 模型直接调用未加载的工具会得到 `AI_NoSuchToolError`（被 SDK 转成 invalid tool-call 分片，**不中断生成**），
   它看到错误后会自己 `search_tools` 再调，最多浪费一步。
4. 提示词里保留了工具名，模型按名字搜中的概率高，但**仍必须先加载再调用**。

## 怎么验证它真的生效

1. **新会话的系统提示形态**（最快）：MCP 段变成 `### MCP tool catalog` 只列名字 + `### Loading a tool`,
   函数表里没有 `mcp__*` 的 schema。
2. **`logs\main.log` 的 MCP 传输日志**（机器证据）：
   - 枚举：`[mcp:stdio-transport] send … { method: 'tools/list' }`
   - **真执行**：`method: 'tools/call'` ← 只有这个说明真的用了 MCP 工具
   - 每次执行另有 `[skills:user-exec] agent_operation start {… "sessionId": "<id>" …}`，可按会话反查
   - 注意：任务只用了本地工具（run_command / write_file）时不会出现 `tools/call`，这种会话验不了这条路径。
3. **集成测试**：`src/renderer/packages/model-calls/toolsets/tool-search.test.ts` 用 `MockLanguageModelV3`
   真跑 `generateText` 三步，逐包断言「第一包不含 deferred 定义 → search 后第二包出现 → 且真的执行」。

## 代码入口

| 文件 | 作用 |
|---|---|
| `src/renderer/packages/model-calls/toolsets/tool-search.ts` | `markToolsAsDeferred` / `rankDeferredToolNames` / `buildToolSearchTool` / 名字目录 |
| `src/renderer/packages/model-calls/toolsets/skill-search.ts` | `search_skills` 与打分 |
| `src/renderer/stores/session/tools-builder.ts` | 组装工具集：MCP 打 deferred、skill 超阈值压缩、追加 `## Tools on Demand` 目录 |
| `src/renderer/stores/session/agent-harness.ts` | 把工具集交给生成循环（不再自行 gate deferred） |
| `packages/chatbox-core/src/mcp/controller.ts` | `getAvailableTools()`，工具名形如 `mcp__<server>__<tool>` |
