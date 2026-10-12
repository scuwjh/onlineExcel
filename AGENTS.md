# Repository Guidelines（仓库指南）

本仓库是一个在线协同表格（钉钉表格网页端复现）项目，目标人群为 20 人以内的内部团队。
仓库同时包含需求与规划文档，以及已经落地的 v2 实现（JWT 鉴权 + 表格级 RBAC + diff 化版本 + CRDT 收敛 + 虚拟滚动）。

## 项目结构与模块组织

- `frontend/` — React 18 + TypeScript + Vite 前端。
  - `src/hooks/useSheet.ts` — 协同状态机（乐观更新、服务端权威校准、版本向量、合并区域与撤销重做）。
  - `src/hooks/usePreferences.ts` — 个性化偏好（快捷键/常用颜色/Enter 方向，服务端按用户保存）。
  - `src/lib/shortcuts.ts` / `findReplace.ts` / `merge.ts` / `copyImage.ts` — 快捷键解析、查找替换、
    合并区域运算、复制为图片（ESM，纯函数，配 `scripts/*.test.mjs` node 单测）。
  - `src/components/Grid.tsx` — 虚拟滚动网格（sticky 冻结行列 + 事件委托，DOM 节点数恒定）。
  - `src/components/Panels.tsx` — 历史版本面板（diff/恢复）与成员权限面板。
  - `src/ws.ts` / `src/api.ts` — 实时通道与 REST 客户端（令牌注入、401 清理会话）。
- `backend/` — Python + FastAPI + SQLite，提供 REST API 与 WebSocket 协同服务。
  - `app/crdt.py` — 协同状态机：LWW 寄存器、有序行列元素、合并区域（元素 ID 锚定）、操作应用与重放（纯函数，便于单测）。
  - `app/store.py` — 数据访问：用户/权限/表格/操作日志/版本（增量、快照、压缩、diff）。
  - `app/auth.py` — PBKDF2 口令、JWT 签发校验、RBAC 判定。
  - `app/routes.py` / `app/ws.py` — REST 与 WebSocket 入口，两者共用同一操作日志语义。
  - `app/bootstrap.py` — 启动引导与 v1（全表快照）→ v2（增量）迁移。
  - `app/dingtalk.py` — 钉钉机器人推送（REQ-115）：加签、@手机号、后台线程投递，失败不影响写入。
  - `tests/` — pytest：鉴权与 RBAC、版本 diff 化与迁移、CRDT 收敛、WebSocket。
- `docs/api-contract.md` — 前后端共同依据的接口契约，**接口变更需先改此文档**。
- `docker-compose.yml` — 单机部署配置。
- `需求清单.md` — 按优先级划分的产品需求（P0/P1/P2）、用户角色、非功能需求。
- `钉钉表格网页端复现开发团队组建工作流-2026-10-09T02-50-05-全过程.md` — 架构、安全、团队里程碑等规划笔记。

## 开发流程与接口契约

1. 数据模型：`User` / `Sheet` / `Permission` / `Cell` / `Structure`（有序行列元素）/ `Op` / `Version`。
2. 接口契约（API-first）：先改 `docs/api-contract.md`，再改代码；REST 与 WebSocket 事件必须同步。
3. 数据库迁移：在 `db.py::_migrate` 中追加**幂等**迁移，保证旧库可平滑升级（v1 快照已迁移为增量）。
4. 写操作统一走 `store.apply_ops`：写操作日志 → 生成增量版本 → 刷新派生状态。
   新增操作类型时，需同时实现 `crdt.apply_op` 分支与广播形态，否则 REST/WS 语义会分叉。
5. 前端新增状态变更时，优先通过 `useSheet` 的 reducer 表达，保持"服务端权威校准"的单一来源。
6. 测试与部署：`pytest` + `npm run build` + `smoke_e2e.py`，Docker Compose 单机部署。

核心约定：

- 优先定义 `Cell` 更新与协同同步两条核心链路。
- WebSocket 事件：`welcome`、`cell_update`、`cell_format`、`row_insert`/`row_delete`、
  `col_insert`/`col_delete`、`sheet_import`、`cursor`、`presence`、`error`、`pong`。
