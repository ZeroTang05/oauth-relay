# oauth-relay

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Made with Deno](https://img.shields.io/badge/Made%20with-Deno-70ffaf.svg)](https://deno.com)

A stateless OAuth endpoint relay for Deno Deploy — tunnel Google / GitHub / Linux.do
OAuth HTTP calls out from networks that cannot reach those providers directly.

Deno Deploy 反代，把 OAuth HTTP 流量从**无法直连 OAuth provider 的网络环境**中转出来。

通用、provider 无关。上游白名单 + 路径白名单 + 共享密钥鉴权，**无状态、不存储凭据**。

典型场景:

- 后端服务部署在访问不了 Google / GitHub 等站点的网络里（例如国内机房），
  但仍要支持这些 provider 的 OAuth 登录
- 任何需要"按白名单代理特定 OAuth endpoint"的项目

## 一键部署

<a href="https://console.deno.com/new?clone=https://github.com/Warma10032/oauth-relay">
  <img src="https://deno.com/button" alt="Deploy on Deno" />
</a>

按钮会把本仓库克隆到你自己的 GitHub 账号下，并在 Deno Deploy 创建项目，全程不用敲命令：

1. Entry point 保持 `main.ts`（Deno Deploy 直接运行 .ts，无需 build step）。
2. 部署完成后，进入项目 **Settings → Environment Variables** 添加环境变量：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `RELAY_SHARED_SECRET` | ✅ | 共享密钥，建议 32 字节以上随机字符串（`openssl rand -hex 32` 生成） |
   | `CORS_ALLOWED_ORIGINS` | | 允许跨域的来源，逗号分隔；留空 = 关闭 CORS（此时仅适合后端服务器调用，浏览器页面无法直调） |
   | `UPSTREAM_TIMEOUT_MS` | | 单次上游调用超时毫秒数，默认 `10000` |
   | `LOG_LEVEL` | | `debug` / `info` / `warn` / `error`，默认 `info` |

   每条路由的上游地址也可以用环境变量覆盖（如 `GOOGLE_TOKEN_UPSTREAM`），见 `.env.example`。
3. 改完环境变量后重新部署一次使其生效。
4. 探活：`curl https://<你的域名>/healthz` 返回 `ok` 即部署成功。
5. （可选）在 **Settings → Domains** 绑定自定义域名。

## 验证部署

用假参数测一遍 token 透传，确认"反代 → 谷歌"整条链路可达：

```bash
TOKEN=replace-with-your-relay-shared-secret

# 探活
curl -i https://<你的域名>/healthz

# 用假 code 请求谷歌 token endpoint
curl -i -X POST https://<你的域名>/oauth/google/token \
  -H "X-Relay-Token: $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=fake&client_id=fake&client_secret=fake&grant_type=authorization_code&redirect_uri=urn:fake"
```

期望返回 **400 + 谷歌返回的 JSON 错误**（`invalid_grant` / `invalid_request` 都正常）。
错误 JSON 是谷歌亲手写的——这证明请求确实穿透反代到达了谷歌，链路是通的。

## 为什么需要它

- 调用方（你的后端服务）所在网络对 OAuth provider 不可达，`fetch` 直接 `ETIMEDOUT`。
- 把 OAuth token + userinfo 流量走 Deno Deploy 边缘节点中转，调用方只需调一个
  自己网络可达的 HTTPS endpoint。
- 反代**不存储**任何 OAuth 凭据——`client_id` / `client_secret` 始终在调用方
  自己的服务里，只作为请求 body / Authorization header 透传。

## 安全模型

1. **无状态** — 反代不持久化任何请求数据、header、body 或 cookie。每次调用
   都是单向透传。
2. **路径白名单** — 只接受固定的路由表，任何其他路径返回 404，**没有 catch-all**,
   不可能被滥用为通用代理。
3. **共享密钥** — 每个请求必须带 `X-Relay-Token: <RELAY_SHARED_SECRET>`，
   否则返回 401。密钥使用常数时间比较，避免 timing side-channel。
4. **CORS** — 默认关闭。启用时只允许 `CORS_ALLOWED_ORIGINS` 列出的 origin。
5. **Header 白名单** — 转发到上游的 header 仅限 `Authorization / Content-Type /
   Accept / Accept-Language / User-Agent`,`Host / Cookie / Referer` 不透传。
6. **超时** — 默认 10 s 单次上游调用上限，超时返回 502。

## 路由表(内置 provider)

| Method | Path                        | 上游 URL                                                       |
|--------|-----------------------------|----------------------------------------------------------------|
| POST   | `/oauth/github/token`       | `https://github.com/login/oauth/access_token`                  |
| GET    | `/oauth/github/userinfo`    | `https://api.github.com/user`                                  |
| POST   | `/oauth/google/token`       | `https://oauth2.googleapis.com/token`                          |
| GET    | `/oauth/google/userinfo`    | `https://openidconnect.googleapis.com/v1/userinfo`             |
| POST   | `/oauth/linuxdo/token`      | `https://connect.linux.do/oauth2/token`                        |
| GET    | `/oauth/linuxdo/userinfo`   | `https://connect.linux.do/api/user`                            |
| GET    | `/healthz`                  | (本机响应,不连上游)                                            |

## 添加新 provider

OAuth 协议由 2 步组成:
- **token endpoint** — POST,交换 authorization code → access_token
- **userinfo endpoint** — GET,用 Bearer token 拿用户资料

只要这两个 endpoint 是 HTTPS + 接受 POST/GET + 返回 JSON,反代就能转发。

**3 步加 provider**(例如添加 `wechat-official`):

1. **在 `main.ts` 的 `UPSTREAM_TABLE` 里追加两条**:

   ```typescript
   "wechat-official/token": {
     upstream: Deno.env.get("WECHAT_OFFICIAL_TOKEN_UPSTREAM")
       ?? "https://api.weixin.qq.com/sns/oauth2/access_token",
     method: "POST",
   },
   "wechat-official/userinfo": {
     upstream: Deno.env.get("WECHAT_OFFICIAL_USERINFO_UPSTREAM")
       ?? "https://api.weixin.qq.com/sns/userinfo",
     method: "GET",
   },
   ```

2. **更新顶部注释** — 在"Routes"块里加新行,客户端会查这份文档。

3. **重新部署** — Deno Deploy 会重新部署新版本。

`parseRelayKey` 要求路径正好是 `/oauth/<provider>/<stage>` 两段,所以 provider
名可以是字母/数字/中划线/下划线(段内任意非空、非 `..`),但不能含 `/`。

可扩展示例:**GitLab / Microsoft / Apple / 飞书 / 钉钉 / 微信开放平台 / 企业微信**。
只要它们的 token + userinfo 是标准 HTTPS endpoint,直接按上述 3 步加。

## 本地开发

```bash
# 安装 Deno 1.45+
curl -fsSL https://deno.land/install.sh | sh

# 准备 env
cp .env.example .env
# 编辑 .env 填入 RELAY_SHARED_SECRET(可用 `openssl rand -hex 32`)

# 启动(默认 :8000)
deno task dev
```

## 调用方对接

部署完成后,把反代域名和密钥写进调用方(你的后端服务)配置:

```bash
# 反代域名(Deno Deploy 分配的域名,或你绑定的自定义域名)
OAUTH_RELAY_BASE_URL=https://your-relay.example.com

# 与反代环境的 RELAY_SHARED_SECRET 完全一致
OAUTH_RELAY_TOKEN=replace-with-32-byte-random-secret
```

切换调用方 OAuth endpoint:

```ts
// 原
const token = await exchangeToken("https://oauth2.googleapis.com/token", ...);
// 新
const token = await exchangeToken(`${env.oauthRelayBaseUrl}/oauth/google/token`, ...);
```

`client_id` / `client_secret` 仍在调用方自己的服务里,反代只是透传,安全模型不变。

## 上线清单

- [ ] 生成 32+ 字节随机密钥,写入反代环境变量和调用方 env
- [ ] `curl https://<relay>/healthz` 返回 200
- [ ] `curl -X POST https://<relay>/oauth/google/token -H "X-Relay-Token: ..." -d "code=fake&..."` 返回 400 + 谷歌 JSON 错误(证明链路可达)
- [ ] 修改调用方 OAuth 代码,把对应 URL 切到反代
- [ ] 调用方增加 `OAUTH_RELAY_BASE_URL` / `OAUTH_RELAY_TOKEN` env 解析
- [ ] 重新走 OAuth 绑定流程,日志出现 `INFO relay ok`

## License

[MIT](LICENSE)
