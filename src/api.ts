import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import nodePath from 'path';
import type { BotConfig } from './config.js';

/**
 * Fluxer HTTP API client.
 * Uses curl.exe for requests to bypass Cloudflare TLS fingerprinting
 * that blocks Node.js's native fetch.
 */
export class FluxerAPI {
  private baseUrl: string;
  private token: string;

  constructor(config: BotConfig) {
    const base = config.baseUrl;
    if (base.includes('fluxer.app')) {
      this.baseUrl = 'https://api.fluxer.app';
    } else {
      this.baseUrl = `${base}/api`;
    }
    this.token = config.token;
  }

  private curlRequest<T>(method: string, path: string, body?: unknown): T {
    const url = `${this.baseUrl}${path}`;
    let tempFile: string | null = null;

    if (body !== undefined) {
      const jsonBody = JSON.stringify(body);
      tempFile = nodePath.join(os.tmpdir(), `fluxer-bot-${Date.now()}.json`);
      fs.writeFileSync(tempFile, jsonBody, 'utf8');
    }

    const maxRetries = 5;
    let lastError = '';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const args: string[] = [
        '-s',
        '--connect-timeout', '5',
        '--max-time', '10',
        '--retry', '0',
        '-4',  // Force IPv4 (IPv6 is unreachable for this host)
        '-X', method,
        '-H', `Authorization: Bot ${this.token}`,
        '-H', 'Content-Type: application/json',
        '-H', 'User-Agent: FluxerMusicBot/1.0.0',
      ];

      if (tempFile) {
        args.push('-d', `@${tempFile}`);
      }

      args.push(url);

      try {
        const result = execFileSync('curl.exe', args, {
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        });

        // Clean up temp file on success
        if (tempFile) {
          try { fs.unlinkSync(tempFile); } catch {}
        }

        if (!result || result.trim() === '') {
          return undefined as T;
        }

        return JSON.parse(result.trim()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Unknown error';
        // Wait before retry (exponential backoff)
        if (attempt < maxRetries - 1) {
          const waitMs = (attempt + 1) * 1000;
          const waitUntil = Date.now() + waitMs;
          while (Date.now() < waitUntil) { /* busy wait for sync */ }
        }
      }
    }

    // Clean up temp file after all retries failed
    if (tempFile) {
      try { fs.unlinkSync(tempFile); } catch {}
    }

    throw new Error(`API request failed after ${maxRetries} retries: ${method} ${path} → ${lastError.substring(0, 200)}`);
  }

  // ── Gateway ──────────────────────────────────────────

  /** Get the gateway WebSocket URL */
  getGateway(): { url: string } {
    return this.curlRequest('GET', '/gateway');
  }

  /** Get the gateway URL for bots (includes shard info) */
  getGatewayBot(): { url: string; shards: number } {
    return this.curlRequest('GET', '/gateway/bot');
  }

  // ── Channels ─────────────────────────────────────────

  /** Send a message to a channel with optional embed and components */
  sendMessage(channelId: string, content: string, embed?: Embed, components?: any[]): Promise<Message> {
    const body: any = { content };
    if (embed) {
      body.embeds = [embed];
    }
    if (components) {
      body.components = components;
    }
    return Promise.resolve(
      this.curlRequest('POST', `/channels/${channelId}/messages`, body)
    );
  }

  /** Get a channel by ID */
  getChannel(channelId: string): Promise<Channel> {
    return Promise.resolve(
      this.curlRequest('GET', `/channels/${channelId}`)
    );
  }

  // ── Voice ────────────────────────────────────────────

  /**
   * Request a voice connection token for a channel.
   */
  getVoiceToken(guildId: string, channelId: string): Promise<VoiceTokenResponse> {
    return Promise.resolve(
      this.curlRequest('POST', `/guilds/${guildId}/voice/token`, {
        channel_id: channelId,
      })
    );
  }

  // ── Users ────────────────────────────────────────────

  /** Get the current bot user */
  getCurrentUser(): Promise<User> {
    return Promise.resolve(
      this.curlRequest('GET', '/users/@me')
    );
  }

  // ── Guilds ───────────────────────────────────────────

  /** Get guild channels */
  getGuildChannels(guildId: string): Promise<Channel[]> {
    return Promise.resolve(
      this.curlRequest('GET', `/guilds/${guildId}/channels`)
    );
  }
}

// ── Types ──────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  discriminator?: string;
  avatar?: string;
  bot?: boolean;
}

export interface Message {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: User;
  content: string;
  timestamp: string;
}

export interface Channel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  position?: number;
  parent_id?: string;
}

/** Channel types (Discord-like) */
export const ChannelType = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
} as const;

export interface VoiceTokenResponse {
  /** LiveKit access token for joining the room */
  token: string;
  /** LiveKit server URL to connect to */
  url?: string;
  /** Room name in LiveKit */
  room?: string;
}

/** Discord-like embed object */
export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  thumbnail?: { url: string };
  image?: { url: string };
  author?: { name: string; icon_url?: string };
  footer?: { text: string; icon_url?: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}
