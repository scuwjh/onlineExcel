# 接口契约（v2）

本文档是前后端并行开发的共同依据。接口变更必须先改本文档，再改代码。

## 1. 鉴权

除 `GET /api/health`、`GET /api/config`、`POST /api/auth/login` 外，所有接口都需要携带令牌：

```
Authorization: Bearer <JWT>
```

- 令牌由 `POST /api/auth/login` 签发（HS256，默认 12 小时，`OE_TOKEN_TTL` 可调）。
- WebSocket 无法自定义请求头，令牌通过查询参数传递：`/ws/sheets/{id}?token=<JWT>`
  （也兼容 `Authorization` 头，便于服务端/测试客户端）。
- 口令使用 PBKDF2-SHA256（120000 轮 + 随机盐）存储。
- 初始管理员：用户名 `OE_ADMIN_USER`（默认 `admin`），口令取 `OE_ADMIN_PASSWORD`；
  未配置时启动生成一次性随机口令并打印到日志。
- `OE_DEV_AUTO_REGISTER=1`（默认）时，登录不存在的用户名会**自动注册为无任何表格授权的新用户**；
  生产环境应设为 `0`。

### 角色矩阵（表格级 RBAC）

| 角色 | 读取 | 评论 | 编辑（单元格/格式/行列/导入/恢复） | 管理（改名/权限/压缩点） |
|------|:----:|:----:|:--------------------------------:|:------------------------:|
| viewer | ✅ | ❌ | ❌ | ❌ |
| commenter | ✅ | ✅ | ❌ | ❌ |
| editor | ✅ | ✅ | ✅ | ❌ |
| owner | ✅ | ✅ | ✅ | ✅ |

- 表格创建者自动成为 owner。
- **兼容历史表格**：没有任何 `permissions` 记录的旧表格，认证用户默认可编辑（内部团队起步策略）。

## 2. 数据模型

- `User`：`id`、`username`、`password_hash`、`created_at`。
- `Sheet`：`id`、`name`、`rows`、`cols`、`owner_id`、`created_at`、`updated_at`。
- `Permission`：`(sheet_id, user_id) → role`。
- `Cell`：`(sheet_id, row, col)` 定位的派生表，含 `value`、`format` 以及
  LWW 元数据 `value_ver` / `format_ver`（版本向量）、`value_seq` / `format_seq`、`value_client` / `format_client`。
- `Structure`：**行/列是一等有序元素**，`(sheet_id, axis, position) → element_id`。
  元素 ID 形如 `{client_id}:r{n}`，创表时使用 `{sheet_id}:r{i}`。
- `Op`：操作日志，`seq`（服务端单调分配）、`client_id`、`kind`、`payload`（含版本向量）。
- `Version`：`id`、`parent_id`、`seq`、`ops`（**增量**）、`snapshot`（仅压缩点）、
  `base_rows` / `base_cols`（结构基线）、`user`、`message`、`created_at`。
- `Comment`：`id`、`sheet_id`、`row_id` / `col_id`（**稳定元素 ID**，不是行号列号）、
  `author_id`、`author`、`body`、`mentions`（JSON 数组）、`resolved`、`created_at`。
- `Merge`：合并区域，`sheet_id` + 四角**稳定元素 ID**（`r0_id`/`c0_id`/`r1_id`/`c1_id`，左上角在前）。
  用元素 ID 而不是行号列号，插入/删除行列后合并区域自动跟随（在区域内部插行会自然扩展开）。
- `UserPreferences`：按用户的个性化配置，`(user_id) → prefs`（JSON：快捷键、常用颜色、Enter 跳转方向）。
  单用户一行，跨设备生效；未设置过的用户返回内置默认值。

