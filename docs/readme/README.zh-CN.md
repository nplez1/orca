<h1 align="center">
  <a href="https://github.com/nplez1/orca"><img src="../../resources/build/icon.png" alt="Orca NP" width="64" valign="middle" /></a> Orca NP
</h1>

<p align="center">
  <a href="https://github.com/nplez1/orca"><img src="https://img.shields.io/github/stars/nplez1/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub Star 数" /></a>
  <a href="https://github.com/nplez1/orca/releases"><img src="https://img.shields.io/github/v/release/nplez1/orca?style=flat&amp;label=release&amp;color=08C" alt="Orca NP 最新版本" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="许可证: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Orca NP 构建：macOS 与 Windows" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a> · <a href="README.tr.md">Türkçe</a></sub>
</p>

<p align="center">
  <strong>🔱 这是 <a href="#这个-fork-有何不同">Orca NP</a> —— <a href="https://github.com/stablyai/orca">stablyai/orca</a> 的一个 fork，拥有自己的特性、修复和发布版本。</strong><br/>
  <sub>可与官方 Orca 并存安装 · <a href="https://github.com/nplez1/orca/releases/latest">下载最新的 Orca NP 构建</a> · <a href="#这个-fork-有何不同">查看有何不同 ↓</a></sub>
</p>

<p align="center">
  <strong>面向 100x 构建者的 AI 编排器。</strong><br/>
  并排运行 Codex、Claude Code、OpenCode 或 Pi — 每个都在自己的 worktree 中运行，并在一个地方统一跟踪。
</p>

<h3 align="center"><a href="https://github.com/nplez1/orca/releases/latest"><ins>下载 Orca NP</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Orca 桌面应用在并行 worktree 中运行智能体，角落里是 Orca 移动 companion 应用" width="960" />
</p>

## 这个 Fork 有何不同

