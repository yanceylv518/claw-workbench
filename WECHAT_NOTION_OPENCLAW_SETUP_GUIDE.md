# OpenClaw 微信 + AI 情报 + Notion 自动写入搭建指南

## 目标

搭一套可在本地运行的微信助手，支持以下流程：

1. 用户在微信里发一条自然语言消息
2. 系统自动判断这是普通聊天，还是“AI 情报采集任务”
3. 如果是 AI 情报任务：
   - 抓取当天 AI 资讯
   - 选出最有价值的若干条
   - 结构化整理
   - 写入 Notion 数据库
   - 把结果回发到微信
4. 如果是普通聊天：
   - 直接走聊天模型回复

当前这套实现已经包含：

- 微信直连接入
- 智能意图判断
- 边界意图确认
- AI 情报抓取和筛选
- Notion 写入
- 去重写入
- 面向微信的短格式回复

---

## 最终架构

```text
微信消息
  -> 直连桥 wechat-direct-bridge.mjs
    -> 意图判断
      -> 普通聊天 -> 大模型回复
      -> AI 情报任务 -> 抓资讯 -> 筛选 -> 写 Notion -> 回微信
```

注意：

- 最终采用的是“单入口”架构
- 不再依赖旧的 `openclaw-weixin` 插件链路来直接回复消息
- `openclaw-weixin` 仅保留账号态和微信底层连接能力
- 真正处理消息的是本地桥脚本

---

## 目录与文件

核心工作目录：

- [D:\openclaw](D:/openclaw)

关键文件：

- [wechat-direct-bridge.mjs](D:/openclaw/wechat-direct-bridge.mjs)
  - 微信消息主入口
  - 负责轮询、意图判断、普通聊天、调用 AI 情报工作流、回微信

- [notion-ai-intel-workflow.mjs](D:/openclaw/notion-ai-intel-workflow.mjs)
  - AI 情报自动化工作流
  - 负责 RSS 抓取、筛选、去重、写入 Notion、生成回复文案

- [notion-ai-intel.config.json](D:/openclaw/notion-ai-intel.config.json)
  - Notion 和资讯源配置

- [start-wechat-direct-bridge.ps1](D:/openclaw/start-wechat-direct-bridge.ps1)
  - 启动桥脚本

- [stop-wechat-direct-bridge.ps1](D:/openclaw/stop-wechat-direct-bridge.ps1)
  - 停止桥脚本

- [wechat-direct-bridge.log](D:/openclaw/wechat-direct-bridge.log)
  - 运行日志

OpenClaw 配置文件：

- [openclaw.json](C:/Users/40323/.openclaw/openclaw.json)

微信账号态文件：

- `C:\Users\40323\.openclaw\openclaw-weixin\accounts\<account>.json`
- `C:\Users\40323\.openclaw\openclaw-weixin\accounts\<account>.sync.json`
- `C:\Users\40323\.openclaw\openclaw-weixin\accounts\<account>.context-tokens.json`

桥本地状态文件：

- `D:\openclaw\.wechat-direct-bridge\<account>.sync.json`
- `D:\openclaw\.wechat-direct-bridge\<account>.context-tokens.json`
- `D:\openclaw\.wechat-direct-bridge\<account>.pending-actions.json`

---

## 前置条件

需要先具备：

1. Windows 环境
2. Node.js 已安装
3. `openclaw` CLI 已安装
4. 微信通道已成功登录
5. 已有可用模型提供方
6. 已有可写入的 Notion 数据库

本机中实际使用的是：

- OpenClaw CLI
- 微信账号由 `openclaw-weixin` 插件维持登录态
- 第三方 OpenAI 兼容模型接口
- Notion Database

---

## 第 1 步：安装与验证 OpenClaw

### 验证版本

```powershell
& "C:\Users\40323\AppData\Roaming\npm\openclaw.cmd" --version
```

### 常见问题

#### 问题 1：PowerShell 执行 `openclaw` 被策略拦截

表现：

- 直接输 `openclaw`，命中的是 `openclaw.ps1`
- 报执行策略错误

解决：

统一改用：

```powershell
openclaw.cmd
```

或者完整路径：

```powershell
& "C:\Users\40323\AppData\Roaming\npm\openclaw.cmd"
```

---

## 第 2 步：初始化 OpenClaw

### 初始化工作区

