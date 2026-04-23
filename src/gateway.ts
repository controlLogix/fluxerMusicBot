import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { BotConfig } from './config.js';
import type { FluxerAPI, Message } from './api.js';

/**
 * Gateway opcodes (Discord-like).
 * Fluxer's gateway protocol is intentionally similar to Discord's.
 */
export const GatewayOpcodes = {
  /** Server dispatches an event */
  DISPATCH: 0,
  /** Client sends a heartbeat */
  HEARTBEAT: 1,
  /** Client sends identify payload */
  IDENTIFY: 2,
  /** Client updates presence */
  PRESENCE_UPDATE: 3,
  /** Client joins/leaves/moves voice channels */
  VOICE_STATE_UPDATE: 4,
  /** Client resumes a session */
  RESUME: 6,
  /** Server requests client to reconnect */
  RECONNECT: 7,
  /** Server sends hello (heartbeat interval) */
  HELLO: 10,
  /** Server acknowledges heartbeat */
  HEARTBEAT_ACK: 11,
} as const;

/** Gateway event names */
export const GatewayEvents = {
  READY: 'READY',
  MESSAGE_CREATE: 'MESSAGE_CREATE',
  VOICE_STATE_UPDATE: 'VOICE_STATE_UPDATE',
  VOICE_SERVER_UPDATE: 'VOICE_SERVER_UPDATE',
  GUILD_CREATE: 'GUILD_CREATE',
  GUILD_DELETE: 'GUILD_DELETE',
  GUILD_MEMBER_ADD: 'GUILD_MEMBER_ADD',
  GUILD_MEMBER_REMOVE: 'GUILD_MEMBER_REMOVE',
  INTERACTION_CREATE: 'INTERACTION_CREATE',
} as const;

export interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number;
  t?: string;
}

export interface ReadyEvent {
  user: {
    id: string;
    username: string;
    bot: boolean;
  };
  guilds: Array<{ id: string; unavailable?: boolean }>;
  session_id: string;
}

export interface VoiceStateUpdateEvent {
  guild_id: string;
  channel_id: string | null;
  user_id: string;
  session_id: string;
  self_mute: boolean;
  self_deaf: boolean;
}

export interface VoiceServerUpdateEvent {
  guild_id: string;
  token: string;
  endpoint: string;
  /** LiveKit-specific: the room name */
  room?: string;
  /** LiveKit-specific: the LiveKit URL */
  livekit_url?: string;
}

/**
 * Fluxer Gateway WebSocket client.
 * Implements the Discord-like gateway protocol that Fluxer uses.
 */
