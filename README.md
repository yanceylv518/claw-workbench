# 小龙虾本地版

小龙虾本地版是一个本地优先的 AI 内容工作台，面向内容选题、知识沉淀、小红书发布包生成、微信入口和本地交付部署。

当前版本：`v0.1.0`

## 主要能力

- 任务中心：创建、执行和追踪本地内容任务。
- 小红书发布包：生成标题、正文、配图提示词、质量检查和本地素材包。
- 情报库：维护外部情报、行业话题和可转化选题。
- 知识库：沉淀内容方法、行业规则和项目知识。
- 发布包：管理本地生成的内容包和素材。
- 入口助手：支持微信扫码连接和消息触发任务。
- 模块与插件：配置模型 API、图片生成、Notion、Hermes Worker 和可选能力。
- 系统日志：查看本地 API、微信 Bridge、任务工作流和发布预填日志。

## 本地开发

```powershell
npm install
npm run check:mojibake
npm --workspace apps/web run build
npm run api:local
```

前端开发：

```powershell
npm run web:dev
```

## 打包

完整安装包：

```powershell
npm run package:local
```

覆盖升级包：

```powershell
npm run package:upgrade
```

版本号统一维护在 `VERSION.json`。

## 交付策略

- 新客户：使用完整安装包。
- 老客户推荐升级：解压新完整安装包到新目录，运行 `迁移旧数据到当前版本.bat`。
- 内部快速升级：使用覆盖升级包。

## 注意

仓库不提交用户本地数据、日志、打包产物、API Key、Notion Token、微信登录状态和其他机器相关配置。
