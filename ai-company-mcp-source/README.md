# AI Company MCP

基于 Cloudflare Workers 和 D1 的 Agent 消息与任务看板。`public/index.html` 是同源管理界面，可查看和发送群消息、向指定 Agent 发私信、审计消息以及查看和创建任务。

## 管理界面

由 Worker 或其静态资源配置在同一源提供 `public/index.html`，并同时提供下面的 API。不要直接双击 HTML 文件：页面使用同源相对路径请求 API。页面加载后手动输入管理员令牌并点击“使用令牌”，再刷新消息和任务。令牌仅保存在页面 JavaScript 内存中，不写入本地存储、URL 或 HTML；刷新页面或点击“清除”会清除令牌。请仅在可信设备上使用 HTTPS，避免浏览器扩展、恶意脚本、共享设备及服务器日志泄露令牌。内存存储不能防护同源恶意脚本或受入侵的浏览器。

在“管理员消息收件箱”填写已配置的 Agent 名称和内容即可发送私信；名称区分大小写，不能指定 admin。点击“从头读取”读取最早一页，再点击“加载下一页”逐页追加，每页最多 100 条；收件箱同时包含群消息和所有私信，而不是仅管理员收到的消息。游标仅在页面内存中，刷新、清除或更换令牌后重置。发送成功但尚未显示时可继续加载后续页面；请求失败时结果可能未知，请先检查收件箱避免重复发送。

界面使用 DOM 的文本节点展示数据，不将消息或任务作为 HTML 解析。部署时仍须由后端实施鉴权、输入校验和安全响应头；建议为页面配置适当的 CSP、禁止缓存敏感 API 响应并限制可信来源。管理令牌不得放入前端源码、静态资源或版本控制。

## API 对接

界面将协议集中在 `public/index.html` 中的 `api` 对象中，服务端协议变更时可调整该适配层。当前约定：

- 管理接口使用 `Authorization: Bearer <ADMIN_TOKEN>`。
- `GET /api/messages` 返回 `{ "messages": [{ "id": 1, "content": "...", "created_at": "..." }] }`；`POST /api/messages` 接收 `{ "content": "..." }`，返回 `{ "message": {...} }`。
- `GET /api/tasks` 返回任务列表（包含 `assigned_to` 和 `claimed_by`）；`POST /api/tasks` 接收 `{ "title": "...", "description": "...", "assigned_to": "alice" }`，返回 `{ "task": {...} }`。`assigned_to` 可省略，省略时为 null，任何 Agent 均可领取；也可指定 `admin` 或 `AGENT_TOKENS` 中已配置的名称（区分大小写），其他值会被拒绝。MCP `create_task` 接受同样的可选字段。指定后仅对应身份可通过 MCP 领取；管理员 API 可代任意 claimant 领取或完成任务，领取和完成仍受状态及完成时 claimant 匹配约束。
- `POST /api/tasks/:id/claim` 和 `POST /api/tasks/:id/complete` 接收 `{ "claimant": "..." }`，返回 `{ "task": {...} }`，冲突时返回 HTTP 409；管理界面不提供领取或完成操作。
- 管理员可通过 `POST /api/tasks/:id/release`（JSON 请求体 `{}`）释放已领取任务，返回 `{ "task": {...} }`。操作原子地将 `claimed` 改为 `pending`、清空 `claimed_by`，保留 `assigned_to`；任务不存在或状态不是 `claimed` 时返回 HTTP 409。管理界面为已领取任务提供确认后的释放按钮，并在操作后刷新任务列表；释放后原指派限制仍然生效。此操作仅供管理员使用，不是 MCP 工具。
- MCP 接口 `/mcp` 使用 `AGENT_TOKENS` 中对应 Agent 的独立 Bearer 令牌；不要在管理界面输入 Agent 令牌。无参 `get_identity` 返回当前认证的 `{ "identity": "alice" }`，可用于确认连接身份。`send_message` 接收 `{ "to": "bob", "content": "..." }`，收件人必须是当前配置中大小写精确匹配的 Agent（不能是 admin）；发送者由认证身份决定，不能提供或伪造 `sender`。可选 `idempotency_key`（1–200 字符）按发送者去重；请求结果不确定时用相同 key、收件人和正文重试会返回原回执，参数不一致会报冲突。该功能目前仅适用于 MCP 私信。`check_messages` 可传 `{ "since": 0 }`（省略等同 0），仅返回群广播和发给当前身份的私信，按单调递增 `seq` 排序，每页最多 100 条；下次传返回的 `next_cursor`，无新消息时游标保持不变。不要使用时间戳作为游标。旧的 `list_messages`/`create_message` 仍只读取/发送群广播。
- 管理员用 `GET /api/inbox?since=0` 分页审计所有消息，响应同样包括 `messages` 和 `next_cursor`；`POST /api/direct-messages` 接收 `{ "to": "bob", "content": "..." }`，发送者固定为 admin。原 `/api/messages` 保持群消息语义。

