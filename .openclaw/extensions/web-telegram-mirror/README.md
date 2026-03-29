# web-telegram-mirror

Workspace plugin for Web -> Telegram mainline mirroring.

## Current behavior

- Hooks used: `before_dispatch` + `agent_end`
- Only evaluates candidate mirror turns from Web/Control UI into main session
- Extracts Telegram target from session store (`deliveryContext`, fallback `lastRoute`)
- Includes dedupe cache (TTL + max entries)
- Default behavior is now **live send** (`observeOnly=false`)
- Set `observeOnly=true` to switch back to dry-run logging only
- Unified backend voice path:
  - Assistant reply generates a single backend OGG file (`edge-tts` + `ffmpeg`)
  - Telegram uses the same file as native voice bubble (`asVoice: true`)
  - Web can receive a same-file voice link (click to play in browser)

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
          senderIds: ["openclaw-control-ui", "webchat-ui", "webchat"],
          voice: {
            enabled: true,
            assistantVoiceOnly: true,
            webLink: {
              enabled: true,
              includeInMessage: true,
              // if browser and gateway are different machines, set this:
              // publicBaseUrl: "https://your-gateway-host:17864"
              publicBaseUrl: "",
              port: 17864
            }
          }
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
- `voice-web-server listening ...` when Web voice-link server starts
- `voice-sent: ...` after Telegram voice-note delivery

On filtered turns:

- `skip: reason=...`
- `skip: no-telegram-target`
- `skip: dedupe-hit`

## Notes

- This mirrors assistant replies from Web/Control UI to Telegram.
- It does **not** mirror Telegram replies back into Telegram, so it should not self-echo on normal use.
- If needed, `observeOnly=true` remains available for troubleshooting.
- Current Web limitation: Control UI chat renderer handles text and image blocks only, no native audio bubble/player.
- So workspace-level path currently uses clickable links for Web playback.

## Minimal Core Change (for Native Web Audio Bubble)

1. Control UI renderer (`ui/src/ui/chat/grouped-render.ts`):
   - add support for `audio` content block or `MediaPath/MediaUrl` audio fields
   - render `<audio controls preload="none">`
2. Optional upload support (`ui/src/ui/chat/attachment-support.ts`):
   - extend accepted mime from `image/*` to include audio

Workspace plugins can modify message payloads and hooks, but cannot replace Control UI rendering behavior.