## 3. REST API

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | - | 登录，返回 `{token, token_type, expires_in, username}` |
| GET | `/api/auth/me` | 认证 | 当前用户与各表格角色 |
| GET | `/api/config` | - | 非敏感运行时配置（行列表限、角色列表等） |
| GET | `/api/sheets` | 认证 | 仅返回当前用户可见的表格 |
| POST | `/api/sheets` | 认证 | 建表，body `{"name","rows","cols"}`（行/列按 `OE_MAX_ROWS`/`OE_MAX_COLS` 夹取） |
| GET | `/api/sheets/{id}` | viewer | 表格全量数据（`cells`、`formats`、`merges`、`rowIds`、`colIds`、`version`、`seq`、`role`） |
| PATCH | `/api/sheets/{id}` | owner | 改名 |
| GET | `/api/sheets/{id}/access` | viewer | 当前用户的能力说明 |
| PUT | `/api/sheets/{id}/cells` | editor | 批量写单元格，body `{"updates":[{"row_id","col_id","value"}], "version":{clientId:seq}}` |
| PUT | `/api/sheets/{id}/formats` | editor | 批量写格式，`updates[].format` 为 `null` 表示清除 |

**单元格格式（REQ-007）**——`format` 是自由 dict，服务端不做字段白名单过滤，前端识别以下键：

| 键 | 类型 | 说明 |
|----|------|------|
| `bold` / `italic` / `underline` / `strike` | bool | 字体样式 |
| `font` | string | 字体族（如 `微软雅黑`） |
| `size` | number | 字号（pt，8–72） |
| `color` / `bg` | string | 字色 / 底色（`#rrggbb`） |
| `align` | `left`\|`center`\|`right` | 水平对齐 |
| `borders` | `{top,right,bottom,left}` bool | 四向边框 |
| `numFmt` | `general`\|`number`\|`integer`\|`percent`\|`currency`\|`date`\|`text` | 数字/日期格式，**只影响显示**，不改原始值与公式求值结果 |

区域格式由前端展开成多条 `cell_format` 广播（同一个 `version`）；整行/整列选中时展开为该行/列的所有单元格。
导出 xlsx 时会映射成 Excel 的字体/边框/数字格式（`¥#,##0.00`、`0.00%`、`yyyy-mm-dd` 等）。
| POST | `/api/sheets/{id}/ops` | editor | 通用结构操作（`insert_row`/`delete_row`/`insert_col`/`delete_col`/`merge`/`unmerge`） |
| POST | `/api/sheets/{id}/rows` | editor | 插入行，body `{"at","counter"}` |
| DELETE | `/api/sheets/{id}/rows/{at}` | editor | 删除行 |
| POST | `/api/sheets/{id}/cols` | editor | 插入列 |
| DELETE | `/api/sheets/{id}/cols/{at}` | editor | 删除列 |
| POST | `/api/sheets/{id}/import` | editor | 整体替换（CSV 导入） |
| GET | `/api/sheets/{id}/versions?limit=N` | viewer | 版本列表（含增量字节数、是否压缩点） |
| GET | `/api/sheets/{id}/versions/{vid}` | viewer | 重建该版本内容 |
| GET | `/api/sheets/{id}/versions/{vid}/diff?base=N` | viewer | 与 `base`（默认当前）做单元格级 diff |
| POST | `/api/sheets/{id}/versions/{vid}/restore` | editor | 恢复该版本（追加新版本，不改写历史） |
| POST | `/api/sheets/{id}/rollback?steps=N` | editor | 回退最近 N 个版本 |
| POST | `/api/sheets/{id}/snapshot` | owner | 建立压缩点并压缩超限快照 |
| GET | `/api/sheets/{id}/permissions` | owner | 成员列表 |
| PUT | `/api/sheets/{id}/permissions` | owner | 授权/改角色，body `{"username","role"}` |
| DELETE | `/api/sheets/{id}/permissions/{username}` | owner | 移除成员（所有者不可移除） |
| DELETE | `/api/sheets/{id}` | owner | 删除表格，连带清理权限/单元格/结构/版本/操作日志/评论 |
| POST | `/api/sheets/{id}/xlsx/parse` | editor | 解析上传的 xlsx，列出工作表名与统计（不落库）；body `{"data": base64, "sheet_name"?: string}` |
| POST | `/api/sheets/{id}/xlsx/import` | editor | 把 xlsx 的一个工作表导入为表格内容（整体替换，生成一个版本） |
| POST | `/api/sheets/{id}/xlsx/export` | viewer | 导出 `.xlsx`，body `{"frozen_rows"?, "frozen_cols"?}`；返回二进制附件 |
| GET | `/api/sheets/{id}/comments?include_resolved=bool` | viewer | 评论列表 + 每格未解决计数 + 可提及成员 |
| POST | `/api/sheets/{id}/comments` | commenter | 发表评论；body `{"row_id","col_id","body"}`，服务端解析并校验 `@提及` |
| POST | `/api/sheets/{id}/comments/{cid}/resolve` | commenter | 标记解决/重新打开；body `{"resolved": bool}` |
| DELETE | `/api/sheets/{id}/comments/{cid}` | commenter | 删除评论（作者本人，或 editor/owner） |
| GET | `/api/preferences` | 认证 | 当前用户的个性化配置（快捷键/常用颜色/Enter 方向），未设置返回默认值 |
| PUT | `/api/preferences` | 认证 | 覆盖式保存个性化配置（整体写入，服务端校验键与取值，超大返回 `invalid`） |
| GET | `/api/integrations/dingtalk` | 认证 | 钉钉机器人集成状态：`{enabled, configured, has_secret, mobile_map_size}`（**不返回 webhook 与 secret**） |
| POST | `/api/integrations/dingtalk/test` | owner | 向机器人发一条测试消息；需调用者是**任意一张表格的 owner**；未配置返回 `invalid` |

