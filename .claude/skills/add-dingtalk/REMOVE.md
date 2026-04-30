# Remove DingTalk

1. Comment out `import './dingtalk/index.js'` in `src/channels/index.ts`
2. Remove `DINGTALK_*` entries from `.env`
3. `pnpm uninstall dingtalk-stream async-mutex`
4. Rebuild and restart
