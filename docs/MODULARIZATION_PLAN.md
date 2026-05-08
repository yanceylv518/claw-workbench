# 小龙虾本地端渐进式模块化改造计划

这份文档定义从当前本地脚本系统升级到本地端专业后台的最小改动路径。核心策略是：先清晰化，再模块化，再产品化，最后稳定化。

## 目标

最终目标不是做云端 SaaS，也不是多人协作平台，而是把现有能力整理成一个稳定、清晰、可维护的本地端小龙虾后台：

```text
React 小龙虾后台
-> 本地 Node.js API 服务
-> 本地任务执行器
-> 本地文件数据目录
-> 可选 SQLite 索引库
-> Hermes 内容脑模块
-> 现有工作流能力
-> Notion / 微信 / 小红书 / OpenClaw
```

本地端优先支持：

- 本机一键启动
- 本机后台专业化
- 发布包中心
- 任务中心
- 知识库
- 配置中心
- 可追踪任务状态
- 失败重试
- 日志可视化
- 本地数据备份和恢复

## 目标模块边界

建议逐步形成以下目录：

```text
apps/
  web/                 React 小龙虾后台
  api/                 本地 Node.js API 服务
  worker/              本地任务执行器，可选独立进程

packages/
  config/              配置读取、脱敏、迁移
  storage/             本地文件、发布包、可选 SQLite 索引适配
  llm/                 模型 provider、OpenClaw agent、调用日志
  workflows/           情报、小红书、财经、小队等业务流程
  hermes/              Hermes 研究、内容脑、质检、人类编辑
  wechat/              微信插件、消息发送、上下文
  notion/              Notion 写入、关系同步、字段映射
  xiaohongshu/         小红书预填、发布包平台适配
  shared/              通用类型、工具函数、常量

docs/
  CURRENT_SYSTEM.md
  MODULARIZATION_PLAN.md
```

第一阶段只建文档，不强行移动旧文件。后续每移动一个模块，都要先有兼容导出，确保旧调用点不受影响。

## 阶段 1：文档化和边界冻结

目标：

- 记录当前入口
- 记录当前数据位置
- 记录当前业务流程
- 明确旧功能不能被破坏

改动范围：

```text
docs/
```

不改动：

```text
*.mjs
*.ps1
*.json
```

验收标准：

- 能从文档看懂系统怎么启动
- 能从文档看懂后台、微信、早报、小红书流程的关系
- 运行代码无变化

## 阶段 2：新前端旁路

目标：

把当前嵌在 `console-server.mjs` 里的后台页面，旁路重建成专业前端。

新增：

```text
apps/web
```

技术：

```text
React + Vite + TypeScript
```

保持不变：

- 旧 `console-server.mjs` 继续提供页面
- 旧 API 继续使用
- 旧工作流继续使用

新前端先调用旧 API：

```text
/api/status
/api/packages
/api/package
/api/config
/api/logs
/api/content-task
/api/content-options
/api/knowledge-base
/api/business-flow
```

验收标准：

- 旧后台仍可打开
- 新后台能查看状态、日志、发布包
- 新后台能触发内容任务

## 阶段 3：API 服务旁路

目标：

把 API 从单文件控制台里拆成更清晰的本地服务，但不重写业务流程。

新增：

```text
apps/api
```

API 服务先复用现有工作流：

```text
xiaohongshu-draft-workflow.mjs
notion-ai-intel-workflow.mjs
finance-news-workflow.mjs
lobster-squad-workflow.mjs
openclaw-agent-client.mjs
```

验收标准：

- 新 API 能提供和旧 API 等价的核心接口
- 旧 `console-server.mjs` 仍可用
- 新前端可切换到新 API

## 阶段 4：登录和角色

目标：

本地端默认不需要复杂登录。这里改为增加本机访问保护和危险操作确认。

可选保护方式：

```text
本机访问口令
配置页保护
危险操作二次确认
API Key 脱敏展示
```

验收标准：

- 新后台默认仍适合本机使用
- 敏感配置不会直接明文展示
- 删除、覆盖、批量清理等危险操作有确认
- 旧本地后台不受影响

## 阶段 5：本地索引层

目标：