响应统一为 `{"ok": true, "data": ...}`；失败为
`{"ok": false, "error": "...", "code": "unauthorized|forbidden|not_found|invalid|rate_limited|error"}`。

### Excel 语义（REQ-050）

- 传输：xlsx 以 **base64** 放在 JSON body（避免引入 multipart 依赖），大小上限 `OE_MAX_XLSX_BYTES`（默认 10MB）。
- 导出：保留公式原文（`=SUM(...)` 交由 Excel 求值，不写缓存值以免出现错误结果）、
  字体加粗/斜体/下划线/字色、单元格底色、水平对齐、列宽与冻结窗格。
- 导入：值原样落库（数字按数值写入导出、文本读回），公式以**文本**导入（前端公式引擎只覆盖
  SUM/AVERAGE/IF，不保证求值）；合并单元格、条件格式、图表不导入；超长单元格按 `OE_MAX_CELL_CHARS` 跳过并计数返回。
- 导出响应头文件名使用 RFC 5987 百分号编码（HTTP 头不能承载中文），并额外返回 `X-Filename`。

### 评论与 @提醒（REQ-100）

- 定位：评论存 `row_id`/`col_id`（稳定元素 ID），因此插入/删除行列后评论仍跟随原单元格；
  写入时校验元素是否存在，不存在返回 400。
- `@` 词法：`@` 后接字母/数字/`_`/`-`/`.`，或一段非空白字符（兼容中文用户名）；
  只有**表格成员**的名字会被记入 `mentions`（避免把邮箱等误判为提醒）。
- 字数上限 `OE_MAX_COMMENT_CHARS`（默认 2000）。
- 广播：REST 与 WebSocket 两条写入路径都会向同表格房间推送
  `comment_added` / `comment_updated`（含 `comment` 与权威 `counts`）。

### 合并单元格（REQ-113）

- 操作：`merge`（合并）与 `unmerge`（取消合并），走与行列插删相同的协同链路
  （操作日志 → 增量版本 → 版本 diff → 撤销/重做 → WebSocket 广播 → 历史版本恢复）。
- 载荷（元素 ID 优先，索引仅作兼容回退）：
  - `merge`：`{"row_start_id","col_start_id","row_end_id","col_end_id"}`，或 `{"r0","c0","r1","c1"}` 索引形式；
  - `unmerge`：`{"row_id","col_id"}`（或 `{"row","col"}`）——取消**包含该单元格**的整个合并区域。
- 校验：区域必须是矩形且至少 2 个单元格；`merge` 与已有区域相交时，先自动取消相交的旧区域再合并（幂等）；
  `unmerge` 落在未合并单元格上为无操作。
- **不丢数据**：合并只记录区域，不清空区域内其它单元格的值与格式；渲染时非左上角单元格的内容被隐藏，
  取消合并后原样恢复。因此复制合并区域只输出左上角的值。
