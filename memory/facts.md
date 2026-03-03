# 项目长期事实

> 这个文件由 Orchestrator 维护，记录系统长期稳定的事实，所有 agent 只读。

## 技术栈
- **后端**: Go + Gin 框架
- **前端**: Next.js + TypeScript
- **数据库**: PostgreSQL
- **缓存**: Redis
- **CI/CD**: GitLab CI

## 代码约定
- Go 代码遵循 `gofmt` 标准格式
- API 路径前缀：`/api/v2/`
- 数据库迁移：使用 `golang-migrate`
- 测试命令：`make test`

## 模块结构
- `server/` - Go 后端
- `web/` - Next.js 前端
- `server/handlers/` - API 处理器
- `server/models/` - 数据模型
- `server/services/` - 业务逻辑

## 重要配置
- 生产环境部署通过 `git push origin main` 触发 GitLab CI
- 需要人工飞书确认后才能部署

## 更新记录
- 2026-03-03: 初始化
