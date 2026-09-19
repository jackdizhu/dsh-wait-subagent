# dsh-wait-subagent 首次开源发布准备 — 完成报告

日期：2026-09-19 ｜ 执行者：发布准备子代理 ｜ 目录：/root/plugins/dsh-wait-subagent

## 插件功能概括（2 句）

dsh-wait-subagent 为 DeepSeek Harness 注册 `wait_subagent` 模型工具：阻塞等待指定的后台 continuable 子代理收尾（settle），返回其停止原因与收尾消息（可选 timeout_ms、尊重 AbortSignal、事件驱动零轮询）。它补齐了后台子代理只能被动等异步 settlement 通知、无法主动等待的缺口。

## 1. 隐私/密钥扫描清单（对全部 9 个将提交文件）

扫描面：密钥/token/密码（含片段）、私人域名（johnnren.qzz.io）、本机绝对路径（/root/、/root/plugins/、/root/.dsh/）、设备信息（apollo/K30S/Termux/Magisk）、内网拓扑（端口/隧道/vnc）。

| 文件:位置 | 命中 | 处置 |
|---|---|---|
| README.md（旧版 L46-50） | `supervisorctl restart dsh`（宿主服务拓扑假设） | ✅ 已改写：README 重写为通用表述 "Restart your DSH instance"（英文/中文版均已消除） |
| lib/index.js L110、README L34 | `"max-tokens"`（stop_reason 枚举值） | ✅ 误报（LLM 术语非凭据），保留 |
| .gitignore:4 | `.mnemon/` | ✅ 误报（忽略规则本身），保留 |

其余 6 文件（LICENSE、README.zh-CN.md、cordis.patch.yml、package.json、package-lock.json、docs/freeform/*.yml）：零命中。package-lock.json 仅含 registry.npmjs.org URL、无 file:/link: 本地引用。终态扫描归零。

## 2. 改动/新增文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `.gitignore` | 🆕 | node_modules/ dist/ *.tsbuildinfo .mnemon/（与黄金示例一致） |
| `README.md` | ♻️ 重写 | **英文主体**（本仓库定英文为主），顶部居中 `English · 简体中文` 切换（English 加粗为本语言；README.zh-CN.md 反向）。四件套齐全 |
| `README.zh-CN.md` | 🆕 | 中文版，忠实对译英文版（表格/代码块/警示节一一对应） |
| `LICENSE` | 🆕 | MIT，Copyright (c) 2026 JohnnRen |
| `package.json` | ♻️ 重写 | 见 §3/§4 |
| `docs/freeform/260919-awesome-entry-draft.yml` | 🆕 | awesome 投稿草稿，见 §5 |
| `cordis.patch.yml` / `lib/index.js` | ➖ 未动 | 内容本就干净合规 |
| `package-lock.json` | ♻️ npm install 重新生成 | dsh-tools 锁定 0.1.2-rc.1 |

git 状态：已在插件目录 `git init`（分支 **main**），仓库级 config `user.name=JohnnRen` / `user.email=john.ren.contact@gmail.com`；9 个路径待首次提交（遵守铁律未 add/commit，node_modules 已被忽略）。**未 push、未发布。**

## 3. 依赖架构结论

- 现状：dependencies 声明的是 `@deepseek-ai/dsh-tools 0.1.1-rc.2`（旧），dsh 主包（0.1.2-rc.1）锁定值为 **0.1.2-rc.1**。
- **0.1.2-rc.1 在 npm 上真实存在且可独立安装**（npm view 核实 + scratch 实测通过）→ 维持普通 `dependencies` 架构（dsh-message-datetime 模式），**不需要** dsh-proactive 的"dependencies 置空 + peerDependencies 宿主供给"方案。
- 已将版本升级为 `"@deepseek-ai/dsh-tools": "0.1.2-rc.1"` 并本地安装、resolve 验证通过。
- scratch profile 里 pnpm 报 dsh-tools 的 peer 未满足（cordis/dsh-agent 等）——预期现象：真实 dsh 宿主运行时全部供给，不影响安装与导入（实测佐证）。

## 4. Scratch 实测结果（最终 tarball 全流程）

```
npm pack → /tmp/dsh-wait-subagent-1.0.0.tgz（6 文件：lib/index.js、cordis.patch.yml、
           README.md、README.zh-CN.md、LICENSE、package.json —— files 核对通过）
dsh plugin --profile vfy-ws add <tgz>            → 安装成功（+7 包）
dsh --profile vfy-ws --dump-config               → 层出现：# == dsh-wait-subagent
                                                   - id: wait-subagent / name: dsh-wait-subagent ✅
cd ~/.dsh/profiles/vfy-ws && import('dsh-wait-subagent')
  → apply: function | name: dsh-wait-subagent | inject: ["agents","tools","subagents"] ✅
清理：rm -rf vfy-ws profile + /tmp/*.tgz          → 已删净（profiles 剩 headless/node_modules/vfy-p3/web；
                                                   vfy-p3 是历史遗留非本次产物，未动）
```

scripts 决策：无构建（lib 为纯 ESM JS）→ 不加 prepare；无测试 → 不加 prepublishOnly；仅加 `release: "npm version patch && npm pack --pack-destination /tmp"`（README 已带同款"发新版"节）。GitHub 源装因此无需 pnpm allowBuilds（README 已如实标注）。

## 5. README 四件套与 awesome 草稿要点

- 一行价值：block until a background continuable subagent settles, then get its stop reason and closing message in the same call。
- 安装命令：`dsh plugin --profile web add dsh-wait-subagent`（+ GitHub 直装替代）。
- 真实输出：工具调用→JSON 返回（status/stop_reason/closing_message）→渲染文本，全部从 lib/index.js 的 summary()/output schema 提炼；另有 4 行"其他结果"表（已收尾 stop_reason=unknown、timeout、cancelled、未知 id 报错），与代码逐一对应。
- 权限与兼容：仅注册 1 个 Agent 工具、无 web client/无 UI 改动/无配置；阻塞语义=占用调用方工具通道（即功能本身）、事件驱动非轮询、CPU 可忽略；无网络/无外部服务/无文件写入；依赖 @deepseek-ai/dsh-tools 0.1.2-rc.1 + Node ≥ 22.5。保留 interrupt_agent 串行化警示节。
- awesome 草稿：category=**tools**（本质是注册模型工具），双语描述 keyword 密集且严格属实（wait for background subagent / subagent wait / continuable / settlement / closing message / stop reason / 零轮询），含 ": " 的值全部单引号包裹，YAML python-yaml 校验通过。

## 6. 遗留给主会话

1. 统一 commit（9 个路径）→ 建 GitHub 仓库 `john-walks-slow/dsh-wait-subagent` → push（我来不了这步）。
2. push 后打 topic `dsh-plugin`（+deepseek-harness/ai-agent，可加 subagent/wait/automation）。
3. npm 发布走指纹流程（tgz 需重新 pack，验过的 1.0.0 tarball 已清理）；发布后从 registry 复装一次复验。
4. 仓库满 1 天后用 docs/freeform/260919-awesome-entry-draft.yml 提 PR（文件名改 `data/plugins/john-walks-slow__dsh-wait-subagent.yml`）。
5. 线上 profile 仍为 link: 本地目录，无需改动；如需让线上吃到 0.1.2-rc.1 依赖升级，按 restart-dsh 流程另行处理（非发布必需）。