- 行/列插删的跟随规则：区域两端用元素 ID 锚定，在区域**内部**插入行列会自然扩展开；
  删除区域端点所在行列会让该区域失效（投影时跳过，不再渲染）。
- 投影：`GET /api/sheets/{id}`、`welcome`、结构类广播都会带权威 `merges`
  （`[{"r0","c0","r1","c1"}]`，已解析为当前行/列下标；元素已失效的区域不出现）。

### 个性化偏好（REQ-110 / REQ-112）

- 存储：`user_preferences` 一行一用户，JSON 覆盖式写入；未设置过的用户返回内置默认值。
- 字段（全部可选，服务端只做类型/长度/枚举校验，不认识的键原样保留）：
  - `shortcuts`：`{命令ID: 键位串}`，键位串形如 `Ctrl+B`、`Ctrl+Shift+1`、`Alt+2`（≤80 条，单条 ≤40 字符）；
  - `fillColors` / `highlightColors`：`#rrggbb` 数组（各 ≤24 个），顺序即快捷键 `Ctrl+Alt+1..9` 的绑定顺序；
  - `enterDirection`：`down`（默认）/`up`/`left`/`right`/`none`；`Shift+Enter` 取反方向。
- 快捷键命令 ID 是前后端约定的稳定标识（`format.bold`、`format.fill.<颜色>`、`formula.sum`、
  `formula.average`、`edit.find`、`merge.merge` …），前端 `lib/shortcuts.ts` 内置默认表，
  用户覆盖只保存差异；冲突时以命令表顺序为准并在设置面板提示。

### 钉钉机器人（REQ-115）

- 配置来自环境变量（不落库、不经接口下发，避免 webhook 泄漏）：
  `OE_DINGTALK_ENABLED`、`OE_DINGTALK_WEBHOOK`、`OE_DINGTALK_SECRET`（加签）、
  `OE_DINGTALK_MOBILES`（JSON：`{"用户名":"手机号"}`）、`OE_DINGTALK_TIMEOUT`。
- 触发：评论落库成功后，对**被 @ 且能映射到手机号**的用户推送一条 text 消息
  （`atMobiles` 精确 @，消息正文包含 `@手机号` 以满足钉钉自定义机器人的 @ 语义；从不 `isAtAll`）。
- 投递在后台线程执行、失败只记日志：**钉钉不可用绝不影响评论落库与广播**。
- 未配置 webhook 时接口状态返回 `{enabled: false, configured: false}`，评论功能照常。

### 查找与替换、复制为图片（REQ-111 / REQ-114，纯前端）

- 查找/替换只改本端数据，最终仍落到既有 `cell_update`（批量）操作，因此不新增协议；
  替换前后整表进入撤销栈一次。
- 复制选区时剪贴板同时写入三种格式：`text/plain`（TSV，粘贴到 Excel 保留行列）、
  `text/html`（带样式的 table）与 `image/png`（区域截图）。钉钉等 IM 优先取图片，
  因此粘贴后自动成为图片；不支持 `ClipboardItem`/图片写入的浏览器自动退化为纯文本。

## 4. WebSocket 协议

连接：`/ws/sheets/{id}?token=<JWT>`

- 握手前校验令牌与角色：401/403/404 分别以关闭码 `4401` / `4403` / `4404` 拒绝。
- 所有写操作在落库前**再次校验角色**，权限被收紧后立即生效。

### 上行（客户端 → 服务端）

| type | 字段 | 说明 |
|------|------|------|
| `cell_update` | `row_id`,`col_id`（或 `row`,`col`）,`value`,`client_id`,`version` | 写单元格；`value` 为 `null`/空串表示清空 |
| `cell_format` | `row_id`,`col_id`,`format`,`client_id`,`version` | 写格式，`format: null` 清除 |
| `row_insert` / `col_insert` | `at`,`counter`（或 `element_id`）,`client_id`,`version` | 在 `at` 前插入；`element_id` 由客户端生成以保证幂等 |
| `row_delete` / `col_delete` | `element_id`（或 `at`）,`client_id`,`version` | 按元素 ID 删除（推荐），索引作为兼容回退 |
| `cursor` | `row`,`col` | 光标/选中位置，仅转发 |
| `comment` | `row_id`,`col_id`,`body` | 发表评论（需 commenter 及以上），服务端广播 `comment_added` |
| `merge` | `row_start_id`,`col_start_id`,`row_end_id`,`col_end_id`（或 `r0`,`c0`,`r1`,`c1`）,`client_id`,`version` | 合并区域（需 editor 及以上） |
| `unmerge` | `row_id`,`col_id`（或 `row`,`col`）,`client_id`,`version` | 取消包含该格的合并区域 |
| `ping` | - | 心跳，服务端回 `pong` |

