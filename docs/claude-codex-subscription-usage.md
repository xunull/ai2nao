---
title: Claude / Codex 订阅额度:本机凭据读窗口用量
category: 数据源与同步
order: 83
---
# Claude / Codex 订阅额度:本机凭据读窗口用量

> 问题:MiniMax、Kimi Code 的套餐窗口用量早就接进来了,但两个主力 —— **Claude 订阅**与
> **Codex 订阅** —— 的额度一直是黑的,早先判断是「拿不到」。
>
> 结论:**拿得到**。两家都有本机可读的入口,复用
> [provider-usage-sync-design](provider-usage-sync-design.md) 的插件抽象,**零迁移**,
> 只给 `ProviderUsageSource` 加了一个 `requiresApiKey` 开关。
>
> 验证时间:2026-07-26(两个端点实拉,均 200)。状态:**5 小时 / 7 天窗口 + 档位 已落地**。

相关:[可插拔外部平台用量同步](provider-usage-sync-design.md) ·
[Kimi Code 编程套餐用量](kimi-coding-plan-usage.md) · [用量成本口径](cost-billing.md)

参考实现:[stablyai/orca](https://github.com/stablyai/orca) 的 `src/main/rate-limits/`。

---

## 1. 和「Token 用量」是两回事

| | 这篇讲的 | 已有的 |
|---|---|---|
| 口径 | 订阅**额度窗口还剩多少 %**、几点重置 | 从本地会话记录数出来的 **token 条数/估算成本** |
| 来源 | 平台官方用量端点 | `src/claudeTokenUsage/`、`src/codexTokenUsage/` 解析本地 JSONL |
| 回答 | 「这 5 小时还能用多久」 | 「这个月烧了多少等价 API 成本」 |

两者互不替代,页面上也分属不同区域。

## 2. Claude:Claude Code 自己的 OAuth 用量端点

```
GET https://api.anthropic.com/api/oauth/usage
  Authorization: Bearer <accessToken>
  anthropic-beta: oauth-2025-04-20
  User-Agent:    claude-code/2.1.0
```

**凭据取自本机**(三级回退,`src/providers/localCredentials.ts`):

1. macOS Keychain,service `Claude Code-credentials`
   —— Claude Code 2.1+ 会按 `sha256(CLAUDE_CONFIG_DIR)` 前 8 位十六进制加后缀,先试带后缀的再试无后缀的
2. `<configDir>/.credentials.json`(默认 `~/.claude/`)
3. 都没有 → 报「未检测到 Claude Code 登录凭据」

JSON 里取 `claudeAiOauth.accessToken`。

> **`ANTHROPIC_API_KEY` 在这个端点上不管用**(401)。它要的是订阅的 OAuth token,不是 API key。
>
> **不要自己判过期**:凭据本地的 `expiresAt` 不权威,看着过期的 token 在这个端点上照样能认证。
> 交给服务端返回码。

响应(2026-07-26 实测,已脱敏):

```json
{ "five_hour": { "utilization": 52.0, "resets_at": "2026-07-26T06:30:00.069698+00:00" },
  "seven_day": { "utilization":  3.0, "resets_at": "2026-08-02T03:00:00.069723+00:00" },
  "limits": [ { "kind": "session",       "percent": 52, "is_active": true  },
              { "kind": "weekly_all",    "percent":  3, "is_active": false },
              { "kind": "weekly_scoped", "percent":  0,
                "scope": { "model": { "display_name": "Fable" } } } ],
  "extra_usage": {...}, "spend": {...}, "member_dashboard_available": false,
  "seven_day_opus": null, "tangelo": null, "iguana_necktie": null, "nimbus_quill": null }
```

**解析要点**:`utilization` 是**已用 %**;`resets_at` 是带微秒的 ISO;`weekly_scoped` 里的
按模型限额(当前是 Fable)没有顶层字段,只能从 `limits[]` 捞,且 `is_active` 表示的是
「当前是否是最紧的那条约束」而**不是数据是否有效**,不能拿它过滤。那堆 `tangelo` /
`iguana_necktie` / `nimbus_quill` / `cinder_cove` 是内部代号,实测全 null,不解析。

## 3. Codex:Codex Desktop 走的 ChatGPT 后端

```
GET https://chatgpt.com/backend-api/wham/usage
  Authorization:      Bearer <tokens.access_token>
  User-Agent:         codex-cli
  OpenAI-Beta:        codex-1
  originator:         Codex Desktop
  ChatGPT-Account-Id: <tokens.account_id>     # 有才带
```

凭据取自 `$CODEX_HOME/auth.json`(默认 `~/.codex/auth.json`)。

> 性质提示:这是 **ChatGPT 的产品后端**,不是公开 API,比 Anthropic 那个 first-party OAuth
> 端点灰度高、更易变形。故解析全程防御式,原始响应保留。

响应(2026-07-26 实测,PII 已略):

```json
{ "user_id": "…", "account_id": "…", "email": "…",
  "plan_type": "plus",
  "rate_limit": { "allowed": true, "limit_reached": false,
    "primary_window":   { "used_percent": 0, "limit_window_seconds": 604800,
                          "reset_after_seconds": 604800, "reset_at": 1785645160 },
    "secondary_window": null },
  "credits": {...}, "spend_control": {...} }
```

## 4. 三个「照抄会写错」的坑

这三条是实测才暴露的,光读参考实现容易顺过去。

**① Codex 响应带 PII。** 顶层有 `user_id` / `account_id` / `email`,而
`ProviderSnapshot.raw` 是**原样入库**的。不脱敏 = 把邮箱写进 SQLite,debug 时贴一段 raw
到 issue 就泄了。`redactPii()` 在入库前深度擦掉这些 key,有专项测试守着。

**② `primary_window` 不等于 5 小时。** 实测账号上 `limit_window_seconds = 604800`(7 天),
且 `secondary_window` 是 **null**。窗口时长一律按 `limit_window_seconds` 推导,
**不按字段位置推**;`null` 窗口**不出行**(空条会被读成「只剩 0%」)。

**③ 方向是反的。** Claude 的 `utilization`、Codex 的 `used_percent` 都是**已用 %**,
而 `ProviderSnapshotItem.remainingPercent` 存的是**剩余 %**。Kimi 的接口原生给 `remaining`,
那套映射直接搬过来必然把进度条画反。所有换算走同一个
`remainingFromUsedPercent()`,只此一处。

## 5. 契约改动:`requiresApiKey`

原先 `syncProvider` 硬卡「没 key 就判失败」,而这两个源**零配置**(读本机登录态),会永远卡死。

```ts
export type ProviderUsageSource = {
  /** 省略视为 true。false = 读本机凭据,管理页不显示 key 输入框,同步也不因缺 key 判失败。 */
  requiresApiKey?: boolean;
  sync(config: ProviderSyncConfig): Promise<ProviderSnapshot>;
};
export type ProviderSyncConfig = { apiKey: string | null };
```

MiniMax / Kimi 不声明该字段,行为逐字不变(有回归测试守着)。**零新表、零迁移。**

## 6. 明确不做

- **不刷新、不写回 token。** 参考实现会在 token 快过期时刷新**并写回 Keychain**。
  ai2nao 不做 —— 覆盖 Claude Code / Codex 自己的凭据,风险和收益不对等。
  401 就提示去对应 CLI 重新登录,那两个工具用起来自己会刷。
- **不做 PTY 兜底**(起终端跑 CLI 抓 `/usage` 文本)。形态重、易碎。没凭据就老实报未登录。
- **不碰 `extra_usage` / `spend` / `credits`。** 那是充值额度,和「订阅窗口还剩多少」是两码事,
  混进同一张表会被读成配额。

## 7. 落地效果

| 项 | Claude | Codex |
|---|---|---|
| 5 小时用量 | ✅ | 该账号未返回该窗口 |
| 7 天用量 | ✅ | ✅ |
| 按模型限额 | ✅(`7 天用量 · Fable`) | — |
| 档位 | —(接口无此字段) | ✅(`plan_type`,如 `plus`) |

- **外部 AI 平台用量页**:两张新卡,不显示 key 输入框,标注「读取本机登录凭据」。
- 默认**关闭**,与其他 provider 一致,需在页面上手动启用。
