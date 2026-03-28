# web-telegram-mirror (Phase B)

Minimal workspace plugin skeleton for the Web -> Telegram mainline mirror task.

## Scope in this phase

- Hooks used: `before_dispatch` + `agent_end`
- Only evaluates candidate mirror turns from Web/Control UI into main session
- Extracts Telegram target from session store (`deliveryContext`, fallback `lastRoute`)
- Includes dedupe cache (TTL + max entries)
- `observeOnly=true` logs decision/target/preview only
- No real Telegram send is executed in Phase B

## Placement

This plugin is placed at:

- `.openclaw/extensions/web-telegram-mirror/index.ts`

This matches OpenClaw workspace plugin discovery (`<workspace>/.openclaw/extensions/*/index.ts`).

## Config example

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

## Expected logs in observeOnly

On a matched Web turn:

- `source marked: ...` from `before_dispatch`
- `decision=mirror observeOnly=true ...` from `agent_end`

On filtered turns:

- `skip: reason=...`
- `skip: no-telegram-target`
- `skip: dedupe-hit`

## Not included yet

- Real call to `api.runtime.channel.telegram.sendMessageTelegram(...)`
- End-to-end send verification against Telegram
- Retry/metrics/reporting refinements