建议准备独立目录，例如：

```powershell
New-Item -ItemType Directory -Force "D:\openclaw" | Out-Null
New-Item -ItemType Directory -Force "D:\openclaw\.openclaw-workspace" | Out-Null
```

### 初始化配置

根据安装方式不同，可以使用：

```powershell
& "C:\Users\40323\AppData\Roaming\npm\openclaw.cmd" onboard
```

如果是本地已经有登录态，也可以先快速配置后再补细节。

---

## 第 3 步：模型配置

### 路径 1：Codex OAuth

可以使用：

- `openai-codex/gpt-5.4`

但我们在实测中发现：

- 与本地代理和 gateway 组合时，响应链更重
- 若多处共享会话，可能变慢

### 路径 2：第三方 OpenAI 兼容 API

最终这套微信自动化采用的是第三方 OpenAI 兼容接口。

OpenClaw 配置示意：

```json
{
  "models": {
    "providers": {
      "your-provider": {
        "baseUrl": "https://your-base-url/v1",
        "apiKey": "YOUR_API_KEY",
        "auth": "api-key",
        "api": "openai-completions",
        "models": [
          {
            "id": "gpt-4o",
            "name": "gpt-4o"
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "your-provider/gpt-4o"
      }
    }
  }
}
```

### 验证模型可用

```powershell
openclaw.cmd capability model run --model your-provider/gpt-4o --prompt "Reply with exactly: OK" --json
```

---

## 第 4 步：接通微信

### 查看通道状态

```powershell
openclaw.cmd channels status
```

如果已连接，会看到类似：

- `openclaw-weixin ... enabled, configured, running`

### 关键说明

最终方案里：

- 微信账号登录态仍由 `openclaw-weixin` 维护
- 但消息处理不再交给旧 gateway 聊天链
- 而是由我们自定义的桥脚本接管

---

## 第 5 步：为什么不用旧的 OpenClaw 微信回复链

实测里，旧的 OpenClaw gateway + weixin 回复链有几个问题：

1. 响应慢
2. UI/gateway 轮询重
3. 插件链太厚
4. 容易和自定义脚本同时回复，导致双回复

所以最终采用：

- 保留微信登录态
- 自定义一条更轻的直连桥

---

## 第 6 步：实现微信直连桥

文件：

- [wechat-direct-bridge.mjs](D:/openclaw/wechat-direct-bridge.mjs)

它负责：

1. 读取微信账号 token
2. 调用 `ilink/bot/getupdates` 长轮询消息
3. 提取文本
4. 判断消息意图
5. 走普通聊天或 AI 情报流程
6. 调用 `ilink/bot/sendmessage` 回微信

### 启动

```powershell
powershell -ExecutionPolicy Bypass -File D:\openclaw\start-wechat-direct-bridge.ps1
```

### 停止

```powershell
powershell -ExecutionPolicy Bypass -File D:\openclaw\stop-wechat-direct-bridge.ps1
```

### 日志查看

```powershell
Get-Content -LiteralPath 'D:\openclaw\wechat-direct-bridge.log' -Tail 100
```

---

## 第 7 步：实现 AI 情报工作流

文件：

- [notion-ai-intel-workflow.mjs](D:/openclaw/notion-ai-intel-workflow.mjs)

这个模块负责：

1. 判断是否是 AI 情报任务
2. 抓资讯候选
3. 用模型筛选和结构化
4. 查重
5. 写入 Notion
6. 生成微信回包

### 当前资讯源

为了避免单源超时，采用多源：

- `https://openai.com/news/rss.xml`
- `https://techcrunch.com/category/artificial-intelligence/feed/`
- `https://venturebeat.com/category/ai/feed/`

### 处理逻辑

1. 拉取 RSS
2. 抽取候选标题、摘要、链接、时间
3. 把候选交给模型
4. 模型返回结构化 JSON：
   - `title`
   - `summary`
   - `usage`
   - `link`
   - `date`
   - `fit_for`
5. 写入 Notion
6. 回微信

---

## 第 8 步：Notion 配置

配置文件：

- [notion-ai-intel.config.json](D:/openclaw/notion-ai-intel.config.json)

示例结构：

