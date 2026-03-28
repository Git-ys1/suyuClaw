# web-telegram-mirror 阶段 B 简述

## 已实现（阶段 B）
- 已建立插件骨架：`README.md`、`openclaw.plugin.json`、`index.ts`。
- 已接入事件链路：`before_dispatch` + `agent_end`。
- 已实现来源判定：识别 Web/Control UI 输入（`senderIds`）并做短期来源标记（`sourceTtlMs`）。
- 已实现主会话约束：仅在 `mainSessionKey`（默认 `agent:main:main`）下评估镜像。
- 已实现目标解析：从会话存储优先读取 `deliveryContext`，回退 `lastRoute`（Telegram）。
- 已实现过滤与去重：空文本、`HEARTBEAT_OK`、system-like 文本过滤；TTL+容量去重缓存。
- 已实现 `observeOnly` 观察模式：只记录镜像决策日志、目标信息与预览，不实际发送 Telegram。

## 未实现（仍留到阶段 C）
- 未调用真实发送接口：`api.runtime.channel.telegram.sendMessageTelegram(...)`。
- 未做实发后的重试、失败分类、指标统计与上报。
- 未完成端到端实发验收（Telegram 到达性与回归验证）。

## 如何启用 observeOnly 骨架
在 OpenClaw 插件配置中启用条目（示例）：

```json5
{
  plugins: {
    entries: {
      "web-telegram-mirror": {
        enabled: true,
        config: {
          enabled: true,
          mainSessionKey: "agent:main:main",
          observeOnly: true,
          senderIds: ["openclaw-control-ui", "webchat-ui", "webchat"]
        }
      }
    }
  }
}
```

启用后预期日志：
- 命中来源：`source marked: ...`
- 触发镜像判定：`decision=mirror observeOnly=true ...`
- 被过滤/跳过：`skip: reason=...` / `skip: no-telegram-target` / `skip: dedupe-hit`

## 进入阶段 C 的最小步骤
1. 在 `index.ts` 中将 `observeOnly=false` 分支替换为真实 `sendMessageTelegram` 调用。
2. 保持现有过滤与去重逻辑不变，先做最小可用实发（成功/失败日志完整）。
3. 用单一测试会话做端到端验证：Web 输入 -> 主会话输出 -> Telegram 收到消息。
4. 补一轮失败路径验证（无目标、网络错误、重复消息）并记录结果。
