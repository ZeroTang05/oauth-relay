# oauth-relay

Deno Deploy 反代，把 OAuth HTTP 流量从**无法直连 OAuth provider 的机房**中转出来。

通用、provider 无关。上游白名单 + 路径白名单 + 共享密钥鉴权,**无状态、不存储凭据**。

典型场景:
- 部署在国内机房,但要支持 Google / Linux.do / GitHub 等海外 OAuth provider
- 任何需要"按白名单代理特定 OAuth endpoint"的项目

## 为什么需要它

- 调用方(api 容器 / 后端服务)部署在国内机房,出口对 OAuth provider 不可达
  (`node fetch` 在容器内全部 `ETIMEDOUT`)。
- 把 OAuth token + userinfo 流量走 Deno Deploy 边缘节点,调用方只需调一个
  国内可访问的 HTTPS endpoint 即可。
- 反代**不存储**任何 OAuth 凭据——`client_id` / `client_secret` 始终在调用方
  容器里,只作为请求 body / Authorization header 透传。

## 安全模型

1. **无状态** — 反代不持久化任何请求数据、header、body 或 cookie。每次调用
   都是单向透传。
2. **路径白名单** — 只接受固定的路由表,任何其他路径返回 404,**没有 catch-all**,
   不可能被滥用为通用代理。
3. **共享密钥** — 每个请求必须带 `X-Relay-Token: <RELAY_SHARED_SECRET>`,
   否则返回 401。密钥使用常数时间比较,避免 timing side-channel。
4. **CORS** — 默认关闭。启用时只允许 `CORS_ALLOWED_ORIGINS` 列出的 origin。
5. **Header 白名单** — 转发到上游的 header 仅限 `Authorization / Content-Type /
   Accept / Accept-Language / User-Agent`,`Host / Cookie / Referer` 不透传。
6. **超时** — 默认 10 s 单次上游调用上限,超时返回 502。

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

测试调用:

```bash
TOKEN=replace-with-32-byte-random-secret
curl -i http://localhost:8000/healthz

# 调 Google token endpoint(带个假 code 看是否真的能透传到 Google)
curl -i -X POST http://localhost:8000/oauth/google/token \
  -H "X-Relay-Token: $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=fake&client_id=fake&client_secret=fake&grant_type=authorization_code&redirect_uri=urn:fake"
# 期望: 400 + invalid_grant(上游真实返回,证明网络通了)
```

## 部署到 Deno Deploy

1. 在 https://dash.deno.com 新建项目。
2. **Entry point** 填 `main.ts`,不需要 build step(Deno Deploy 直接跑 .ts)。
3. 在项目 Settings → Environment Variables 添加:
   - `RELAY_SHARED_SECRET` — 32+ 字节随机字符串
   - `CORS_ALLOWED_ORIGINS` — 调用方 origin,逗号分隔(可留空)
   - `UPSTREAM_TIMEOUT_MS` — `10000`
   - `LOG_LEVEL` — `info`
4. 部署后你会得到 `https://<project-name>.<org>.deno.net`。
5. 用 `curl /healthz` 探活。
6. (可选)绑定自定义域名 — 在 Settings → Domains 添加。

## 调用方对接

部署完成后,把反代域名写到调用方配置:

```bash
# 反代域名(Deno Deploy 给的 *.deno.net,或绑了自定义域名)
OAUTH_RELAY_BASE_URL=https://oauth-relay.example.com

# 与 oauth-relay/.env 的 RELAY_SHARED_SECRET 完全一致
OAUTH_RELAY_TOKEN=replace-with-32-byte-random-secret
```

切换调用方 OAuth endpoint:

```ts
// 原
const token = await exchangeToken("https://oauth2.googleapis.com/token", ...);
// 新
const token = await exchangeToken(`${env.oauthRelayBaseUrl}/oauth/google/token`, ...);
```

`client_id` / `client_secret` 仍在调用方容器里,反代只是透传,安全模型不变。

## 上线清单

- [ ] 生成 32+ 字节随机密钥,写入反代 `.env` 和调用方 env
- [ ] 部署到 Deno Deploy,得到稳定 endpoint
- [ ] `curl https://<relay>/healthz` 返回 200
- [ ] `curl -X POST https://<relay>/oauth/google/token -H "X-Relay-Token: ..." -d "code=fake&..."` 返回 400 / invalid_grant(证明网络可达)
- [ ] 修改调用方 OAuth 代码,把对应 URL 切到反代
- [ ] 调用方增加 `OAUTH_RELAY_BASE_URL` / `OAUTH_RELAY_TOKEN` env 解析
- [ ] 重新部署调用方
- [ ] 重新走 OAuth 绑定流程,日志不再出现 connection / unavailable 类错误
