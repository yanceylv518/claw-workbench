# 小龙虾本地端目标技术架构

这份文档描述本地端目标架构。它不是云端 SaaS 方案，而是后续把当前本地脚本系统改造成专业本地后台的方向。

## 技术栈

建议本地端使用：

```text
前端：React + Vite + TypeScript
后端：Node.js 本地 API 服务，可用 Fastify 或原生 http 渐进迁移
索引库：可选 SQLite
任务执行：Node.js 本地 worker，可先用内存队列和状态文件
文件存储：本机数据目录 D:\XiaolongxiaData
启动方式：PowerShell 一键启动脚本
外部能力：OpenClaw、微信插件、Notion、小红书预填、模型 API
```

## 系统结构

```text
本机浏览器
  |
  v
React 小龙虾后台
  |
  v
本地 Node.js API
  |
  +--> 本地文件数据目录
  |      发布包、图片、音频、日志、配置、浏览器 profile
  |
  +--> 可选 SQLite 索引库
  |      任务、发布包索引、步骤状态、模型调用记录
  |
  +--> 本地任务执行器
         |
         +--> Hermes 内容脑
         +--> 模型 API
         +--> OpenClaw 可选执行器
         +--> Notion
         +--> 微信通知
         +--> 小红书预填
```

## 产品模块

前端后台保留“小龙虾后台”这个产品形态，建议模块如下：

```text
仪表盘
内容生产
任务中心
发布包中心
选题与素材
知识库
Hermes 内容脑
业务流
模型配置
Notion 配置
微信配置
小红书配置
系统日志
系统状态
```

## 后端模块

API 服务负责：

- 任务创建
- 任务状态查询
- 发布包索引
- 知识库管理
- 配置管理
- 日志查询
- 本地任务投递
- 敏感配置脱敏
- 危险操作确认

API 服务尽量不直接执行长时间内容生成任务。长任务交给本地任务执行器，避免后台页面卡住。

## 本地任务执行器

本地任务执行器负责：

- 情报抓取
- Hermes 研究
- 内容生成
- 去 AI 味
- 质量检查
- 生图
- 写 Notion
- 保存发布包
- 发微信通知
- 调用 OpenClaw 可选能力

本地任务执行器是长任务的主执行位置。第一版可以和 API 同进程，后续再拆成独立进程。

## 数据存储

本地端以文件为事实来源：

```text
D:\XiaolongxiaData\xiaohongshu-drafts
D:\XiaolongxiaData\xiaohongshu-images
D:\XiaolongxiaData\outbound-audio
D:\XiaolongxiaData\browser-profiles
D:\XiaolongxiaData\*.log
D:\XiaolongxiaData\*.json
```

可选 SQLite 存结构化索引：

```text
content_tasks
content_packages
workflow_runs
workflow_steps
model_calls
knowledge_items
local_events
```

SQLite 只做索引和查询加速，不替代本地发布包文件。没有 SQLite 时，系统仍应能扫描目录运行。

## OpenClaw 的角色

OpenClaw 在目标架构中仍是本地自动化能力的重要部分，但需要明确边界。

建议定位：

- 可选执行器
- 本地桥接能力
- 高级任务 fallback
- OpenClaw agent 调用封装

OpenClaw 必须有并发锁：

```text
openclaw concurrency = 1
```

## Hermes 的角色

Hermes 是内容脑模块，而不是独立用户入口。

职责：

- 研究卡片
- 内容策略
- 初稿生成约束
- 人类编辑/去 AI 味
- 质量检查
- 平台适配

Hermes 应由本地任务执行器调用，并保存每次输入、输出、耗时和错误。

## 本地队列和并发

本地端第一阶段建议：

```text
全局生成任务并发：1
OpenClaw 并发：1
Notion 写入并发：2
生图并发：1
```

所有长任务都应该具备：

- 排队
- 运行中
- 完成
- 失败
- 可重试
- 可取消
- 步骤日志

## 兼容策略

改造期间必须支持：

- 旧本地后台继续运行
- 旧微信桥继续运行
- 旧发布包目录继续可读
- 旧 JSON 配置继续 fallback
- 新系统先做旁路，不强行迁移所有历史文件
- 不引入云端依赖作为基础能力
