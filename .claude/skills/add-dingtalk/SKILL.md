---
name: add-dingtalk
description: Add DingTalk enterprise bot channel integration via Stream SDK.
---

# Add DingTalk Channel

Adds DingTalk enterprise bot support via the Stream SDK (long-lived WebSocket connection, no webhook required).

## Prerequisites

- A DingTalk enterprise (组织) with admin access
- A custom robot created in the DingTalk Developer Console
- Node.js >= 20 (already required by NanoClaw)

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the DingTalk adapter from its bundled source into the standard paths.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/dingtalk/index.ts` and `src/channels/dingtalk/index.test.ts` exist
- `src/channels/index.ts` contains `import './dingtalk/index.js';`
- `dingtalk-stream`, `axios`, `axios-retry`, `async-mutex` are listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Copy the adapter and tests

```bash
mkdir -p src/channels/dingtalk
cp .claude/skills/add-dingtalk/src/index.ts      src/channels/dingtalk/index.ts
cp .claude/skills/add-dingtalk/src/index.test.ts  src/channels/dingtalk/index.test.ts
```

### 2. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './dingtalk/index.js';
```

### 3. Install dependencies

```bash
pnpm install dingtalk-stream axios axios-retry async-mutex
```

### 4. Build

```bash
pnpm run build
```

## Credentials

### Create DingTalk Enterprise Robot

1. Log in to the [DingTalk Developer Console](https://open-dev.dingtalk.com/)
2. Go to **Application Development** → **Robot** → **Create Robot**
3. Select your organization
4. Set the robot name (e.g., "NanoClaw Assistant")
5. In the robot configuration, note down:
   - **AppKey** (also called `Client ID`)
   - **AppSecret** (also called `Client Secret`)
6. Under **Message Reception**, select **Stream Mode** (this uses WebSocket, no webhook URL needed)
7. Enable the robot for the target groups/chats

### Configure environment

Add to `.env`:

```bash
DINGTALK_ENABLED=true
DINGTALK_CLIENT_ID=your-app-key
DINGTALK_CLIENT_SECRET=your-app-secret
```

Optional — restrict auto-registration to specific admin users:

```bash
DINGTALK_ADMIN_IDS=staffId1,staffId2
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## How It Works

- **Stream mode**: The adapter maintains a persistent WebSocket connection to DingTalk's Stream API. No public webhook URL or inbound port needed.
- **Message routing**: DingTalk enterprise bots only receive messages when explicitly @mentioned in groups, or all messages in 1:1 chats.
- **Reply delivery**: Uses session webhooks for replies when available, falls back to proactive API for unsolicited messages.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, restart the service and send a message to the bot in DingTalk:

```bash
systemctl --user restart nanoclaw   # Linux
# or
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

Then run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `dingtalk`
- **terminology**: DingTalk has "groups" (群, conversationType=2) and "single chats" (单聊, conversationType=1). Each group or DM is a separate messaging group.
- **how-to-find-id**: DingTalk uses `conversationId` (prefixed with `cid`) as the platform ID. The adapter auto-strips any `dt:` prefix for API calls. To find a group's ID, check logs after sending a message: `DingTalk: Message received { platformId: 'cidXXXXX' }`.
- **supports-threads**: no (DingTalk has no reply threads)
- **typical-use**: Enterprise bot — long-lived Stream connection, receives @mentions in groups and all messages in DMs.
- **default-isolation**: `shared` session mode per messaging group.