Orca NP 是 [stablyai/orca](https://github.com/stablyai/orca) 加上一系列 fork 专属的特性与修复。下方的上游特性列表依然适用（此处未发布构建的除外 —— 见[安装](#安装)）；以下是 Orca NP 在其之上新增的内容。完整列表见[已合并的 Pull Request](https://github.com/nplez1/orca/pulls?q=is%3Apr+is%3Amerged)，fork 专属的补丁系列记录在 [`LOCAL-PATCHES.md`](../../LOCAL-PATCHES.md) 中。

### 任务、Issue 与 Jira

- **Jira 看板视图** —— 选择默认看板后，Jira 标签页会显示列、当前冲刺和待办列表，支持在列之间拖动、筛选框和优先级配色。
- **拖放到列后保持生效** —— 将 Jira 条目拖到某一列会解析对应的流转、询问该流转界面要求填写的字段，并在 Jira 确认前先移动卡片，仅当 Jira 拒绝时回滚。
- **冲刺、故事点与自定义字段** —— 可从条目行或 Issue 抽屉把待办条目移入冲刺，在状态、优先级和负责人旁设置或清除故事点，并在 Issue 详情中编辑自定义的用户选择字段（Dev、QE）。在打开的 Issue 中修改冲刺会让看板重新加载。
- **“Me”匹配所有角色字段** —— 当你是 Dev 或 QE（而不仅是负责人）的 Issue，现在也会出现在看板的 Me 筛选下。
- **可搜索的负责人选择器** —— 你和团队成员固定在顶部。
- **右侧边栏的关联 Issue** —— 由 Jira、Linear 或 GitHub Issue 创建的工作区会多出一个 Issue 标签页，显示状态、负责人、优先级、标签、描述和“打开”按钮。Jira Issue 还支持取消关联/重新关联、实时 Markdown 评论框，并能正确渲染自托管 Jira（Server/Data Center）的描述。GitHub Issue 会从其来源仓库读取，因此位于其他项目的工作区仍能加载它；当该仓库不在此机器上时，标签页会明确说明这一点，而不是加载失败。
- **将工作区关联到 Jira Issue** —— 在其详情对话框中通过 key 或 URL 关联；任务页面会显示已关联工作区的标记，并打开现有工作区，而不是创建重复的工作区。

### Pull Request 评审与 CI

- **行内 GitHub PR 评论** —— 评论显示在编辑器中对应行的下方，支持回复、解决和折叠（仅当你的 checkout 与 PR 的 head 提交一致时显示）。
- **一眼看清合并就绪状态** —— PR 图标保留 CI 颜色，并为待处理的审批、冲突或阻塞添加一个圆点，原因显示在提示中。支持 GitHub、GitLab、Bitbucket、Azure DevOps 和 Gitea。
- **Checks 面板中的评审结论** —— 显示带评审者姓名的 Approved / Changes requested，且面板会在 CI 变化时更新，而不必切换标签页。
- **实时 Checks 面板** —— 运行进行中时，打开的面板每 10 秒刷新一次，而不必等待评审节奏；内容不再变化时会放缓到 20 秒、再放缓到 30 秒；其结论会更新侧边栏卡片和活动栏图标（GitHub）。
- **Jenkins 构建详情** —— 展开 Jenkins 检查即可查看各阶段、正在运行或失败的阶段以及构建信息。
- **需评审 PR 的管理员合并** —— 如果你的账号可以绕过分支保护，会在一次说明将跳过哪些检查的确认后提供 Merge。

### 智能体

- **会话摘要** —— 在右侧边栏以文字概述一次智能体会话（活动、目标、计划、阻塞项、时间线），并有独立的智能体/模型设置。同样覆盖 Pi、Copilot、OpenCode 和 Cursor 的会话。配对主机上的会话在该主机上生成摘要，SSH 目标上的会话则从其流式回传的转录生成摘要。
- **更准确的智能体状态** —— 辅助子智能体结束时，Pi 的行不再卡在“Working”，也不会变成“Done”；Copilot CLI 不再为自动批准的提示发出“needs you”；等待你回答的 Grok 子智能体会让其所在行保持等待状态；在另一个客户端上恢复的窗格会清除其对话框留下的“需要输入”标记。另外，pi 会话通过 `claude` CLI 派发的 Claude 子智能体会留在该 pi 会话的行上（需要较新的 pi-subagents 插件）。
- **从屏幕读取 Copilot 的提示** —— shell 或 URL 批准以及“Copilot needs information”对话框会显示为提示，而不是加载动画；CLI 自行批准的权限则保持安静。
- **焦点保持在智能体标签页** —— 点击侧边栏卡片、右侧边栏活动标签或面板背景会把键盘交还给智能体标签页，关闭菜单或对话框时光标也会回来，因此下一次按键仍然表达你原本的意图。
- **剪贴板跟随阅读者** —— 从配对客户端观看的 pi 窗格中复制的内容，会进入该客户端的剪贴板，同时也进入主机的剪贴板。
- **一键启动默认智能体** —— 标签栏的 `+` 按钮会启动你的默认智能体；长按或使用箭头可打开完整菜单。
- **Agent Dashboard 成为页面** —— 在主窗口中打开，支持后退/前进，点击卡片会打开该智能体的工作区。
- **智能体会话历史** —— “All”现在会列出所有会话，子智能体会话嵌套在其父会话下，开启转录索引后现有转录也可搜索。配对主机的历史按页加载，并只刷新发生变化的部分，因此庞大的远程历史也能顺利到达，而不是失败。
- **支持更多提供商的用量追踪** —— 在状态栏显示 Copilot Enterprise 的 AI 额度预算、DeepSeek 余额和 Fireworks.ai 花费，并提供按提供商关闭的开关，可停止轮询和凭据读取。过期的 Claude 登录会用存储的刷新令牌刷新，而不是一直停在“运行 Claude 时更新”；刷新后的登录会写回到 Claude 存放它的位置。

### 工作区与布局

- **每个项目一个文件夹** —— 主 checkout 及其所有 worktree 与共享的 `AGENTS.md` 一起放在同一个文件夹中；`orca repo relocate` 会把现有 checkout 移入其中。
- **跨机器的工作区分组** —— 两台主机上的同一分支合并为一张带主机下拉菜单的卡片。位于配对主机上的工作区会从该主机读取其 GitHub Issue 和 PR，主机上的智能体结束后，其状态圆点也会停止转动。
- **配对客户端保持同步** —— 主机新增或删除的项目与工作区（包括在其自身窗口或其 CLI 中创建的）都会同步到其配对客户端，无需手动刷新。
- **状态筛选** —— 在侧边栏和 Cmd+J 中隐藏选定的状态，看板仍显示全部。
- **“Setting up…”指示** —— 在仓库的 setup 脚本运行期间显示，也包括未启动智能体的工作区。
- **共享目录模式** —— 为 worktree 之间共享的目录选择符号链接、APFS 克隆、复制或跳过。
- **浮动工作区** —— 拥有独立的主目录、标题栏上的拖动手柄，以及与主标签栏相同的智能体启动控件。
- **隐藏自动导入的 SSH 主机** —— 从选择器和状态栏中隐藏；隐藏的主机仍会列在设置中。
- **更快、更诚实的文件筛选** —— Explore 的文件名筛选基于预先构建的索引搜索整个工作区，结果不完整时会明确提示，而不是显示“no files match”。
- **主机间设置复制** _（基础能力）_ —— 一台机器的设置和提供商凭据可以复制到已配对的主机。

### 临时环境

以下是对上游按工作区环境配方（设置 → 实验性 → 云虚拟机）的新增：

- **租约倒计时与 Extend** —— 公布了提供方何时收回主机的配方，会在工作区卡片和设置中获得倒计时；如果它还声明了如何延长，则会多出一个仅提供其所列生命周期的 Extend 操作。超过截止时间后，卡片和设置会把租约显示为已过期；再过 15 分钟，且 Orca 与主机的连接已经失败，Orca 会将该工作区从列表中移除，而提供方的机器则交给它自己的到期时间或设置中的清理操作。
- **配方声明的右键菜单项** —— 配方最多可声明 20 个操作，它们会出现在该工作区的右键菜单中，并带着工作区的主机、名称和路径运行。这些操作在 `orca.yaml` 中声明，因此受配方审批覆盖；未声明任何操作的配方不会新增任何菜单项。

### 可靠性

- 从 Dock 启动打包版应用时，git 钩子和 ssh-agent 认证可以正常工作，因为 git 现在能读取你的 shell 配置文件中的 export。
- macOS computer use 权限不再分散到两个辅助程序身份上。
- 在 Copilot CLI 中右键粘贴只会粘贴一次，而不是两次。
- 可选的“Log UI hangs”诊断会写入包含焦点、睡眠和 CPU 信息的卡顿记录，帮助排查彩虹球。

### 运行方式

- **独立身份** —— Orca NP 使用自己的应用 ID（`com.nplez1.orca`）、数据目录、主目录（`~/.orca-np`）和 CLI（`orca-np`），因此可以与官方 Orca 并存安装和运行，互不共享状态。
- **独立的发布与更新** —— 构建以 `v<上游版本>-np.<n>` 打标签，应用内更新器跟随[本仓库的发布](https://github.com/nplez1/orca/releases)，而不是上游的。
- **签名** —— macOS 构建已签名并通过公证；Windows 安装程序未签名，因此安装时 SmartScreen 会警告一次。
- **无遥测** —— 发布说明称这些构建不发送诊断或使用数据。
- **技能指向本应用** —— 内置技能和已发布的存根会调用 `orca-np`（开发时为 `orca-np-dev`），而不是回落到官方安装的 `orca`。
- **全新配置** —— Orca NP 无法读取官方 Orca 安装的仓库、凭据或已配对设备；这种隔离是有意为之，因此请单独将手机与 Orca NP 配对。
- **跟进上游** —— 定期合并上游 `main`（流程见 [`UPSTREAM-SYNC-RUNBOOK.md`](../../UPSTREAM-SYNC-RUNBOOK.md)），因此该 fork 也会获得上游的特性与修复。

---

## 特性

下方的特性列表属于上游 Orca；其中的“Docs”链接指向 onorca.dev 上的上游文档，并不涵盖上文的 fork 专属特性。

<table>
<tr>
<td width="50%" valign="middle">

### 移动 Companion 应用

用手机监控并指挥你的智能体 — 智能体完成时收到通知，随时随地发送后续指令。

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [Android APK](https://www.onorca.dev/download/android) · [文档 →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca 桌面端与移动 companion 应用" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 并行 Worktree

把一个提示同时分发给五个智能体，每个都在自己隔离的 git worktree 中运行 — 比较结果，合并最佳方案。

[文档 →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../site/public/docs/tab-split.gif" type="image/gif"><img src="../site/public/docs/posters/tab-split.jpg" alt="并行 worktree 编排" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 终端分屏

Ghostty 级终端，支持 WebGL 渲染、无限分屏，以及重启后依然保留的滚动历史。

[文档 →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../../resources/onboarding/feature-wall/tile-02.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-02.poster.jpg" alt="终端分屏" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 设计模式

在真实的 Chromium 窗口中点击任意 UI 元素，把它的 HTML、CSS 和裁剪好的截图直接发送到智能体的提示中。

[文档 →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../site/public/docs/orca-design-mode.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-05.poster.jpg" alt="内置浏览器与设计模式" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub &amp; Linear 原生集成

在应用内浏览 PR、issue 和项目看板 — 从任意任务打开 worktree，无需切换上下文即可完成评审。

[文档 →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../../resources/onboarding/feature-wall/tile-03.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-03.poster.jpg" alt="Orca 中的 GitHub 与 Linear 任务工作流" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH Worktree

在高性能远程机器上运行智能体，完整支持文件编辑、git 和终端 — 自动重连与端口转发一应俱全。

[文档 →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../../resources/onboarding/feature-wall/tile-06.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-06.poster.jpg" alt="通过 SSH 使用远程 worktree" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 标注 AI Diff

在任意 diff 行上添加评论并发回给智能体 — 评审、编辑、提交，全程无需离开 Orca。

[文档 →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-08.poster.jpg" alt="标注 AI 生成的 diff" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 拖文件给智能体

VS Code 的编辑器，处处自动保存 — 把文件或图片直接拖入智能体提示。

[文档 →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../../resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-07.poster.jpg" alt="将文件和图片拖入智能体提示" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

智能体也能驱动 Orca — 用 `orca worktree create`、`snapshot`、`click` 和 `fill` 把每个工作流脚本化。

[文档 →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../../resources/onboarding/feature-wall/tile-09.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-09.poster.jpg" alt="从 CLI 脚本化 Orca" width="100%" /></picture></a>
</td>
</tr>
</table>

**开箱即用的还有：**

- **[快速打开](https://www.onorca.dev/docs/model/quick-open)** — 在 worktree、文件、智能体、命令和仓库上下文之间搜索，不打断你的心流。
- **[账号切换与用量追踪](https://www.onorca.dev/docs/agents/usage-tracking)** — 查看 Claude 和 Codex 的用量与限额重置时间，并且无需重新登录即可热切换账号。
- **[丰富仓库预览](https://www.onorca.dev/docs/editing/markdown)** — 在工作区中预览 Markdown、图片、PDF 和仓库文档。
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — 当工作流需要真实交互时，让智能体操作桌面应用和可见 UI。
- **[通知与未读状态](https://www.onorca.dev/docs/notifications)** — 第一时间知道智能体何时完成或需要关注，并可将会话标记为未读，稍后再回来处理。
- **还有很多很多** —— 我们每天发布，所以这个列表总是落后。本 fork 真正的特性列表是 [Orca NP 的发布](https://github.com/nplez1/orca/releases)，其继承的部分则见[上游的发布](https://github.com/stablyai/orca/releases)。

---

## 支持的智能体

适配**任何 CLI 智能体** — 只要能在终端里运行，就能在 Orca 里运行。

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Grok logo" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="../../src/shared/agent-icons/muse.png" alt="Muse logo" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="../../src/shared/agent-icons/dsh.png" alt="DeepSeek Harness logo" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="../../src/shared/agent-icons/zcode.png" alt="ZCode logo" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="OpenClaude logo" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logo" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Hermes Agent logo" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Auggie logo" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Autohand Code logo" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Charm logo" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=freebuff.com&sz=64" alt="Freebuff logo" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Command Code logo" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Kilocode logo" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Kiro logo" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Rovo Dev logo" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ 任何 CLI 智能体</kbd>
</p>

---

## 安装

### 桌面端 — macOS、Windows

- **[下载最新的 Orca NP 版本](https://github.com/nplez1/orca/releases/latest)**
- 或直接获取构建：[macOS Apple Silicon](https://github.com/nplez1/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/nplez1/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/nplez1/orca/releases/latest/download/orca-windows-setup.exe) · [全部构建](https://github.com/nplez1/orca/releases)

Orca NP 可与官方 Orca 并存安装，并通过本仓库的发布自动更新。这个 fork 不发布 Linux 构建，也不提供 Homebrew/AUR 包 —— 在 Linux 上请[从源码构建](../../.github/CONTRIBUTING.md)，或使用[上游 Orca](https://github.com/stablyai/orca/releases/latest)。

### 移动 Companion 应用 — iOS、Android

将 Orca 移动应用与 Orca NP 配对，即可用手机监控和操控你的智能体。这些应用由上游 Orca 发布，可与 Orca NP 配合使用。

- **iOS:** [从 App Store 下载](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [下载 APK](https://www.onorca.dev/download/android)

---

## 社区与支持

- **Orca NP 的 Issue 与想法：** 与本 fork 相关的问题请[提交 Issue](https://github.com/nplez1/orca/issues)。
- **上游社区：** 本 fork 继承的部分由上游 Orca 的渠道覆盖 —— [Discord](https://discord.gg/fzjDKHxv8Q)、[X 上的 @orca_build](https://x.com/orca_build)，以及在官方 Orca 中同样可复现的 bug 请提交到[上游 Issue](https://github.com/stablyai/orca/issues)。
- **文档：** [onorca.dev/docs](https://www.onorca.dev/docs) 是上游 Orca 的文档。
- **支持我们：** 给本仓库点个 [Star](https://github.com/nplez1/orca) 以关注这个 fork，或给[上游](https://github.com/stablyai/orca)点 Star。

---

## 开发

想要贡献代码或在本地运行？请参阅我们的 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) 指南。

<a href="https://github.com/nplez1/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=nplez1/orca" alt="Orca 贡献者" />
</a>

## 许可证

Orca 是自由且开源的软件，遵循 [MIT 许可证](../../LICENSE)。
