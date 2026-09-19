# dsh-wait-subagent

<p align="center">
  <a href="./README.md"><strong>English</strong></a> ·
  <a href="./README.zh-CN.md"><strong>简体中文</strong></a>
</p>

一个 DeepSeek Harness（cordis）插件，注册 `wait_subagent` 工具：**主动阻塞等待指定的后台 continuable 子代理收尾（settle），并在同一次调用里拿到它的停止原因与收尾消息**。

它补齐了子代理工作流的一个真实缺口：`run_in_background` 立即返回 `subagentId`，但想知道结果只能被动等异步 settlement 通知——此前没有任何工具能主动等待子代理完成。

## 真实输出

以后台方式启动子代理，然后等待它：

```
wait_subagent({ subagent_id: "session-9f2c47ab-83d1-4e06-b5a9-1c7f2d84e0b3" })
```

子代理运行期间该调用阻塞。子代理收尾后工具返回：

```json
{
  "status": "settled",
  "subagent_id": "session-9f2c47ab-83d1-4e06-b5a9-1c7f2d84e0b3",
  "stop_reason": "completed",
  "closing_message": "Spec written to docs/plan.md; 3 files changed, ready for review."
}
```

模型看到的文本：

```
Subagent session-9f2c47ab-83d1-4e06-b5a9-1c7f2d84e0b3 settled: completed
Spec written to docs/plan.md; 3 files changed, ready for review.
```

其他结果：

| 情形 | 返回 |
|---|---|
| 调用前子代理已收尾 | `{ "status": "settled", "subagent_id": "…", "stop_reason": "unknown" }` —— *"had already settled before this call; its closing message was delivered separately as a settlement notice."* |
| `timeout_ms` 超时 | `{ "status": "timeout", "subagent_id": "…" }` —— *"Timed out waiting for subagent …; it may still be running."* |
| 调用方的 `AbortSignal` 触发 | `{ "status": "cancelled", "subagent_id": "…" }` |
| 未知 / 不属于自己的子代理 id | 直接报错：*"… is not one of your subagents — pass the id a background dispatch returned (see list_agents)"* |

## 为什么需要它

现有子代理系统能给你的：

- `subagent` + `run_in_background: true` → 立即返回 `subagentId`，工作异步继续，稍后才送达 settlement 通知。
- `subagent` + `run_in_background: false` → 只在**启动**时阻塞。
- `send_message` → 发完即返回，从不等待回答。
- `list_agents` → 快照，不是等待（且明确提示"不要用来轮询"）。

缺的是：后台启动子代理之后，没有工具能**阻塞等待它完成**。这正是 `wait_subagent` 做的事——当你的下一步依赖子代理的结果时用它，而不是靠猜或轮询。

## 工作原理

- 在每个 root agent 上注册 `wait_subagent` 工具（与 `dsh-proactive` 相同的注册模式）。
- **成员资格门控**：`ctx.subagents.listChildren(parent.id)` —— 与 `list_agents` 读的同一个 projection —— 同时覆盖存活与仅存于存储的子代理，未知 id 直接报错，而不是被误报为已收尾。已知子代理若不在存活注册表中，说明早已收尾。
- 工具监听 `subagent/end` 生命周期事件（子代理 activation 被释放时触发），作用域挂在插件上下文上（所有 agent 上下文的公共祖先）。
- 收尾时，子代理从存活注册表移除与 `subagent/end` 派发发生在同一个同步块里（`finishDisposal`），因此"先挂监听、再复查注册表"的顺序无竞态。
- 可选 `timeout_ms` 参数：超时未收尾则返回 `status: "timeout"`。省略则无限等待——通常这是最佳选择；若要设置，请给足量级（分钟级），不要用反复短等待轮询。
- 尊重调用方的 `AbortSignal`（返回 `status: "cancelled"`）。

## 工具签名

```
wait_subagent(subagent_id: string, timeout_ms?: integer)
→ { status: "settled" | "timeout" | "cancelled",
    subagent_id: string,
    stop_reason?: "completed" | "aborted" | "error" | "max-tokens" | "refusal" | "unknown",
    closing_message?: string }
```

## 注意：不要在同一步里既等待又打断

`wait_subagent` 是并发安全的，但 `interrupt_agent` 不是——它独占工具通道，会排在任何进行中的调用之后。在同一步并行发起 `wait_subagent` 和 `interrupt_agent` 会被串行化：等待先跑满超时，打断才落地。请先调用 `interrupt_agent`，下一步再 `wait_subagent`（已被打断的子代理会很快收尾）。

## 安装

```bash
dsh plugin --profile web add dsh-wait-subagent
```

或从 GitHub 直装（源码安装——纯 ESM JavaScript，无构建步骤，pnpm ≥ 10 无需 allowBuilds 批准）：

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-wait-subagent
```

安装后重启 DSH 实例即可；插件自带的 `cordis.patch.yml` 会自动注册 loader entry。

## 权限与兼容

- **涉及范围**：仅在每个 root agent 上注册一个模型可调用的 Agent 工具（`wait_subagent`）。无 web client、无 UI 改动、无配置项。
- **阻塞语义**：等待期间该调用占用调用方 agent 的工具通道，直到子代理收尾、可选超时到期或调用方中止——这正是功能本身。等待机制是事件驱动（`subagent/end` 生命周期事件），非轮询，阻塞期间 CPU 占用可忽略。省略 `timeout_ms` 的等待不设上限（设计如此）；需要上限时请给足量级的 `timeout_ms`。
- **无副作用**：无网络请求、无外部服务、无文件系统写入。
- **依赖**：`@deepseek-ai/dsh-tools` 0.1.2-rc.1（与 dsh 0.1.2-rc.1 锁定版本对齐），Node ≥ 22.5。

## 本地开发

```bash
npm install
```

就这些——`lib/` 是纯 ESM JavaScript，没有构建步骤，也没有测试套件。

## 发新版

```bash
npm run release        # 递增 patch 版本号并打包到 /tmp/dsh-wait-subagent-<新版>.tgz
```

然后把 tarball 发布到 npm，并推送版本 commit 与 tag：

```bash
git push --follow-tags
```

用 `npm view dsh-wait-subagent version` 复验。

## 许可证

MIT
