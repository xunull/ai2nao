---
title: Kimi Code 编程套餐用量:接口口径与「总使用量」调研
category: 数据源与同步
order: 82
---
# Kimi Code 编程套餐用量:接口口径与「总使用量」调研

> 问题:像接 MiniMax 订阅用量一样,把 **Kimi Code(编程套餐 / Coding Plan)** 的窗口用量接进
> ai2nao 的「外部 AI 平台用量」页。
>
> 结论:**5 小时窗口 + 7 天窗口 + 会员档位** 能拿到,已接入(复用 [provider-usage-sync-design](provider-usage-sync-design.md)
> 的插件抽象,零迁移)。但 Kimi 会员页那条**月度「总使用量」拿不到** —— 它不在编程套餐 API 里,
> 归属账户/会员服务(`www.kimi.com` 的 Connect-RPC,走 web 会话认证),`sk-kimi` API key 打不到。
>
> 验证时间:2026-07-25(实拉某编程套餐账号)。状态:**5h/7天/档位 已落地;月度总使用量 暂不做**。

相关:[可插拔外部平台用量同步(MiniMax 第一个)](provider-usage-sync-design.md) ·
[MiniMax Token 记账](minimax-token-accounting.md) · [Kimi 对话源分析](kimi-conversation-source-analysis.md)

---

## 1. 两把 key 不互通(第一个坑)

Kimi 有两套 key,**互不通用**:

| key | 前缀 | 用途 | 本文用的 |
|---|---|---|---|
| Kimi Code 编程套餐 key | `sk-kimi-…` | 编程套餐配额、CLI | ✅ |
| Kimi 开放平台 key | `sk-…` | 对话/补全 API(platform.kimi.com) | ❌ |

拿开放平台 `sk-…` 打编程用量接口,会被 Kimi Code 后端回 `{"code":"unauthenticated", … REASON_INVALID_AUTH_TOKEN}`(gRPC 式,带 base64 detail)——**报错来自正确的后端,只是 token 类型不对**。`sk-kimi-…` 从 Kimi Code 控制台创建。

## 2. 接口

```
GET https://api.kimi.com/coding/v1/usages        # 404 时回退 /usage(单数)
Authorization: Bearer sk-kimi-xxx
User-Agent: KimiCLI/1.6                            # 必带,否则可能被拒
```

- 401/403 → key 不对(多半误用了开放平台 `sk-…`);**401 不回退单数端点**,直接报错。
- 端点无官方文档,系社区逆向(Kimi CLI 自身的用量调用)。

## 3. 响应形态(2026-07-25 实测,账号 id 已脱敏)

```jsonc
{
  "user": { "userId": "<redacted>", "region": "REGION_CN",
            "membership": { "level": "LEVEL_TRIAL" }, "businessId": "" },
  "usage":  { "limit": "100", "remaining": "100",
              "resetTime": "2026-07-27T08:00:56.444238Z" },   // ← 7 天(周)窗口
  "limits": [
    { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },  // 300 分 = 5 小时
      "detail": { "limit": "100", "remaining": "100",
                  "resetTime": "2026-07-25T08:00:56.444238Z" } }
  ],
  "parallel": { "limit": "10" },        // 最大并发
  "totalQuota": {},                     // ← 恒空(见 §6)
  "authentication": { "method": "METHOD_API_KEY", "scope": "FEATURE_CODING" },
  "subType": "TYPE_PURCHASE", "domain": "DOMAIN_NEXUS"
}
```

对表 Kimi 会员页「用量进度」的三条进度条:

| 会员页 | 重置时间 | API 字段 |
|---|---|---|
| **总使用量**(月度) | 月度(如 08-19) | **无** —— 不在本接口 |
| 5 小时用量 | 07-25 16:00 | `limits[0]`(`duration:300 TIME_UNIT_MINUTE`) |
| 7 天用量 | 07-27 16:00 | `usage` 块(`resetTime` 精确对上) |

> 关键:`usage.resetTime` 对上的是**「7 天用量」**,不是月度总额。社区工具也把 `usage` 标为 "Weekly"。
> 早期误标成「套餐总额」,已按会员页正名为「7 天用量」。

