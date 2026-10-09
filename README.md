# 在线协同表格（v2）

面向 20 人以内内部团队的在线协同表格，支持多人实时编辑、JWT 鉴权与表格级 RBAC、
diff 化历史版本、CRDT 风格的并发收敛，以及万行级虚拟滚动渲染。

- 技术栈：React 18 + TypeScript + Vite ｜ Python + FastAPI + SQLite（REST + WebSocket）
- 接口契约：[docs/api-contract.md](docs/api-contract.md)（**接口变更先改契约再改代码**）
- 需求清单：[需求清单.md](需求清单.md)
- 仓库约定：[AGENTS.md](AGENTS.md)

## 本轮改造（v1 → v2）

| 方向 | v1 | v2 |
|------|----|----|
| 版本存储 | 每次写入保存**整表 JSON 快照** | **操作日志 + 增量版本**，仅压缩点写快照；支持版本 diff、恢复、回退 |
| 鉴权 | 无 | **JWT + 表格级 RBAC**（owner/editor/commenter/viewer），REST 与 WebSocket 全覆盖 |
| 并发 | 最后写入者胜，行列变更会错位 | **LWW + 版本向量**，行列是稳定 ID 的一等元素，并发插删行不再漂移 |
| 渲染 | 全量 DOM 表格（100×20 固定） | **虚拟滚动**，DOM 节点数恒定，支持万行；冻结行列用 sticky |
| 其他 | — | 登录界面、成员权限面板、历史版本面板（对比/恢复）、速率限制、安全响应头、pytest 测试套件 |

## 已实现

- **编辑**：选中、双击/F2/Enter 编辑、方向键/Tab/PageUp/PageDown/Home/End 导航、
  Delete 清空、Ctrl+C 复制、Ctrl+V 批量粘贴（按制表符/换行解析）。
- **公式**：`=SUM`、`=AVERAGE`、`=IF(cond,a,b)`、`A1`/`A1:B2` 引用，前端实时求值 + 循环引用检测。
- **实时协同**：WebSocket 广播单元格/格式/行列操作、在线名单、他人光标；断线自动重连并重放队列。
- **并发收敛**：单元格 LWW（版本向量 + 客户端 ID 打破平局）；并发插入同一位置两行都保留；
  删除行/列连带清除其单元格；过期坐标写入被明确拒绝而不是写错位置。
- **鉴权与权限**：登录签发 JWT；表格级四级角色；WebSocket 握手与每条写操作都校验角色；
  权限被撤销后立即失效；登录限流 + 安全响应头（CSP/nosniff/frame-options）。
- **版本**：增量存储（无全表快照堆积）、版本列表、单元格级 diff、恢复（追加式）、回退、手动压缩点。
- **格式**：加粗/斜体/下划线/对齐/字色/底色，实时同步。
- **行列操作**：插入/删除行与列，基于稳定元素 ID，实时同步。
- **导入导出**：CSV 导入（整体替换并广播）／导出（带 BOM）；**Excel(.xlsx) 导入导出**
  （REQ-050）保留公式、字体/底色/对齐样式与冻结窗格，多工作表可选、公式交由 Excel 求值。
- **评论与 @提醒**（REQ-100）：评论绑定单元格的稳定元素 ID（插删行列后仍跟随），
  `@成员` 有输入候选与高亮，提及对象在服务端按表格成员校验，评论数显示为单元格角标，
  支持解决/重新打开/删除，并通过 WebSocket 实时广播（`comment_added` / `comment_updated`）。
- **筛选与排序**（REQ-101）：按列多条件筛选（包含/等于/大于…，多条件为「并且」），
  按列升序/降序排序；两者都是**本端视图**，不改动存储数据，空值恒排在末尾，
  面板与状态栏会提示当前生效的视图。
- **删除表格**：仅所有者可删除，连带清理权限、单元格、结构、版本、操作日志与评论。
- **冻结窗格**：独立分层实现（滚动区 + 左侧冻结列 + 顶部冻结行 + 左上角），本地视图状态。
- **撤销/重做**：本地历史栈（Ctrl+Z / Ctrl+Shift+Z），会以写操作形式同步到服务端。
- **大表格保护**：单帧 WebSocket 体积超限时退化为 `reload` 提示，客户端改用 REST 拉取。

## 目录结构

```
backend/
  app/
    main.py        FastAPI 入口：中间件、安全头、异常脱敏、限流
    config.py      环境变量与能力矩阵
    auth.py        PBKDF2 口令、JWT 签发校验、RBAC 判定
    db.py          SQLite 连接、建表、v1→v2 迁移
    crdt.py        协同状态机（LWW 寄存器、有序行列元素、操作应用/重放）
    store.py       数据访问：用户、权限、表格、操作日志、版本（增量/快照/压缩/diff）、评论
    routes.py      REST 路由（鉴权、表格、单元格、格式、行列、版本、权限、Excel、评论）
    xlsx.py        Excel(.xlsx) 导入解析与导出渲染（openpyxl）
    ws.py          WebSocket 房间、鉴权、广播与瘦身回退
    bootstrap.py   启动引导：管理员、v1 全表快照迁移
  tests/           pytest：鉴权/RBAC、版本 diff、CRDT 收敛、WebSocket、Excel 与评论
frontend/
  src/
    App.tsx            登录 → 工作区（表格页签 / 工具栏 / 面板）
    hooks/useSheet.ts  协同状态机：乐观更新 + 服务端权威校准 + 版本向量
    hooks/useComments.ts  评论与 @提醒状态（含 WebSocket 广播合并）
    api.ts             REST 客户端（携带 Bearer、401 自动清理会话、xlsx 上传下载）
    ws.ts              WebSocket 客户端（重连退避、离线队列、致命关闭码）
    components/Grid.tsx        虚拟滚动网格（四层冻结、展示行序、评论角标）
    components/Panels.tsx      历史版本面板 + 成员权限面板
    components/CommentsPanel.tsx  评论与 @提醒面板
    components/ViewPanel.tsx      筛选与排序面板
    lib/formula.ts / csv.ts / gridUtils.ts / viewFilter.ts
docs/api-contract.md  接口契约（REST + WebSocket + 环境变量）
```

