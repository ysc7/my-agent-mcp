# Muse 连接验证计划

**尚未验证，也不是一键接入说明。** 当前服务只接受每个 Agent 独立的 Bearer 令牌，不提供 OAuth 授权服务器、授权发现或令牌刷新。Meta 的个人 Muse 自定义连接器能否安全地提供这种认证，必须在目标账号实际验证；不要将个人 Muse 与 Muse Code 的能力混为一谈。未经验证不要对外宣称兼容 Muse。

## 验证前提

1. 先由用户明确决定是否部署。服务需要云端 Muse 可访问的 HTTPS 地址；不要把本机 `localhost` 当成 Muse 的地址。
2. 首先使用无敏感数据的测试环境，完成 TLS、身份、权限、网络与限流评估。Worker 和 D1 的应用数据在 Cloudflare，不是端到端加密。当前为同一信任域共享空间。
3. 为每个 Agent 单独创建强随机令牌；管理员凭据绝不交给 Agent。用户需要在平台支持的安全凭据界面输入；不在聊天、命令历史、代码、URL 或日志中粘贴密钥。
4. 先确认 Muse 当前版本的自定义连接器是否能通过安全凭据存储发送 Authorization Bearer 请求头，以及支持的 Streamable HTTP MCP 版本。如果只支持 OAuth 或不能安全传输令牌，停止接入，不要以公开无鉴权接口或将令牌放入 URL 的方式绕过。

## 验证步骤

1. 用户在自己的 Muse 中打开连接器设置，核对服务地址和可见权限；按平台提示授权。不要发送账号密码、验证码、授权码或 Cookie。
2. 完成连接后，让 Muse 列出工具；仅看到连接器名称不能证明成功。再读取一条不含敏感信息的测试消息，记录成功或具体错误。
3. 在明确同意前不要安排周期任务。若用户同意，按平台允许的最低必要频率检查任务；人工验证一次执行及重启后的凭据可用性。不要声称消息可实时唤醒 Muse，除非有实测证据。
4. 撤销或轮换被泄露的 Agent 令牌；修改 Cloudflare Secret 时需保留其他员工配置。可用 D1 记录检查身份，不输出凭据。高风险操作必须在各 Agent 平台单独设置审批。

## 后续 OAuth 方案

如 Muse 仅支持 OAuth，应使用经过审查的 OAuth 2.1 实现和真实身份验证、用户授权同意、PKCE、权限限定及撤销。Cloudflare 的示例认证页可能只是演示，不能把固定用户的自动授权代码直接部署公网。参见 [Cloudflare OAuth 文档](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/) 和 [Meta 自定义连接器帮助](https://www.meta.com/help/artificial-intelligence/1687253048996149/)；这两份资料并不证明本项目与 Muse 已兼容。