export class FluxerGateway extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: BotConfig;
  private api: FluxerAPI;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private botUserId: string | null = null;
  private reconnecting = false;
  private gatewayUrl: string | null = null;

  constructor(config: BotConfig, api: FluxerAPI) {
    super();
    this.config = config;
    this.api = api;
  }

  get userId(): string | null {
    return this.botUserId;
  }

  /** Connect to the Fluxer gateway */
  async connect(): Promise<void> {
    try {
      // Try to get gateway URL from the API
      const gateway = this.api.getGateway();
      this.gatewayUrl = gateway?.url ?? this.buildGatewayUrl();
    } catch {
      this.gatewayUrl = this.buildGatewayUrl();
    }

    console.log(`[Gateway] Connecting to ${this.gatewayUrl}`);
    this.createConnection();
  }

  /** Disconnect from the gateway */
  disconnect(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'Bot shutting down');
      this.ws = null;
    }
  }

  /**
   * Send a voice state update to join/leave a voice channel.
   * This tells the gateway we want to connect to voice.
   */
  sendVoiceStateUpdate(guildId: string, channelId: string | null, selfMute = false, selfDeaf = false): void {
    this.send({
      op: GatewayOpcodes.VOICE_STATE_UPDATE,
      d: {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: selfMute,
        self_deaf: selfDeaf,
      },
    });
  }

  // ── Private Methods ──────────────────────────────────

  private buildGatewayUrl(): string {
    // For official Fluxer: gateway is at wss://gateway.fluxer.app
    // For self-hosted: derive from base URL
    const base = this.config.baseUrl;
    if (base.includes('fluxer.app')) {
      return 'wss://gateway.fluxer.app';
    }
    return `${base.replace(/^http/, 'ws')}/gateway`;
  }

  private createConnection(): void {
    if (!this.gatewayUrl) return;

    const url = `${this.gatewayUrl}?v=1&encoding=json`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[Gateway] WebSocket connected');
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const payload: GatewayPayload = JSON.parse(data.toString());
        this.handlePayload(payload);
      } catch (err) {
        console.error('[Gateway] Failed to parse message:', err);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(`[Gateway] WebSocket closed: ${code} ${reason.toString()}`);
      this.stopHeartbeat();

      // Auto-reconnect on non-fatal close codes
      if (code !== 1000 && code !== 4004 && !this.reconnecting) {
        this.reconnecting = true;
        console.log('[Gateway] Reconnecting in 5 seconds...');
        setTimeout(() => {
          this.reconnecting = false;
          this.createConnection();
        }, 5000);
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error('[Gateway] WebSocket error:', err.message);
    });
  }

  private handlePayload(payload: GatewayPayload): void {
    // Track sequence number for heartbeats and resume
    if (payload.s !== undefined && payload.s !== null) {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case GatewayOpcodes.HELLO:
        this.handleHello(payload.d as { heartbeat_interval: number });
        break;

      case GatewayOpcodes.DISPATCH:
        this.handleDispatch(payload.t!, payload.d);
        break;

      case GatewayOpcodes.HEARTBEAT:
        this.sendHeartbeat();
        break;

      case GatewayOpcodes.HEARTBEAT_ACK:
        // Heartbeat acknowledged
        break;

      case GatewayOpcodes.RECONNECT:
        console.log('[Gateway] Server requested reconnect');
        this.ws?.close(4000, 'Reconnecting');
        break;

      case 9: // INVALID_SESSION
        console.log('[Gateway] Invalid session, re-identifying...');
        this.sessionId = null;
        this.sequence = null;
        // Wait a bit then re-identify
        setTimeout(() => this.sendIdentify(), 2000);
        break;

      default:
        console.log(`[Gateway] Unknown opcode: ${payload.op}`);
    }
  }

  private handleHello(data: { heartbeat_interval: number }): void {
    console.log(`[Gateway] Hello received, heartbeat interval: ${data.heartbeat_interval}ms`);

    // Start heartbeating
    this.startHeartbeat(data.heartbeat_interval);

    // Send identify
    if (this.sessionId) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  private handleDispatch(eventName: string, data: unknown): void {
    switch (eventName) {
      case GatewayEvents.READY: {
        const ready = data as ReadyEvent;
        this.sessionId = ready.session_id;
        this.botUserId = ready.user.id;
        console.log(`[Gateway] Ready! Logged in as ${ready.user.username} (${ready.user.id})`);
        console.log(`[Gateway] Connected to ${ready.guilds.length} guild(s)`);
        this.emit('ready', ready);
        break;
      }

      case GatewayEvents.MESSAGE_CREATE: {
        const message = data as Message;
        this.emit('messageCreate', message);
        break;
      }

      case GatewayEvents.VOICE_STATE_UPDATE: {
        const voiceState = data as VoiceStateUpdateEvent;
        this.emit('voiceStateUpdate', voiceState);
        break;
      }

      case GatewayEvents.VOICE_SERVER_UPDATE: {
        const voiceServer = data as VoiceServerUpdateEvent;
        this.emit('voiceServerUpdate', voiceServer);
        break;
      }

      case GatewayEvents.GUILD_CREATE: {
        this.emit('guildCreate', data);
        break;
      }

      case GatewayEvents.GUILD_MEMBER_ADD: {
        this.emit('guildMemberAdd', data);
        break;
      }

      case GatewayEvents.GUILD_MEMBER_REMOVE: {
        this.emit('guildMemberRemove', data);
        break;
      }

      case GatewayEvents.INTERACTION_CREATE: {
        this.emit('interactionCreate', data);
        break;
      }

      default:
        // Forward all other events
        this.emit('raw', eventName, data);
    }
  }

  private sendIdentify(): void {
    console.log('[Gateway] Sending identify...');
    this.send({
      op: GatewayOpcodes.IDENTIFY,
      d: {
        token: this.config.token,
        properties: {
          os: process.platform,
          browser: 'fluxer-music-bot',
          device: 'fluxer-music-bot',
        },
        intents: 0xFFFF, // Request all intents
      },
    });
  }

  private sendResume(): void {
    console.log('[Gateway] Sending resume...');
    this.send({
      op: GatewayOpcodes.RESUME,
      d: {
        token: this.config.token,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private sendHeartbeat(): void {
    this.send({
      op: GatewayOpcodes.HEARTBEAT,
      d: this.sequence,
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();

    // Send first heartbeat after a jitter
    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatInterval = setInterval(() => {
        this.sendHeartbeat();
      }, intervalMs);
    }, jitter);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private send(payload: GatewayPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}