`version` 是**版本向量** `{clientId: seq}`：客户端把已见到的各客户端最大 `seq` 带上来，
服务端据此做 LWW 判定（详见第 5 节）。

### 下行（服务端 → 客户端）

| type | 字段 | 说明 |
|------|------|------|
| `welcome` | `role`,`rows`,`cols`,`rowIds`,`colIds`,`cells`,`formats`,`merges`,`seq`,`version`,`users` | 加入房间时的权威快照 |
| `welcome`（大表格） | 上述字段去掉 `rowIds`/`colIds`/`cells`/`formats`/`merges`，并带 `reload: true` | 单帧体积超限时退化为元数据，客户端改用 REST 拉取 |
| `cell_update` | `row_id`,`col_id`,`value`,`user`,`seq`,`version`,`cells`,`formats` | 广播权威投影（超大时仅 `reload: true`） |
| `cell_format` | 同上，带 `format` | |
| `row_insert`/`row_delete`/`col_insert`/`col_delete` | `at`,`element_id`,`rowIds`,`colIds`,`rows`,`cols`,`cells`,`formats`,`merges`,`seq` | 结构变化后附带权威投影 |
| `merge` / `unmerge` | `merges`,`rowIds`,`colIds`,`rows`,`cols`,`cells`,`formats`,`seq` | 合并区域变化后附带权威投影（`merges` 已解析为下标） |
| `sheet_import` | `rows`,`cols`,`rowIds`,`colIds`,`cells`,`formats`,`merges` | 整体替换通知 |
| `comment_added` / `comment_updated` | `comment`,`counts`,`mentions` | 评论新增或状态变更（`counts` 为权威角标计数） |
| `cursor` | `row`,`col`,`user` | |
| `presence` | `user`,`online`,`users` | 在线名单（`users` 为当前在线用户数组） |
| `error` | `code`(`forbidden`/`invalid`/`unauthorized`),`message` | 单条操作级错误，连接保持 |
| `pong` | `seq` | 心跳响应 |

**单帧体积上限**：`OE_MAX_WS_MESSAGE`（默认 900000 字符）。超过时服务端发送
`reload: true` 的瘦身消息，客户端通过 `GET /api/sheets/{id}` 拉取权威状态。

## 5. 协同语义（CRDT / LWW）

- **单元格值/格式是 LWW 寄存器**：`(value, version, seq, client_id)`。
  判定顺序：版本向量可比较时以支配关系取胜；真并发时用 `client_id` 字典序 + `seq` 确定性打破平局。
  由于服务端是唯一分配 `seq` 的地方，任何到达顺序下所有副本都收敛到同一结果。
- **行列是一等有序元素**：插删针对稳定 `element_id`，不再依赖索引，
  因此并发插入同一位置会同时保留，且不会出现坐标漂移（越界/过期坐标会被拒绝并提示）。
- **删除即移除**：删除行/列会连同其单元格一起删除，不存在"幽灵单元"；
  合并区域以元素 ID 锚定，区域内部插行/列自动扩展，端点被删除则区域失效。
- **离线兜底**：WebSocket 不可用时前端自动改走 REST，写操作语义完全一致。
- **视图（筛选/排序）不是数据变更**：条件筛选、按值多选筛选与多级排序都只作用于本端展示顺序
  （`Grid` 的 `rowOrder`），不改动单元格内容与存储顺序，因此无需协同合并；
  空值在排序时恒排末尾；清除视图即恢复原始行序。