- 大表格（单帧超 `OE_MAX_WS_MESSAGE`）一律退化为 `reload: true`，由客户端经 REST 拉取权威状态。

## 构建、测试与开发命令

后端（`backend/`）：

- `pip install -r requirements.txt` — 运行依赖；`requirements-dev.txt` 追加 pytest/httpx。
- `uvicorn app.main:app --reload` — 本地启动，API 文档见 `/docs`。
- `pytest` — 运行测试（100 项，覆盖鉴权、版本、CRDT、WebSocket、Excel/评论、合并、偏好、钉钉）。

前端（`frontend/`）：

- `npm install` — 安装依赖。
- `npm run dev` — 开发服务器（`http://localhost:5173`，已代理 `/api` 与 `/ws`）。
- `npm run build` — `tsc --noEmit` 类型检查 + 生产构建，**提交前必须通过**。

整体：`docker compose up --build` 单机部署，前端 `:8080`、后端 `:8000`。

## 编码风格与命名规范

- TypeScript：2 空格缩进，变量/函数 `camelCase`，组件 `PascalCase`，类型 `PascalCase`。
- Python：4 空格缩进，PEP 8，函数/变量 `snake_case`，类 `PascalCase`；模块内私有函数以 `_` 前缀。
- 统一使用既定技术栈：React 18 + TypeScript + Vite；FastAPI + SQLite；WebSocket + LWW/CRDT；JWT + RBAC。
  （需求清单中的 Redux Toolkit / Ant Design / Canvas 渲染为规划项，当前实现未采用，若引入需先更新契约与本文档。）
- 需求保持与 `需求清单.md` 中的 `REQ-xxx` / `NFR-xxx` 编号可追溯。
- 注释与用户可见文案使用中文；错误信息需可直接展示给用户。

## 测试规范

- 后端用 pytest，夹具集中在 `backend/tests/conftest.py`（每个用例独立临时数据库）。
- 必须覆盖：权限边界（viewer 不可写、非成员不可读）、并发收敛（并发写同一格、并发插同一行位置）、
  版本正确性（增量存储、diff、恢复、压缩后可重建）、WebSocket 鉴权与广播。
- 前端目前以 `tsc --noEmit` + `vite build` 作为门槛；新增交互逻辑应优先下沉到 `useSheet`/`lib` 以便测试。
- 端到端回归脚本（仓库自带，发布前都应跑通）：
  - `scripts/verify-e2e.py` — HTTP + WebSocket 断言（协同收敛、权限边界、大表格 reload 退化、版本 diff/恢复）；
  - `scripts/verify-ui.py` — 浏览器 UI 断言（登录、虚拟滚动、编辑/公式/撤销重做、剪贴板粘贴、面板、双标签同步），
    需要 Playwright + 系统 Edge，并同时启动后端与 `npm run dev`；
  - `scripts/verify-new-features.py` — 本轮新增功能（REQ-110..115）：合并单元格的投影/扩展/版本 diff/恢复、
    个性化偏好读写与校验、钉钉集成状态与权限；UI 部分缺 Playwright 时记为 SKIP。

## 提交与 Pull Request 规范

使用约定式、祈使句的提交信息（如 `feat: 新增单元格编辑`）。PR 保持小而聚焦；
说明改动内容，关联对应 `REQ-*` 编号，UI 改动附截图或演示视频；
涉及接口的改动必须同时更新 `docs/api-contract.md`。

## 安全说明

已落实（NFR-030~034 基线子集）：

- HTTPS 由部署层承担；`OE_HSTS=1` 时后端下发 HSTS。
- JWT 鉴权 + 表格级 RBAC 校验；WebSocket 握手与每条写操作均校验角色，权限收紧立即生效。
- 输入校验：行列上限、单元格文本长度上限、操作载荷大小上限；登录按 IP 限流。
- 错误信息脱敏（不返回堆栈）、安全响应头（CSP / nosniff / frame-options / referrer-policy）。
- 口令 PBKDF2-SHA256（120000 轮 + 随机盐）；初始管理员口令可用环境变量固定。

待落实：操作日志与异常行为监控（NFR-035）、敏感数据静态加密与密钥管理（NFR-036）、
完整审计导出、CSV 导入的文件类型/大小白名单校验。
