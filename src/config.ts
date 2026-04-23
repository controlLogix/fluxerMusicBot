/**
 * Bot configuration loaded from environment variables.
 */
export interface BotConfig {
  /** Fluxer bot token */
  token: string;
  /** Base URL of the Fluxer instance (e.g., https://fluxer.app) */
  baseUrl: string;
  /** LiveKit WebSocket URL */
  livekitUrl: string;
  /** LiveKit API key */
  livekitApiKey: string;
  /** LiveKit API secret */
  livekitApiSecret: string;
  /** Command prefix (default: !) */
  prefix: string;
}

export function loadConfig(): BotConfig {
  const token = process.env.FLUXER_BOT_TOKEN;
  if (!token) {
    throw new Error('FLUXER_BOT_TOKEN environment variable is required');
  }

  const baseUrl = process.env.FLUXER_BASE_URL;
  if (!baseUrl) {
    throw new Error('FLUXER_BASE_URL environment variable is required');
  }

  const livekitUrl = process.env.LIVEKIT_URL;
  if (!livekitUrl) {
    throw new Error('LIVEKIT_URL environment variable is required');
  }

  const livekitApiKey = process.env.LIVEKIT_API_KEY;
  if (!livekitApiKey) {
    throw new Error('LIVEKIT_API_KEY environment variable is required');
  }

  const livekitApiSecret = process.env.LIVEKIT_API_SECRET;
  if (!livekitApiSecret) {
    throw new Error('LIVEKIT_API_SECRET environment variable is required');
  }

  return {
    token,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    livekitUrl,
    livekitApiKey,
    livekitApiSecret,
    prefix: process.env.BOT_PREFIX ?? '!',
  };
}