```json
{
  "enabled": true,
  "feed_urls": [
    "https://openai.com/news/rss.xml",
    "https://techcrunch.com/category/artificial-intelligence/feed/",
    "https://venturebeat.com/category/ai/feed/"
  ],
  "fetch_limit": 12,
  "notion": {
    "token": "YOUR_NOTION_TOKEN",
    "database_id": "YOUR_DATABASE_ID",
    "property_map": {
      "title": "标题",
      "summary": "总结",
      "usage": "用途",
      "link": "链接",
      "date": "日期"
    }
  }
}
```

### 验证数据库结构

可以先读数据库 schema：

```powershell
@'
const token = 'YOUR_NOTION_TOKEN';
const databaseId = 'YOUR_DATABASE_ID';
const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28'
  }
});
console.log(await res.text());
'@ | node -
```

### 当前要求的字段类型

数据库必须有：

- `标题` -> `title`
- `总结` -> `rich_text`
- `用途` -> `rich_text`
- `链接` -> `url`
- `日期` -> `date`

---

## 第 9 步：智能路由设计

### 目标

不靠死板前缀，而是尽量按自然语言判断。

### 最终策略

#### 1. 普通聊天

例如：

- `早上好`
- `帮我润色一句话`
- `你是谁`

行为：

- 直接走聊天模型

#### 2. 高确定性情报任务

例如：

- `帮我找今天AI最有用的3条信息`
- `帮我找今天适合自媒体的AI信息3条`
- `想看看今天AI新闻`

行为：

- 直接执行情报流程

#### 3. 边界不清任务

例如：

- `今天AI有什么值得看的`
- `帮我整理一下AI资讯`

行为：

- 先回确认
- 你回复 `要` / `继续`
- 再正式执行

---

## 第 10 步：产品级交互增强

### 已实现的增强

#### 1. 待确认超时

确认态默认 5 分钟过期。

过期后再回复 `要`，会提示：

```text
刚才那条待确认的情报任务已经过期了，你再说一次我就重新开始。
```

#### 2. 中间态提示

明确任务执行时，先发：

```text
收到，我正在整理并检查是否需要写入 Notion，稍等片刻。
```

但如果是“确认后你回复要”的场景：

- 不再重复发这句
- 直接进入最终结果

#### 3. 确认文案更自然

现在确认提示是：

```text
这条要我帮你抓 AI 情报并写入 Notion 吗？要的话回“要”就行。
```

---

## 第 11 步：去重逻辑

### 为什么要做

同一条新闻如果每天都跑，很容易重复写进 Notion。

### 当前实现

按 `链接` 查重。

每条准备写入 Notion 的记录，都会先查询数据库：

- 如果该链接已存在 -> 跳过
- 如果不存在 -> 新建页面

### 回微信的表现

例如：

```text
状态：已写入 Notion 0/3 条
重复跳过：3 条
```

---

## 第 12 步：微信最终回复格式

当前采用“微信短版”：

```text
今天值得关注的AI更新包括企业版Codex扩展、Codex多场景支持更新及新生命科学模型GPT-Rosalind。

1. 企业级深度扩展Codex
用途：用于软件开发流程自动化，提升生产力。
适合：编程 / 自动化 / 创业

2. Codex适配各种工作场景
用途：加速开发者工具使用，覆盖更多工作场景。
适合：编程 / 自动化 / 创意

状态：已写入 Notion 0/3 条
重复跳过：3 条
```

特点：

- 不展示长摘要
- 不展示链接
- 一屏尽量看完
- 最后带 Notion 状态

---

## 第 13 步：测试方式

### 1. 普通聊天测试

发：

```text
早上好
```

预期：

- 正常聊天回复
- 不触发 Notion

### 2. 直接执行测试

发：

```text
帮我找今天AI最有用的3条信息
```

预期：

- 先收到处理中提示
- 再收到结果
- Notion 写入

### 3. 确认型测试

发：

```text
今天AI有什么值得看的
```

预期：

- 先收到确认提示

再发：

```text
要
```

预期：

- 直接进入最终执行
- 不再多发“收到，我正在整理...”

### 4. 取消测试

先发：

```text
今天AI有什么值得看的
```

再发：

```text
取消
```

预期：

- 回复：
  - `好的，这次我先不抓情报，也不写入 Notion。`

### 5. 过期测试

先发：

```text
今天AI有什么值得看的
```

等待超过 5 分钟，再发：

```text
要
```

预期：

- 回复：
  - `刚才那条待确认的情报任务已经过期了，你再说一次我就重新开始。`