**解析要点**:数值是**字符串**(`"100"`,须 `Number()` 并防 NaN);给的是 `remaining` 不是 `used`,故 `剩余% = remaining/limit*100` 直接对上;`resetTime` 是带微秒的 ISO;窗口时长按 `window.timeUnit`(枚举前缀 `TIME_UNIT_MINUTE`/`_HOUR`/`_DAY`…)派生标签(300 分整除 60 → 「5 小时用量」)。

**档位字段的坑**:`membership.level` 实测为 `LEVEL_TRIAL`,**即便账户本身是付费会员** —— 该字段可能反映编程套餐维度(而非 Kimi 总会员等级),付费编程套餐的具体枚举名待核实。故 ai2nao 对未知枚举回退显示去掉 `LEVEL_` 前缀的原始值,不臆造。

## 4. 映射到 ai2nao 快照模型

`ProviderSnapshotItem = { key, label, remainingPercent, resetAt, detail }`:

| 来源 | key | label | remainingPercent |
|---|---|---|---|
| `usage` | `weekly` | 7 天用量 | `remaining/limit*100` |
| `limits[i]` | `5h`… | 5 小时用量… | 同上 |
| `user.membership`+`subType`+`parallel` | `membership` | 当前档位 | `null`(元信息,非配额) |

`membership` 项用 `detail.kind:"membership"` 标记,前端/卡片单独渲、不进配额表。`raw` 整个响应留存(前向兼容)。

## 5. ai2nao 展示什么

- **外部 AI 平台用量页**:Kimi 卡显示「档位 / 并发上限」+ 一张表(窗口 / 剩余 / 重置 / 已用一上限),列出 5 小时用量、7 天用量两行。
- **卡片 `kimi-quota`**(可入主页卡包):大数字 = 所有窗口里剩余% 最低的那个(当前最紧的约束),footer 带档位。

Kimi 编程套餐**没有逐笔账单**(不像 MiniMax `/account/amount`),故**不接 Token 趋势页**,只做余量快照 + 卡片。

## 6. 月度「总使用量」为什么没接

会员页那条月度「总使用量」(如 12.55%,月度重置)**不在编程套餐 API**:

- `totalQuota` 恒为 `{}`;`?aggregate=true` / `?scope=all` 也不返回它。
- `/coding/v1/{me,subscription,quota,plan,membership}` 全部 **404**。

真实来源(F12 确认会员页调用、且返回值里确有该数据):

```
POST https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription
Content-Type: application/json
body: {}
```

这是 **Connect-RPC unary**(路径 `Service/Method`;实测 GET → 405、`connect+json` → 415,只收 `POST` + `application/json`)。**认证是 `www.kimi.com` 的 web 会话 token,不是 `sk-kimi` 编程 key**:拿 `sk-kimi` 打它 → `401 {"code":"unauthenticated"}`。即编程 API 与会员账户 API 是**两套认证域**。

### 为什么不接进 ai2nao

web 会话 token 是**短命的**(浏览器登录态,几分钟/几小时过期、自动续),而 ai2nao 只有长期的 `sk-kimi` API key —— **拿不到、也续不了**这个会话 token。可选方案都不理想:

| 方案 | 问题 | 采用 |
|---|---|---|
| A. 不做,只显 5h + 7天 + 档位 | 编程套餐最相关的都在了 | ✅ 当前 |
| B. 手动粘 web token | 过期即失效,得反复粘 | ✗ |
| C. 读 kimi-desktop 本地会话文件续 token(`~/Library/Application Support/kimi-desktop/…`) | 格式私有、随版本变、要复刻其刷新逻辑,脆 | ✗ |

## 7. 决策与后续

- **已落地**:5 小时用量、7 天用量、会员档位、并发上限。
- **暂不做**:月度总使用量(需 web 会话方案,不值)。
- 若未来非要:得引入一套 Kimi web 会话认证(拿到并自动续 `www.kimi.com` 的 token),再调 `GetSubscription`。属独立、较脆的新链路,单独评估。
