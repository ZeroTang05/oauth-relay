# oauth-relay

Deno Deploy 反代，把 `https://oauth2.googleapis.com/*` 和
`https://connect.linux.do/*` 的 OAuth HTTP 流量从国内机房中转出来。

仅供 GoWith 自身使用,不通用。

## 为什么需要它

- GoWith api 容器部署在国内机房,出口网络对 `*.googleapis.com` 和
  `connect.linux.do` 不可达(测试: `node fetch` 全部 `ETIMEDOUT`)。
- GitHub `api.github.com` 正常,只有 Google 和 linux.do 受影响。
- 把这两路流量走 Deno Deploy 的边缘节点,GoWith api 只需调一个国内可访问
  的 HTTPS endpoint 即可。
- 反代**不存储**任何 OAuth 凭据——`client_id` / `client_secret` 始终在
  GoWith api 容器里,只作为请求 body / Authorization header 透传。

## 安全模型

1. **无状态** — 反代不持久化任何请求数据、header、body 或 cookie。每次调用
   都是单向透传。
2. **路径白名单** — 只接受固定的 4 条路由,任何其他路径返回 404,**没有 catch-all**,
   不可能被滥用为通用代理。
3. **共享密钥** — 每个请求必须带 `X-Relay-Token: <RELAY_SHARED_SECRET>`,
   否则返回 401。密钥使用常数时间比较,避免 timing side-channel。
4. **CORS** — 默认关闭。启用时只允许 `CORS_ALLOWED_ORIGINS` 列出的 origin。
5. **Header 白名单** — 转发到上游的 header 仅限 `Authorization / Content-Type /
   Accept / Accept-Language / User-Agent`,`Host / Cookie / Referer` 不透传。
6. **超时** — 默认 10 s 单次上游调用上限,超时返回 502,GoWith api 端会被记为
   `oauth_provider_unavailable`。

## 路由表

| Method | Path                        | 上游 URL                                                       |
|--------|-----------------------------|----------------------------------------------------------------|
| POST   | `/oauth/google/token`       | `https://oauth2.googleapis.com/token`                          |
| GET    | `/oauth/google/userinfo`    | `https://openidconnect.googleapis.com/v1/userinfo`             |
| POST   | `/oauth/linuxdo/token`      | `https://connect.linux.do/oauth2/token`                        |
| GET    | `/oauth/linuxdo/userinfo`   | `https://connect.linux.do/api/user`                            |
| GET    | `/healthz`                  | (本机响应,不连上游)                                            |

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
   - `CORS_ALLOWED_ORIGINS` — `https://gowith.xiaobaozi.cn`
   - `UPSTREAM_TIMEOUT_MS` — `10000`
   - `LOG_LEVEL` — `info`
4. 部署后你会得到 `https://<project-name>.<org>.deno.net`。
5. 用 `curl /healthz` 探活。

## GoWith 端对接

部署完成后,把反代域名写到 `.env.production`:

```bash
# 反代域名(Deno Deploy 给的 *.deno.net,或绑了自定义域名)
OAUTH_RELAY_BASE_URL=https://oauth-relay.<org>.deno.net

# 与 oauth-relay/.env 的 RELAY_SHARED_SECRET 完全一致
OAUTH_RELAY_TOKEN=replace-with-32-byte-random-secret
```

切换 api 端 OAuth endpoint(详见 `apps/api/src/services/oauth-providers.ts`):

```ts
// 原
const token = await exchangeToken("https://oauth2.googleapis.com/token", ...);
// 新
const token = await exchangeToken(`${env.oauthRelayBaseUrl}/oauth/google/token`, ...);
```

`client_id` / `client_secret` 仍在 GoWith api 容器里,反代只是透传,安全模型不变。

## 上线清单

- [ ] 生成 32+ 字节随机密钥,写入反代 `.env` 和 GoWith `.env.production`
- [ ] 部署到 Deno Deploy,得到稳定 endpoint
- [ ] `curl https://<relay>/healthz` 返回 200
- [ ] `curl -X POST https://<relay>/oauth/google/token -H "X-Relay-Token: ..." -d "code=fake&..."` 返回 400 / invalid_grant(证明网络可达)
- [ ] 修改 GoWith `apps/api/src/services/oauth-providers.ts` 4 个 URL
- [ ] 增加 `OAUTH_RELAY_BASE_URL` / `OAUTH_RELAY_TOKEN` env 解析
- [ ] `pnpm docker:prod:build && docker compose ... up -d` 重新部署 api
- [ ] 后台重新走 Google / linux.do 绑定流程,日志不再出现 `oauth_provider_unavailable`
