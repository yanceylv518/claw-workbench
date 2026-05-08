# 小龙虾当前系统说明

这份文档记录当前 `D:\openclaw` 的实际运行形态。它的目标不是重新设计系统，而是给后续“最小改动、逐步模块化”的改造提供一张稳定地图。

## 当前定位

当前系统是一个本地内容生产自动化工作台，主要服务于个人或小团队的 AI 内容生产流程。

它由以下部分组合而成：

```text
本地后台控制台
+ 微信消息桥
+ AI 情报工作流
+ 小红书发布包工作流
+ Hermes 内容脑能力
+ OpenClaw agent 调用
+ Notion 写入
+ 小红书预填/浏览器自动化
+ 早报定时脚本
+ 本地文件数据目录
```

当前系统不是完整 SaaS 后台，也不准备优先改成云端系统。后续目标是做成本地端专业后台，重点是模块清晰、代码可维护、任务可追踪和本地数据稳定。

## 主要入口

### 本地后台

入口文件：

```text
console-server.mjs
```

启动脚本：

```text
start-xiaolongxia-console.ps1
start-console-background.ps1
```

默认访问地址：

```text
http://localhost:3100
```

当前后台是一个单文件 Node.js HTTP 服务，页面、样式、前端脚本、API 路由和部分业务逻辑都集中在 `console-server.mjs`。

后台主要负责：

- 查看系统状态
- 查看日志
- 查看和更新发布包
- 管理内容选项
- 管理知识库
- 管理 Hermes、Notion、小红书预填等开关
- 管理自定义业务流
- 从后台发起内容任务
- 做爆款链接解析和分析

### 微信桥

入口文件：

```text
wechat-direct-bridge.mjs
```

启动脚本：

```text
start-wechat-direct-bridge.ps1
restart-wechat-direct-bridge.ps1
stop-wechat-direct-bridge.ps1
```

微信桥是一个常驻轮询进程，核心流程是：

```text
读取微信插件消息
-> 提取文本和上下文 token
-> 判断用户意图
-> 调用对应工作流
-> 发送微信回复
-> 记录日志和状态
```

微信桥当前会分发到这些能力：

- 小红书发布包生成
- AI 情报流程
- 财经新闻分析
- 财经简报
- 小龙虾小队模式
- 自定义业务流
- 普通模型回复

### 早报脚本

入口文件：

```text
morning-ai-brief.mjs
```

启动脚本：

```text
run-morning-ai-brief.ps1
install-xiaolongxia-morning-push.ps1
install-xiaolongxia-morning-wake.ps1
```

早报流程会读取配置，调用情报工作流，生成早报内容，并通过微信发送通知。

## 核心业务工作流

### AI 情报流程

入口文件：

```text
notion-ai-intel-workflow.mjs
```

核心职责：

- 读取 RSS/信息源
- 根据用户主题筛选候选信息
- 调用模型做摘要、分类、用途判断
- 可选写入 Notion
- 返回微信或后台摘要

### 小红书发布包流程

入口文件：

```text
xiaohongshu-draft-workflow.mjs
```

这是当前最重的业务流程。核心步骤：

```text
识别小红书任务
-> 调 AI 情报流程找素材
-> 读取 Notion/内容配置
-> Hermes 内容脑尝试生成研究、判断、质检、文案
-> 如果 Hermes 不可用，降级到稳定多步流程
-> 选题评分
-> 生成初稿
-> 业务规则修复
-> 人类编辑/去 AI 味审查
-> 质量检查
-> 可选生图
-> 保存本地发布包
-> 可选写入 Notion
-> 可选小红书预填
-> 返回结果
```

### Hermes

Hermes 目前不是独立服务，而是嵌在小红书工作流里的内容脑能力。

当前形态包括：

- 研究卡片
- 内容脑
- 机会评分
- 人类编辑审查
- 质量检查
- 失败后降级到稳定多步流程

后续改造目标是把 Hermes 从大工作流中抽成模块，但保持输入输出格式不变。

### OpenClaw agent

入口文件：

```text
openclaw-agent-client.mjs
```

当前调用方式：

```text
Node.js
-> PowerShell
-> invoke-openclaw.ps1
-> openclaw agent --json
-> 解析 JSON 输出
```

OpenClaw 当前适合本地低频任务和高级自动化，不适合作为多人系统所有请求的同步主链路。

### 财经流程

入口文件：

```text
finance-news-workflow.mjs
```

核心职责：

- 单条财经新闻影响分析
- 财经简报抓取和摘要
- 通过微信或后台返回分析结果

### 小龙虾小队流程

入口文件：

```text
lobster-squad-workflow.mjs
```

核心职责：

- 先调用 AI 情报流程找素材
- 再让模型做会议式分析和行动建议
- 适合作为内容选题和团队讨论型入口

## 当前数据位置

程序目录：

```text
D:\openclaw
```

运行数据目录：

```text
D:\XiaolongxiaData
```

主要数据文件和目录：

```text
D:\XiaolongxiaData\xiaohongshu-drafts
D:\XiaolongxiaData\wechat-direct-bridge.log
D:\XiaolongxiaData\morning-ai-brief.log
D:\XiaolongxiaData\content-console-options.json
D:\XiaolongxiaData\content-knowledge-base.json
D:\XiaolongxiaData\xiaohongshu-prefill-status.json
D:\XiaolongxiaData\latest-morning-brief.json
D:\XiaolongxiaData\browser-profiles
D:\XiaolongxiaData\outbound-audio
D:\XiaolongxiaData\xiaohongshu-images
```

OpenClaw 用户数据通常在：

```text
%USERPROFILE%\.openclaw
```

## 当前配置文件

```text
wechat-bridge.config.json
notion-ai-intel.config.json
notion-ai-intel.config.example.json
wechat-proactive-templates.json
```

当前配置主要以 JSON 文件形式存在。本地端改造时，配置要先统一到配置读取层，后续可选择增加 SQLite 索引或加密配置层，但第一阶段应保留 JSON fallback。

## 当前主要问题

当前系统能跑通业务，但存在这些结构性问题：

- 后台页面、前端脚本、API 和业务逻辑集中在 `console-server.mjs`
- 小红书业务流程集中在 `xiaohongshu-draft-workflow.mjs`
- 配置、知识库、发布包索引依赖本地 JSON 和文件目录
- 没有登录、用户和权限
- 没有任务队列，长任务同步执行
- 日志以文本为主，不方便按用户、任务、步骤追踪
- 微信入口、后台入口、早报入口有重复的模型配置读取逻辑
- OpenClaw 和 Hermes 调用没有统一的执行边界和限流边界

## 本地端改造原则

后续改造必须遵守这些约束：

- 旧入口继续可用
- 旧发布包目录结构暂时不动
- 旧配置文件保留 fallback
- 先新增模块，再迁移调用点
- 每次只替换一个边界
- 业务输出格式优先保持兼容
- 后台、微信和早报分阶段接入新能力
- 不以云端部署为近期目标
- 本地数据目录继续作为事实来源
- 新增索引库只能作为辅助，不应让旧数据不可读