## 本地运行

后端（Python 3.10+）：

```bash
cd backend
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export OE_JWT_SECRET="请替换为随机长密钥"                # 生产必须设置
export OE_ADMIN_PASSWORD="你的管理口令"                  # 不设置则启动时随机生成并打印
uvicorn app.main:app --reload
```

启动日志会打印初始管理员口令（当 `OE_ADMIN_PASSWORD` 未设置时）。首次登录会创建该账号。

前端（Node 18+）：

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173（已配置 /api 与 /ws 代理到 :8000）
```

打开多个浏览器标签、以不同用户名登录，即可看到实时协同、在线名单与他人光标。

## 测试

```bash
# 后端：鉴权/RBAC、版本 diff 化与迁移、CRDT 收敛、WebSocket、Excel 与评论（60 项）
cd backend
pip install -r requirements-dev.txt
pytest

# 前端：类型检查 + 生产构建
cd frontend
npm run build
```

端到端验证脚本（`scripts/`，仓库自带，都对真实服务发请求）：

```bash
# 1) HTTP + WebSocket 链路（39 项断言）：协同收敛、权限边界、大表格 reload 退化、版本 diff/恢复
pip install httpx websockets
python scripts/verify-e2e.py http://127.0.0.1:8000 admin <你的口令>

# 2) 浏览器 UI 链路（24 项断言，可选）：登录、虚拟滚动、编辑/公式/撤销重做、剪贴板粘贴、
#    版本与权限面板、千行滚动、双标签实时同步
pip install playwright httpx && playwright install msedge
python scripts/verify-ui.py     # 需同时启动后端与 `npm run dev`

# 3) 新增功能链路（19 项断言，可选）：Excel 导入导出、评论与 @提醒（含 WebSocket 广播）、
#    筛选与排序；脚本会自建临时表格并在结束时删除，不污染演示数据
pip install playwright httpx openpyxl
python scripts/verify-features.py
```

`verify-ui.py` 会把界面截图写到 `scripts/artifacts/shot-*.png`（已在 `.gitignore` 中忽略），便于人工核对渲染效果。

## 性能基线（本机实测）

| 场景 | 1000 行 | 10000 行 | 100000 行 |
|------|--------:|---------:|----------:|
| 单元格写入（服务端，含落库 + 版本） | 3.0ms | 4.1ms | 26.8ms |
| 插入行（需重写结构表） | 5.9ms | 38.6ms | 620ms |

- 单元格写入已从 v1 的"每次全表快照 + 全量重刷"优化到只写增量（10 万行场景约 **40 倍**提升）。
- **已知限制**：插入/删除行列会重写该表格的 `structure` 表，代价与行列数成正比（10 万行约 0.6 秒）。
  万行以内（`需求清单.md` 的 NFR-001 目标）表现良好；进一步优化方向是把结构改为
  "按元素 ID 的链表/分数位序"存储，使结构变更也变成 O(1) 写入。

## Docker 运行

```bash
docker compose up --build      # 前端 http://localhost:8080，后端 http://localhost:8000/docs
```

生产部署请显式设置 `OE_JWT_SECRET`、`OE_ADMIN_PASSWORD`，并把 `OE_DEV_AUTO_REGISTER` 设为 `0`；
在反向代理层启用 HTTPS（NFR-030）。Excel 导入依赖 `openpyxl`（已列入 `backend/requirements.txt`），
可用 `OE_MAX_XLSX_BYTES`（默认 10MB）限制上传体积，`OE_MAX_COMMENT_CHARS`（默认 2000）限制评论长度。

## 尚未实现

- 模板库、数据透视/图表（P1/P2）。
- 单元格区域框选与区域级操作（当前为单格选中 + 剪贴板批量粘贴）。
- 筛选/排序的视图状态持久化与分享（当前是本端会话内状态），以及"按值筛选"的多选列表
  （当前为条件表达式：包含/等于/大于…）。
- 评论的邮件/IM 外发通知（当前只在应用内提醒与角标展示）。
- xlsx 的合并单元格、条件格式与图表导入（当前保留值与字体/底色/对齐样式）。
- 结构变更的 O(1) 持久化（见上文性能限制）、操作日志的按时间分片归档。
- 前端组件级单测（Vitest）：目前依靠 `tsc --noEmit` + `scripts/verify-ui.py`、
  `scripts/verify-features.py` 浏览器链路保障。
