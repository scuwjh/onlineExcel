# Repository Guidelines（仓库指南）

本仓库记录一个在线协同表格（钉钉表格网页端复现）项目，目标人群为 20 人以内的内部团队。当前已包含最小 MVP 实现，需求与规划文档位于仓库根目录。

## 项目结构与模块组织

- `frontend/` — React 18 + TypeScript + Vite 前端，含表格网格、公式栏、实时协同客户端。
- `backend/` — Python + FastAPI + SQLite 后端，提供 REST API 与 WebSocket 协同服务。
- `docs/api-contract.md` — 前后端共同依据的接口契约，接口变更需先改此文档。
- `docker-compose.yml` — 单机部署配置。
- `需求清单.md` — 按优先级划分的产品需求（P0/P1/P2）、用户角色、非功能需求。
- `钉钉表格网页端复现开发团队组建工作流-2026-10-09T02-50-05-全过程.md` — 架构、安全、团队里程碑等规划笔记。

## 开发流程与接口契约

需求确定后按以下顺序推进：

1. 数据模型：落地 `Workbook`、`Worksheet`、`Cell`、`Formula`、`Permission`、`ChangeRecord` 的实体与字段。
2. 接口契约（API-first）：前后端共同定义 REST API（OpenAPI/Swagger）与 WebSocket 事件协议，产出 `openapi.yaml` 与事件消息文档。
3. 数据库 Schema：依据数据模型生成迁移脚本。
4. 项目骨架：React + TypeScript + Vite、FastAPI、Node 协同层，先跑通最简前后端链路。
5. 并行开发：后端按契约实现，前端用 mock/stub 先行。
6. 集成联调：重点验证 WebSocket 协同与权限边界。
7. 测试与部署：单测 + 协同一致性测试 + Docker Compose 部署。

核心约定：

- 优先定义 `Cell` 更新与协同同步两条核心链路。
- WebSocket 事件示例：`join_room`、`cell_update`、`cursor_sync`、`presence`。
- 接口变更先改契约文档，再改代码。

## 构建、测试与开发命令

后端（`backend/`）：

- `pip install -r requirements.txt` — 安装依赖。
- `uvicorn app.main:app --reload` — 本地启动，API 文档见 `/docs`。
- `pytest` — 运行后端测试（当前 MVP 尚未编写测试）。

前端（`frontend/`）：

- `npm install` — 安装依赖。
- `npm run dev` — 启动开发服务器（默认 `http://localhost:5173`）。
- `npm run build` — 类型检查并构建生产产物。

整体：`docker compose up --build` 可单机部署，前端 `:8080`、后端 `:8000`。

## 编码风格与命名规范

- TypeScript：2 空格缩进，变量/函数用 `camelCase`，组件用 `PascalCase`。
- Python：4 空格缩进，遵循 PEP 8，函数/变量用 `snake_case`，类用 `PascalCase`。
- 统一使用既定技术栈：React 18 + Redux Toolkit + Ant Design；FastAPI、WebSocket + CRDT/OT、JWT + RBAC。
- 需求保持与 `需求清单.md` 中的 `REQ-xxx` / `NFR-xxx` 编号可追溯。

## 测试规范

前端单元测试采用 Vitest/Jest，后端采用 pytest（当前 MVP 尚未落地测试）。优先覆盖多人协同一致性测试（并发编辑冲突）、虚拟滚动性能测试和权限边界测试。暂未设定覆盖率阈值。

## 提交与 Pull Request 规范

使用约定式、祈使句的提交信息（如 `feat: 新增单元格编辑`）。PR 保持小而聚焦；说明改动内容，关联对应 `REQ-*` 编号，UI 改动附截图或演示视频。

## 安全说明

MVP 基线要求 HTTPS、JWT 认证、表格级权限校验、输入校验与 XSS 防护、上传文件类型与大小限制。首个后端接口起即应落实这些要求。
