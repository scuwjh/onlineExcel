# 在线协同表格（MVP）

面向 20 人以内内部团队的在线协同表格最小可用版本，支持多人同时编辑、实时同步、基础公式与版本记录。

## 已实现（MVP 范围）

- 动态行列的表格编辑：点击选中、双击/F2/Enter 编辑、方向键/Tab 导航。
- 基础公式：`=SUM(A1:B2)`、`=AVERAGE(A1:B2)`、`=IF(A1>10,"高","低")`，前端实时求值。
- 实时协同：WebSocket 广播单元格更新、在线用户列表、他人光标位置。
- 持久化：SQLite 存储表格与单元格，每次更新生成版本快照。
- 撤销/重做：本地历史栈（Ctrl+Z / Ctrl+Shift+Z）。
- 版本接口：列表与恢复（REST，UI 后续接入）。
- 格式设置：加粗、斜体、下划线、对齐、文字/背景颜色（实时同步）。
- 行列操作：插入/删除行与列（实时同步）。
- CSV 导入/导出：导入覆盖当前表格、导出为 CSV 文件。
- 冻结窗格：固定选中位置上方行与左侧列（本地视图状态）。

## 目录结构

- `frontend/` — React 18 + TypeScript + Vite 前端。
- `backend/` — Python + FastAPI + SQLite 后端（REST + WebSocket）。
- `docs/api-contract.md` — 前后端共同依据的接口契约。
- `docker-compose.yml` — 单机部署。

## 本地运行

后端（需要 Python 3.10+）：

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

前端（需要 Node 18+）：

```bash
cd frontend
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`。打开多个浏览器标签即可看到实时协同（每个标签是一个独立用户）。

## Docker 运行

```bash
docker compose up --build
```

前端访问 `http://localhost:8080`，后端 `http://localhost:8000/docs`。

## MVP 简化与后续

- 冲突处理为「最后写入者胜」，未实现 OT/CRDT。
- 撤销/重做目前仅本地生效，暂不广播给其他用户。
- 未实现：Excel 导入导出、鉴权（JWT + RBAC）、完整冲突算法（OT/CRDT）、撤销/重做同步到其他用户、虚拟滚动。

## 约定

代码规范、提交与 PR 约定见 `AGENTS.md`；接口契约见 `docs/api-contract.md`。
