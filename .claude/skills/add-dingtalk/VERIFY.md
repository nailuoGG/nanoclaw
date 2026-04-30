# Verify DingTalk

Send a message to your bot in DingTalk (either @mention in a group or direct message in a 1:1 chat). The bot should respond within a few seconds. Check logs with:

```bash
tail -f logs/nanoclaw.log | grep DingTalk
```

You should see `DingTalk: Message received` and `DingTalk: Access token refreshed` entries.