---

## 常见错误与解决

## 错误 1：PowerShell 直接执行 `openclaw` 失败

原因：

- 命中了 `openclaw.ps1`
- 被执行策略拦截

解决：

```powershell
openclaw.cmd
```

---

## 错误 2：第三方 API 返回 401

原因可能有：

- key 无效
- base URL 写错
- 鉴权头不是 `Authorization: Bearer ...`

解决方式：

先不要急着改 OpenClaw，先用最小 `curl` / `Invoke-RestMethod` 验证接口本身能通。

---

## 错误 3：OpenClaw 很慢

实测常见原因：

- gateway 太重
- 插件太多
- UI 轮询频繁
- 代理链路引入延迟

解决：

- 不让微信消息走旧 gateway 聊天链
- 改成独立直连桥

---

## 错误 4：微信消息没回复

历史上出现过几个原因：

### 原因 A：双回复链冲突

- 旧 `openclaw-weixin` 回复链
- 新直连桥

同时处理同一消息。

解决：

- 在 [openclaw.json](C:/Users/40323/.openclaw/openclaw.json) 中关闭 `openclaw-weixin` 的直接回复能力
- 保留直连桥作为唯一消息入口

### 原因 B：桥写 sync 文件权限不足

表现：

- 日志里出现：
  - `EPERM: operation not permitted`

原因：

- 原先桥脚本尝试写 `C:\Users\40323\.openclaw\...sync.json`

解决：

- 改成写：
  - `D:\openclaw\.wechat-direct-bridge\...`

---

## 错误 5：回复出现乱码

原因：

- Windows 终端编码和脚本文件编码不一致

解决：

- 代码中尽量用 ASCII
- 对必要中文使用 Unicode 转义
- 避免在 PowerShell 管道里直接写大量中文再回写文件

---

## 错误 6：确认后回复“要”，却没执行情报流程

这是我们实际踩到过的逻辑 bug。

原因：

- 确认后把原句再丢回工作流
- 工作流又重新按普通规则判断一次
- 原句本身还是“边界不清”
- 于是掉回普通聊天回复

解决：

- 在工作流里加入 `force` 开关
- 对“确认后执行”的场景强制走情报流程

---

## 错误 7：重复写入 Notion

原因：

- 没有去重

解决：

- 按 `链接` 查询数据库
- 已存在则跳过

---

## 错误 8：Notion 偶发写入失败

原因：

- 网络抖动
- Notion API 短时超时

解决：

- 对 Notion 请求加超时
- 加简单重试

---

## 当前推荐运行方式

### 1. 启动 gateway

```powershell
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
  -ArgumentList 'C:\Users\40323\AppData\Roaming\npm\node_modules\openclaw\dist\index.js','gateway','--port','18789' `
  -WorkingDirectory 'D:\openclaw' `
  -WindowStyle Hidden
```

### 2. 启动桥

```powershell
powershell -ExecutionPolicy Bypass -File D:\openclaw\start-wechat-direct-bridge.ps1
```

### 3. 查看日志

```powershell
Get-Content -LiteralPath 'D:\openclaw\wechat-direct-bridge.log' -Tail 100
```

---

## 当前推荐用法

### 普通聊天

```text
早上好
```

### 明确情报任务

```text
帮我找今天AI最有用的3条信息
```

### 场景化情报

```text
帮我找今天适合自媒体的AI信息3条
```

```text
帮我找今天适合编程的AI信息3条
```

```text
帮我找今天和短视频有关的AI信息5条
```

### 边界任务

```text
今天AI有什么值得看的
```

---

## 后续可继续扩展的方向

1. 定时自动推送
   - 每天固定时间自动抓 AI 情报
   - 自动写入 Notion
   - 自动发微信摘要

2. 更多情报类型
   - 财经情报
   - 行业情报
   - 竞品情报

3. 更多数据落点
   - 飞书多维表
   - Google Sheets
   - Airtable

4. 更完整的产品交互
   - 分阶段处理中提示
   - 更短的摘要模式
   - 失败重试通知

---

## 一句话总结

这套最终方案的关键不是“把 OpenClaw 当聊天工具用”，而是：

**把微信当入口，把 OpenClaw 当本地自动化编排层，把模型、资讯源和 Notion 串成一个真实可用的工作流。**
