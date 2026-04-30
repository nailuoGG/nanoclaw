import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannelAdapter runs at import time)
vi.mock('../channel-registry.js', () => ({
  registerChannelAdapter: vi.fn(),
}));

// Mock env reader
vi.mock('../../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock logger
vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config
vi.mock('../../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// --- dingtalk-stream mock ---

type CallbackHandler = (res: any) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('dingtalk-stream', () => ({
  DWClient: class MockDWClient {
    clientId: string;
    clientSecret: string;
    debug: boolean;
    callbackHandler: CallbackHandler | null = null;

    constructor(config: any) {
      this.clientId = config.clientId;
      this.clientSecret = config.clientSecret;
      this.debug = config.debug;
      clientRef.current = this;
    }

    registerCallbackListener(_topic: string, handler: CallbackHandler) {
      this.callbackHandler = handler;
    }

    async connect() {}

    socketCallBackResponse(_messageId: string, _response: any) {}
  },
  TOPIC_ROBOT: 'robot',
}));

vi.mock('axios', () => ({
  default: {
    post: vi.fn().mockResolvedValue({
      data: { accessToken: 'test-token', expireIn: 7200 },
    }),
  },
}));

vi.mock('axios-retry', () => ({
  default: vi.fn(),
}));

import './index.js';
import { registerChannelAdapter } from '../channel-registry.js';
import axios from 'axios';

// Cache the factory at import time (before any clearAllMocks)
const registrationCalls = vi.mocked(registerChannelAdapter).mock.calls;
const dtRegistration = registrationCalls.find((c) => c[0] === 'dingtalk');
if (!dtRegistration) throw new Error('DingTalk not registered at import time');
const cachedFactory = dtRegistration[1].factory;

function getFactory() {
  return cachedFactory;
}

// Resolve factory result (may be sync or async)
async function createFromFactory() {
  const factory = getFactory();
  const result = factory();
  return await Promise.resolve(result);
}

// --- Test helpers ---

function createSetup() {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
}

function createInboundMessage(overrides: {
  conversationId?: string;
  conversationType?: string;
  conversationTitle?: string;
  msgtype?: string;
  text?: string;
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId?: string;
  createAt?: number;
  msgId?: string;
  sessionWebhook?: string;
  content?: any;
}) {
  const defaults = {
    conversationId: 'cid12345',
    conversationType: '2',
    conversationTitle: 'Test Group',
    msgtype: 'text',
    senderId: 'user123',
    senderStaffId: 'staff123',
    senderNick: 'Alice',
    chatbotUserId: 'bot456',
    createAt: 1704067200000,
    msgId: 'msg789',
    sessionWebhook: 'https://webhook.example.com/session',
  };

  return {
    ...defaults,
    ...overrides,
    text: overrides.text ? { content: overrides.text } : undefined,
  };
}

async function triggerCallback(
  message: ReturnType<typeof createInboundMessage>,
) {
  const client = clientRef.current;
  if (client?.callbackHandler) {
    await client.callbackHandler({
      headers: { messageId: 'ack123' },
      data: JSON.stringify(message),
    });
  }
}

// --- Tests ---

describe('DingTalk Channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set env vars so factory returns an adapter
    process.env.DINGTALK_CLIENT_ID = 'test-client';
    process.env.DINGTALK_CLIENT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.DINGTALK_CLIENT_ID;
    delete process.env.DINGTALK_CLIENT_SECRET;
    delete process.env.DINGTALK_ENABLED;
    delete process.env.DINGTALK_ADMIN_IDS;
    vi.restoreAllMocks();
  });

  // --- Registration ---

  describe('registration', () => {
    it('registers with registerChannelAdapter', () => {
      // Factory was cached at import time — verify it exists and works
      expect(cachedFactory).toBeInstanceOf(Function);
    });

    it('factory returns null when credentials missing', () => {
      delete process.env.DINGTALK_CLIENT_ID;
      delete process.env.DINGTALK_CLIENT_SECRET;
      const factory = getFactory();
      expect(factory()).toBeNull();
    });

    it('factory returns null when disabled', () => {
      process.env.DINGTALK_ENABLED = 'false';
      const factory = getFactory();
      expect(factory()).toBeNull();
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connects via setup()', async () => {
      const adapter = (await createFromFactory())!;
      const config = createSetup();

      await adapter.setup(config);

      expect(adapter.isConnected()).toBe(true);
      expect(adapter.name).toBe('dingtalk');
      expect(adapter.channelType).toBe('dingtalk');
      expect(adapter.supportsThreads).toBe(false);
    });

    it('disconnects via teardown()', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();

      await adapter.setup(config);
      expect(adapter.isConnected()).toBe(true);

      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('isConnected() returns false before setup', async () => {
      const adapter = (await createFromFactory())!;
      expect(adapter.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers text message via onInbound', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();
      await adapter.setup(config);

      const message = createInboundMessage({ text: 'Hello everyone' });
      await triggerCallback(message);

      expect(config.onMetadata).toHaveBeenCalledWith(
        'cid12345',
        'Test Group',
        true,
      );

      expect(config.onInbound).toHaveBeenCalledWith(
        'cid12345',
        null,
        expect.objectContaining({
          id: 'msg789',
          kind: 'chat',
          content: {
            text: 'Hello everyone',
            sender: 'staff123',
            sender_name: 'Alice',
          },
          isGroup: true,
          isMention: true,
        }),
      );
    });

    it('filters bot own messages', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();
      await adapter.setup(config);

      const message = createInboundMessage({
        senderStaffId: 'bot456',
        chatbotUserId: 'bot456',
        text: 'I should not trigger',
      });
      await triggerCallback(message);

      expect(config.onInbound).not.toHaveBeenCalled();
    });

    it('extracts text from richText messages', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();
      await adapter.setup(config);

      const message = createInboundMessage({
        msgtype: 'richText',
        content: {
          richText: [
            { type: 'text', text: 'Hello ' },
            { type: 'at', atName: 'Alice' },
            { type: 'text', text: '!' },
          ],
        },
      });
      await triggerCallback(message);

      expect(config.onInbound).toHaveBeenCalledWith(
        'cid12345',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: 'Hello @Alice!' }),
        }),
      );
    });

    it('handles picture messages', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();
      await adapter.setup(config);

      const message = createInboundMessage({ msgtype: 'picture' });
      await triggerCallback(message);

      expect(config.onInbound).toHaveBeenCalledWith(
        'cid12345',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: '[图片]' }),
        }),
      );
    });

    it('handles audio messages with recognition', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();
      await adapter.setup(config);

      const message = createInboundMessage({
        msgtype: 'audio',
        content: { recognition: 'Hello world' },
      });
      await triggerCallback(message);

      expect(config.onInbound).toHaveBeenCalledWith(
        'cid12345',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: 'Hello world' }),
        }),
      );
    });

    it('detects private chats (conversationType = 1)', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();
      await adapter.setup(config);

      const message = createInboundMessage({
        conversationType: '1',
        text: 'Private message',
      });
      await triggerCallback(message);

      expect(config.onMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        false,
      );

      expect(config.onInbound).toHaveBeenCalledWith(
        expect.any(String),
        null,
        expect.objectContaining({ isGroup: false }),
      );
    });

    it('falls back to senderId when senderNick missing', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();
      await adapter.setup(config);

      const message = createInboundMessage({
        senderNick: undefined,
        senderStaffId: 'staff999',
        text: 'Hi',
      });
      await triggerCallback(message);

      expect(config.onInbound).toHaveBeenCalledWith(
        'cid12345',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ sender_name: 'staff999' }),
        }),
      );
    });
  });

  // --- Outbound delivery ---

  describe('outbound delivery', () => {
    it('sends message via session webhook when available', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();
      await adapter.setup(config);

      // Cache webhook by receiving a message first
      const message = createInboundMessage({
        sessionWebhook: 'https://webhook.example.com/session',
        text: 'Initial',
      });
      await triggerCallback(message);

      // Deliver outbound
      await adapter.deliver('cid12345', null, {
        kind: 'chat',
        content: { text: 'Reply message' },
      });

      expect(axios.post).toHaveBeenCalledWith(
        'https://webhook.example.com/session',
        expect.objectContaining({
          msgtype: 'markdown',
          markdown: expect.objectContaining({
            text: 'Reply message',
          }),
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-acs-dingtalk-access-token': 'test-token',
          }),
        }),
      );
    });

    it('sends proactive message when no webhook available', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;
      const config = createSetup();
      await adapter.setup(config);

      await adapter.deliver('cid12345', null, {
        kind: 'chat',
        content: { text: 'Proactive message' },
      });

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
        expect.objectContaining({
          robotCode: 'test-client',
          msgKey: 'sampleMarkdown',
          openConversationId: 'cid12345',
        }),
        expect.any(Object),
      );
    });

    it('no-ops when not connected', async () => {
      const factory = getFactory();
      const adapter = (await createFromFactory())!;

      await adapter.deliver('cid12345', null, {
        kind: 'chat',
        content: { text: 'No client' },
      });

      expect(axios.post).not.toHaveBeenCalledWith(
        expect.stringContaining('webhook'),
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
