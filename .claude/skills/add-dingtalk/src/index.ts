/**
 * DingTalk Channel for NanoClaw
 *
 * Implements DingTalk enterprise bot integration using dingtalk-stream SDK.
 * Conforms to the v2 ChannelAdapter interface.
 */

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { Mutex } from 'async-mutex';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerChannelAdapter } from '../channel-registry.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  OutboundMessage,
} from '../adapter.js';

interface DingTalkInboundMessage {
  msgtype: string;
  text?: { content: string };
  content?: {
    richText?: Array<{ type: string; text?: string; atName?: string }>;
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
  };
  senderId: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId: string;
  conversationType: string;
  conversationId: string;
  conversationTitle?: string;
  createAt: number;
  msgId: string;
  sessionWebhook: string;
}

interface TokenInfo {
  accessToken: string;
  expireIn: number;
}

interface CallbackResponse {
  headers?: {
    messageId?: string;
  };
  data: string;
}

function createAdapter(): ChannelAdapter | null {
  const envVars = readEnvFile([
    'DINGTALK_ENABLED',
    'DINGTALK_CLIENT_ID',
    'DINGTALK_CLIENT_SECRET',
    'DINGTALK_ROBOT_CODE',
    'DINGTALK_ADMIN_IDS',
  ]);

  const enabled =
    process.env.DINGTALK_ENABLED ?? envVars.DINGTALK_ENABLED ?? 'true';
  if (enabled === 'false' || enabled === '0') {
    log.info('DingTalk: Channel disabled by DINGTALK_ENABLED flag');
    return null;
  }

  const clientId =
    process.env.DINGTALK_CLIENT_ID || envVars.DINGTALK_CLIENT_ID || '';
  const clientSecret =
    process.env.DINGTALK_CLIENT_SECRET ||
    envVars.DINGTALK_CLIENT_SECRET ||
    '';

  if (!clientId || !clientSecret) {
    log.warn(
      'DingTalk: DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET not set',
    );
    return null;
  }

  const adminIdsStr =
    process.env.DINGTALK_ADMIN_IDS || envVars.DINGTALK_ADMIN_IDS || '';
  // adminIds reserved for future auto-registration feature
  void adminIdsStr;

  // State
  let client: DWClient | null = null;
  let setup: ChannelSetup | null = null;

  // Token cache
  let accessToken: string | null = null;
  let accessTokenExpiry = 0;
  const tokenRefreshMutex = new Mutex();

  // Reply webhook cache (per conversation)
  const replyWebhooks = new Map<string, string>();

  const adapter: ChannelAdapter = {
    name: 'dingtalk',
    channelType: 'dingtalk',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setup = config;
      client = new DWClient({
        clientId,
        clientSecret,
        debug: false,
      });

      client.registerCallbackListener(
        TOPIC_ROBOT,
        async (res: CallbackResponse) => {
          const messageId = res.headers?.messageId;
          try {
            if (messageId) {
              client!.socketCallBackResponse(messageId, { success: true });
            }
            const data = JSON.parse(res.data) as DingTalkInboundMessage;
            await handleMessage(data);
          } catch (error: unknown) {
            log.error('DingTalk: Failed to handle message', {
              err: error,
              messageId,
            });
          }
        },
      );

      await client.connect();
      log.info('DingTalk: Stream client connected');
    },

    async teardown(): Promise<void> {
      client = null;
      setup = null;
      replyWebhooks.clear();
      log.info('DingTalk: Stream client disconnected');
    },

    isConnected(): boolean {
      return client !== null;
    },

    async deliver(
      platformId: string,
      _threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      const text = extractOutboundText(message);
      if (text === null) return undefined;
      await sendMessage(platformId, text);
      return undefined;
    },
  };

  // ============ Message handling ============

  async function handleMessage(
    data: DingTalkInboundMessage,
  ): Promise<void> {
    if (
      data.senderId === data.chatbotUserId ||
      data.senderStaffId === data.chatbotUserId
    ) {
      return;
    }

    const isGroup = data.conversationType !== '1';
    const senderId = data.senderStaffId || data.senderId;
    const text = extractText(data);
    const platformId = data.conversationId;

    // Store reply webhook
    replyWebhooks.set(platformId, data.sessionWebhook);

    log.info('DingTalk: Message received', {
      msgId: data.msgId,
      senderId,
      senderName: data.senderNick,
      platformId,
      chatName: data.conversationTitle,
      isGroup,
      msgType: data.msgtype,
      textPreview: text.slice(0, 100),
    });

    if (!text.trim() || !setup) return;

    // Notify host of conversation metadata
    setup.onMetadata(platformId, data.conversationTitle, isGroup);

    // Deliver inbound message to host
    await setup.onInbound(platformId, null, {
      id: data.msgId,
      kind: 'chat',
      content: {
        text,
        sender: senderId,
        sender_name: data.senderNick || senderId,
      },
      timestamp: new Date(data.createAt).toISOString(),
      isGroup,
      // DingTalk enterprise bots only receive messages when @mentioned
      isMention: true,
    });
  }

  function extractText(data: DingTalkInboundMessage): string {
    const msgtype = data.msgtype || 'text';

    if (msgtype === 'text') {
      return data.text?.content?.trim() || '';
    }

    if (msgtype === 'richText') {
      const parts = data.content?.richText || [];
      let text = '';
      for (const part of parts) {
        if (part.type === 'text' && part.text) text += part.text;
        if (part.type === 'at' && part.atName) text += `@${part.atName}`;
      }
      return text.trim();
    }

    if (msgtype === 'picture') {
      return '[图片]';
    }

    if (msgtype === 'audio') {
      return data.content?.recognition || '[语音]';
    }

    return `[${msgtype}消息]`;
  }

  // ============ Sending messages ============

  async function sendMessage(
    platformId: string,
    text: string,
  ): Promise<void> {
    if (!client) {
      log.warn('DingTalk: Client not initialized');
      return;
    }

    // Try session webhook first (reply mode)
    const webhook = replyWebhooks.get(platformId);
    if (webhook) {
      await sendBySession(webhook, text);
      return;
    }

    // Fall back to proactive API
    await sendProactive(platformId, text);
  }

  async function sendBySession(
    sessionWebhook: string,
    text: string,
  ): Promise<void> {
    const token = await getAccessToken();
    const title =
      text
        .split('\n')[0]
        .replace(/^[#*\s->]+/, '')
        .slice(0, 20) || '消息';

    await axios.post(
      sessionWebhook,
      {
        msgtype: 'markdown',
        markdown: { title, text },
      },
      {
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
      },
    );
  }

  async function sendProactive(
    conversationId: string,
    text: string,
  ): Promise<void> {
    const token = await getAccessToken();
    const title =
      text
        .split('\n')[0]
        .replace(/^[#*\s->]+/, '')
        .slice(0, 20) || '消息';

    await axios.post(
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      {
        robotCode: clientId,
        openConversationId: conversationId,
        msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title, text }),
      },
      {
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );
  }

  // ============ Token management ============

  async function getAccessToken(): Promise<string> {
    const now = Date.now();
    if (accessToken && accessTokenExpiry > now + 60000) {
      return accessToken;
    }

    return tokenRefreshMutex.runExclusive(async () => {
      const doubleCheckNow = Date.now();
      if (accessToken && accessTokenExpiry > doubleCheckNow + 60000) {
        return accessToken!;
      }

      const response = await axios.post<TokenInfo>(
        'https://api.dingtalk.com/v1.0/oauth2/accessToken',
        {
          appKey: clientId,
          appSecret: clientSecret,
        },
      );

      accessToken = response.data.accessToken;
      accessTokenExpiry = now + response.data.expireIn * 1000;
      log.info('DingTalk: Access token refreshed');

      return accessToken!;
    });
  }

  return adapter;
}

function extractOutboundText(message: OutboundMessage): string | null {
  const content = message.content as
    | Record<string, unknown>
    | string
    | undefined;
  if (typeof content === 'string') return content;
  if (
    content &&
    typeof content === 'object' &&
    typeof content.text === 'string'
  ) {
    return content.text;
  }
  return null;
}

// Configure axios retry
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    axiosRetry.isNetworkOrIdempotentRequestError(error) ||
    error.response?.status === 429,
  onRetry: (retryCount, error, requestConfig) => {
    log.warn('DingTalk: API retry', {
      retry: retryCount,
      url: requestConfig.url?.split('?')[0],
      error: error.message,
    });
  },
});

// Auto-register channel
registerChannelAdapter('dingtalk', { factory: createAdapter });