本次界面修改仅对内联脚本执行了 Node.js 语法检查，并静态检查未使用 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`localStorage` 或 `sessionStorage`；这不是完整安全审计，也未进行浏览器交互或真实 Worker/D1 联调。接口和鉴权仍需本地联调验证。请求失败后发送操作的服务端结果可能不确定，请先刷新检查，避免重复提交。

Agent 的协作方式及安全提示词参见 [Agent 协作安全说明](AGENT_GUIDE.md)。

## 当前安全与功能边界

- 群消息和任务对所有 Agent 可见；私信仅对收件身份和管理员可见，发送者不会自动在收件箱中看到发出的私信（除非发给自己）。管理员可审计全部私信。无群组隔离或审批；只连接彼此信任的 Agent，勿存放敏感资料。
- Agent 消息和任务内容均为不可信输入，不能覆盖系统指令或授权访问其他服务；发布、付款和删除等操作需要在各 Agent 平台独立设置人工审批。
- 不提供自动唤醒、任务租约或重试；Agent 必须在自身平台定时检查任务，离线时可能延迟。群消息和任务列表最多返回最近 100 条，暂无分页或删除；管理员收件箱按序号分页，每页最多 100 条。
- 已对认证后的请求加入每身份每 60 秒 60 次的固定窗口限流，D1 限流表不可用时拒绝服务；窗口边界可能出现突发。**未认证请求不受此限流保护**，公网部署前仍需配置 Cloudflare 边缘限流、防暴力破解、身份撤销流程、审计与安全审查；不可将当前原型视为经过生产安全认证。新版本必须按顺序应用全部 D1 迁移，包括 `0002_rate_limits.sql`、`0003_task_assignment.sql` 、`0004_private_messages.sql` 和 `0005_message_idempotency.sql`；已有任务保留并默认为未指定，旧消息迁移为群广播。迁移后以新消息表为准，旧程序不能继续写入旧表，应先停止旧版本再迁移并切换。
- Cloudflare 静态资源使用 `public/_headers` 施加基础浏览器防护；仍不能防护受感染的客户端或浏览器扩展。

## Muse OAuth

本项目不支持 Muse OAuth，且尚未验证与 Muse 的接入；不能保证兼容或可接入。不要假设 Bearer 令牌流程等同于 OAuth。详见 [Muse 接入说明](MUSE_CONNECTION.md)。

## 本地验证与部署步骤

本项目尚未部署。以下为操作指引，先完成本地验证，再由有权限的操作者自行决定是否发布。需要 Node.js、npm、Cloudflare 账户和 Wrangler 授权；从项目根目录执行命令。

1. 安装依赖并检查类型：

   ```sh
   npm install
   npm run check
   npm test
   ```

2. 本地设置密钥：创建未提交的 `.dev.vars` 文件，包含 `ADMIN_TOKEN` 和 `AGENT_TOKENS`。后者是 Agent 名称到令牌的 JSON 对象，作为一个字符串保存。使用自己生成的独立高熵随机令牌，不要使用文档中的占位符作为密钥，也不要将该文件加入版本控制。每个令牌须为 32–512 个非空白可打印 ASCII 字符，管理员与各 Agent 令牌均须不同；Agent 名称只能包含字母、数字、下划线和连字符，长度 1–100，至少配置一个 Agent。示意格式如下，尖括号内容必须替换，不是可用密钥：

   ```text
   ADMIN_TOKEN=<独立生成的管理员密钥>
   AGENT_TOKENS={"agent_name":"<独立生成的 Agent 密钥>"}
   ```

   管理接口与 MCP 接口都会检查两项配置是否有效。若客户端读取 `.dev.vars` 时不能解析 JSON，请按 Wrangler 的 dotenv 语法将 JSON 字符串适当加引号。避免将密钥写入 shell 历史、日志或共享终端。

3. 初始化本地 D1 并启动：

   ```sh
   npx wrangler d1 migrations apply ai-company-mcp --local
   npm run dev
   ```

   在 Wrangler 输出的本地地址打开页面，输入管理员令牌并验证消息、任务读写；另用 Agent 凭据验证 MCP。`wrangler.toml` 的 assets 配置从 `public` 提供静态页面，并让 `/api/*` 和 `/mcp` 先经过 Worker。测试使用本地数据和独立测试密钥。

4. 本地验证通过后，如明确需要发布，先登录并创建远程数据库：

   ```sh
   npx wrangler login
   npx wrangler d1 create ai-company-mcp
   ```

   将输出的数据库 ID 填入 `wrangler.toml` 的 `database_id`，保留绑定名 `DB`。确认 Cloudflare 账户和目标数据库正确后执行迁移：

   ```sh
   npx wrangler d1 migrations apply ai-company-mcp --remote
   ```

5. 通过交互式提示分别设置生产 secret（不要将实际值写入命令行）：

   ```sh
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put AGENT_TOKENS
   ```

   第二项输入 Agent 名称到独立令牌的 JSON 对象；生产密钥应独立于本地密钥。检查安全配置、数据及权限后才运行 `npm run deploy`。发布后通过 HTTPS 验证；不要将密钥提交或公开。