- **选区与格式**：选区（单元格矩形 / 整行 / 整列 / 全选）是本端状态；套用格式时把选区展开成
  逐格 `cell_format` 操作走同一条协同链路，因此多端最终一致。数字格式只影响渲染函数
  （`lib/cellDisplay.ts`），公式与导出仍用原始值。
- **右键菜单与拖拽填充**（REQ-005/006）都在前端完成，最终同样落到 `cell_update` / `cell_format` /
  `row_insert` 等既有操作上，没有新增协议：
  - 右键菜单只是操作入口（插入/删除行列会走结构操作并进入版本链）；
  - 拖拽填充把目标区域展开成逐格写入，公式按**相对引用**偏移后作为普通值写入
    （与 Excel 一致，服务端不感知"填充"这一概念）。
- 仍未实现：完整 OT/CRDT 的结构重排合并（如"移动行"）、区域级冲突提示。

## 6. 版本与存储（diff 化）

- 每次写操作产生**一条操作日志 + 一个只含增量的版本**，不再保存整表 JSON 快照。
- `snapshot` 只在压缩点（自动/手动 `POST /snapshot`）写入，保留数量受 `OE_VERSION_SNAPSHOT_LIMIT`（默认 20）限制。
- 操作日志按 `OE_VERSION_OP_LIMIT`（默认 5000）截断最老记录（其效果已由快照覆盖）。
- 任意版本可重建：`最近快照 + 后续增量回放`；恢复历史版本是**追加**一条 `replace` 操作，历史不可改写。
- v1（全表快照）数据在启动时自动迁移为 `replace` 增量，历史版本仍可重建、对比与恢复。

## 7. 公式约定

`value` 以 `=` 开头视为公式，**仅在前端求值**，后端原样存储。支持：

- `=SUM(A1:B2)`、`=AVERAGE(A1:B2)`
- `=IF(A1>10,"高","低")`（支持 `>= <= <> > < =`）
- 引用：`A1`、`A1:B2`；含递归求值与循环引用检测（返回 `#ERROR`）

## 8. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `OE_DB_PATH` | `backend/data.db` | SQLite 路径 |
| `OE_JWT_SECRET` | 开发默认（会告警） | **生产必须设置** |
| `OE_ADMIN_USER` / `OE_ADMIN_PASSWORD` | `admin` / 随机 | 初始管理员 |
| `OE_DEV_AUTO_REGISTER` | `1` | 登录即注册（开发便利） |
| `OE_TOKEN_TTL` | `43200` | 令牌有效期（秒） |
| `OE_ALLOWED_ORIGINS` | localhost:5173/8080 | CORS 白名单 |
| `OE_MAX_ROWS` / `OE_MAX_COLS` / `OE_MAX_CELL_CHARS` | 100000 / 500 / 32767 | 输入校验上限 |
| `OE_MAX_XLSX_BYTES` | 10485760 | Excel 导入文件大小上限（字节） |
| `OE_MAX_COMMENT_CHARS` | 2000 | 单条评论长度上限 |
| `OE_MAX_WS_MESSAGE` | 900000 | 单帧 WebSocket 体积上限 |
| `OE_VERSION_SNAPSHOT_LIMIT` / `OE_VERSION_OP_LIMIT` | 20 / 5000 | 版本压缩参数 |
| `OE_LOGIN_MAX_ATTEMPTS` | 20 | 每 IP 每分钟登录尝试上限 |
| `OE_HSTS` | `0` | 置 `1` 时下发 HSTS 头 |
| `OE_MAX_PREFS_CHARS` | 16384 | 单用户个性化配置 JSON 体积上限 |
| `OE_DINGTALK_ENABLED` | `0` | 置 `1` 时启用钉钉机器人推送 |
| `OE_DINGTALK_WEBHOOK` | 空 | 自定义机器人 webhook 地址（含 access_token） |
| `OE_DINGTALK_SECRET` | 空 | 机器人「加签」密钥（配置后按钉钉规范签名） |
| `OE_DINGTALK_MOBILES` | `{}` | JSON：`{"用户名":"手机号"}`，用于把 @提及 映射为 `atMobiles` |
| `OE_DINGTALK_TIMEOUT` | 5 | 单次推送超时（秒），推送在后台线程执行 |
