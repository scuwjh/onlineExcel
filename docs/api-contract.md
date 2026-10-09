# 接口契约（MVP）

本文档是前后端并行开发的共同依据。接口变更必须先改本文档，再改代码。

## 数据模型

- `Sheet`：工作簿/表格，包含 `id`、`name`、`created_at`、`updated_at`。
- `Cell`：单元格，由 `sheet_id`、`row`（0 起）、`col`（0 起）定位；`value` 为原始输入字符串（可为数字、文本或 `=公式`），`format` 为 JSON 格式对象（可选）。
- `Sheet` 另含 `rows`、`cols`，记录动态行列数。
- `Version`：版本快照，`id`、`sheet_id`、`snapshot`（JSON 字符串）、`created_at`。

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sheets` | 表格列表 |
| POST | `/api/sheets` | 创建表格，body `{"name": "..."}` |
| GET | `/api/sheets/{id}` | 获取表格及单元格数据 |
| PUT | `/api/sheets/{id}/cells` | 批量更新单元格，body `{"updates": [{"row":0,"col":0,"value":"..."}], "user":"..."}`，返回新版本号与受影响单元格 |
| POST | `/api/sheets/{id}/import` | 整体替换表格内容，body `{"rows":100,"cols":20,"cells":{"0:0":"..."},"user":"..."}` |
| POST | `/api/sheets/{id}/rows?at=0` | 在指定行前插入一行 |
| DELETE | `/api/sheets/{id}/rows/{at}` | 删除指定行 |
| POST | `/api/sheets/{id}/cols?at=0` | 在指定列前插入一列 |
| DELETE | `/api/sheets/{id}/cols/{at}` | 删除指定列 |
| GET | `/api/sheets/{id}/versions` | 版本列表 |
| POST | `/api/sheets/{id}/versions/{version_id}/restore` | 恢复指定版本 |

响应统一为 `{"ok": true, "data": ...}` 或 `{"ok": false, "error": "..."}`。

## WebSocket 协议

连接地址：`/ws/sheets/{id}?user=<用户名>`

客户端 → 服务端与广播消息使用同一格式 `{"type": "...", ...}`：

- `cell_update`：`{type, row, col, value, user}`，服务端落库后广播给同表格所有连接。
- `cell_format`：`{type, row, col, format, user}`，更新单元格格式，`format` 为 `null` 时清除。
- `row_insert` / `row_delete`：`{type, at, user}`，插入/删除行并广播。
- `col_insert` / `col_delete`：`{type, at, user}`，插入/删除列并广播。
- `sheet_import`：`{type, user}`，导入后通知其他客户端重新拉取数据。
- `cursor`：`{type, row, col, user}`，转发给其他用户，用于光标/选中显示。
- `presence`：`{type, user, online: true|false}`，服务端维护在线列表并广播。

格式对象示例：`{"bold":true,"italic":false,"underline":false,"color":"#d32f2f","bg":"#fff","align":"center"}`。冻结窗格为前端本地视图状态，暂不持久化、不同步。

## 协同与冲突

MVP 采用「乐观更新 + 最后写入者胜」，按单元格粒度覆盖，不做完整 OT/CRDT。每个写操作（值、格式、行列、导入）落库后生成一个版本快照。鉴权暂缺省，内部 20 人团队使用，后续补 JWT + RBAC。

## 公式约定

`value` 以 `=` 开头视为公式。MVP 支持：

- `=SUM(A1:B2)`、`=AVERAGE(A1:B2)`
- `=IF(A1>10,"高","低")`
- 引用：`A1`、`A1:B2`

公式只在前端求值显示，后端原样存储 `value`。