先不引入服务端数据库。根据需要增加本地 SQLite 索引库，用来提升任务、发布包和日志查询体验。

SQLite 只存结构化索引：

```text
content_tasks
content_packages
workflow_runs
workflow_steps
model_calls
knowledge_items
business_flows
local_events
```

本地文件继续保存：

```text
D:\XiaolongxiaData\xiaohongshu-drafts
D:\XiaolongxiaData\xiaohongshu-images
D:\XiaolongxiaData\outbound-audio
```

验收标准：

- 发布包有数据库索引
- 仍能通过旧目录找到原始文件
- 旧发布包不需要一次性迁移
- 没有 SQLite 时仍可 fallback 到扫描本地目录

## 阶段 6：本地任务执行器

目标：

后台新建任务改为本地异步执行，避免页面长时间等待。

技术：

```text
第一版：Node.js 内存队列 + 本地状态文件
增强版：SQLite 状态表
```

流程：

```text
新后台提交任务
-> API 创建本地任务
-> 投递本地队列
-> Worker 调用旧工作流
-> 写入步骤状态
-> 生成发布包
-> 更新任务状态
```

并发规则：

```text
全局内容生成并发：1-3
单用户内容生成并发：1
OpenClaw 并发：1
```

验收标准：

- 页面不再长时间等待生成
- 任务可见排队、运行、完成、失败
- 失败任务可重试
- 微信入口暂时不受影响

## 阶段 7：Hermes 模块化

目标：

把 Hermes 从 `xiaohongshu-draft-workflow.mjs` 中逐步抽出。

目标目录：

```text
packages/hermes/
  research/
  content-brain/
  quality-review/
  human-editor/
```

约束：

- 保持现有输入输出结构
- 保持现有 fallback
- 旧工作流只替换内部调用，不改变外部 API

验收标准：

- 小红书发布包结果不变
- Hermes 失败仍可降级
- Worker 和旧工作流能复用同一套 Hermes 模块

## 阶段 8：微信异步化

目标：

微信入口可选从同步执行改为创建本地任务和完成通知。

旧流程：

```text
微信消息 -> 同步生成 -> 微信回复结果
```

新流程：

```text
微信消息 -> 创建任务 -> 立即回复已排队
Worker 完成 -> 主动微信通知
```

必须保留开关：

```text
WECHAT_ASYNC_WORKFLOW=true|false
```

验收标准：

- 微信收到长任务时不会长时间卡住
- 任务完成后能主动通知
- 开关关闭后可回到旧同步流程

## 阶段 9：配置数据库化

目标：

把散落的 JSON 配置统一到本地配置层。是否使用 SQLite 存配置由后续决定，第一阶段不强制迁移。

迁移策略：

```text
配置层统一读取
旧 JSON 继续作为事实来源
后台保存仍写旧 JSON
后续可增加 SQLite 镜像索引
保留导入/导出 JSON
```

迁移对象：

- 模型 provider
- Notion 配置
- Hermes 配置
- 内容选项
- 知识库
- 业务流
- 人类编辑规则

验收标准：

- 配置可在后台编辑
- 密钥不明文展示
- 旧 JSON 可作为 fallback

## 阶段 10：本地端打包和一键启动

目标：

本方向不做服务器部署。阶段 10 改为本地端打包和一键启动。

建议交付：

```text
Windows 一键启动脚本
Windows 一键停止脚本
本地健康检查
本地数据备份
本地数据恢复
可选桌面快捷方式
```

验收标准：

- 新本地后台一键启动
- 旧控制台仍可作为备用
- 数据目录可备份和恢复
- 日志可查看
- 升级不覆盖用户数据

## 每一步的回退规则

任何阶段都必须满足：

- 旧入口可用，直到明确退役
- 旧数据目录不被破坏
- 旧配置文件不被覆盖
- 新服务失败时能回退旧流程
- 工作流输出格式不随意变化
- 每次只迁移一个调用边界

## 当前下一步

完成文档化后，下一步建议开始阶段 2：

```text
新建 apps/web
用 React + Vite + TypeScript 复刻当前后台壳
先只实现状态、日志、发布包列表三个只读页面
仍然调用旧 console-server.mjs 的 API
```

这样可以开始产品模块化，但不会碰到最重的工作流。
