# web-telegram-mirror

Workspace plugin for Web -> Telegram mainline mirroring.

## Current behavior

- Hooks used: `before_dispatch` + `agent_end`
- Only evaluates candidate mirror turns from Web/Control UI into main session
- Extracts Telegram target from session store (`deliveryContext`, fallback `lastRoute`)
- Includes dedupe cache (TTL + max entries)
- Default behavior is now **live send** (`observeOnly=false`)
- Set `observeOnly=true` to switch back to dry-run logging only

## Placement

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
          observeOnly: false,
          senderIds: ["openclaw-control-ui", "webchat-ui", "webchat"]
        }
      }
    }
  }
}
```

## Expected logs

On a matched Web turn:

- `source marked: ...` from `before_dispatch`
- `decision=mirror observeOnly=false ...` from `agent_end`
- `sent: ...` after Telegram delivery succeeds

On filtered turns:

- `skip: reason=...`
- `skip: no-telegram-target`
- `skip: dedupe-hit`

## Notes

- This mirrors assistant replies from Web/Control UI to Telegram.
- It does **not** mirror Telegram replies back into Telegram, so it should not self-echo on normal use.
- If needed, `observeOnly=true` remains available for troubleshooting.
