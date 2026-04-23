import { spawn, type ChildProcess, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import type { BotConfig } from './config.js';
import type { FluxerAPI } from './api.js';
import type { FluxerGateway, VoiceServerUpdateEvent } from './gateway.js';

// Resolve yt-dlp path (may not be on PATH on Windows)
let YTDLP_PATH = 'yt-dlp';
try {
  execFileSync('yt-dlp', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
} catch {
  const userPath = `${process.env.LOCALAPPDATA || 'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local'}\\Packages\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\LocalCache\\local-packages\\Python312\\Scripts\\yt-dlp.exe`;
  try {
    execFileSync(userPath, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    YTDLP_PATH = userPath;
    console.log(`[Voice] Found yt-dlp at: ${YTDLP_PATH}`);
  } catch {
    console.warn('[Voice] yt-dlp not found! Music playback will not work.');
  }
}

// Resolve ffmpeg path (may not be on PATH after winget install)
let FFMPEG_PATH = 'ffmpeg';
try {
  execFileSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
} catch {
  const wingetPath = `${process.env.LOCALAPPDATA || 'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local'}\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe`;
  try {
    execFileSync(wingetPath, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    FFMPEG_PATH = wingetPath;
    console.log(`[Voice] Found ffmpeg at: ${FFMPEG_PATH}`);
  } catch {
    console.warn('[Voice] ffmpeg not found! Audio transcoding will not work.');
  }
}

let Room: any;
let LocalAudioTrack: any;
let TrackPublishOptions: any;
let AudioSource: any;
let AudioFrame: any;

// Try to import @livekit/rtc-node (optional dependency)
try {
  const rtcNode = await import('@livekit/rtc-node');
  Room = rtcNode.Room;
  AudioSource = rtcNode.AudioSource;
  AudioFrame = rtcNode.AudioFrame;
  console.log('[Voice] LiveKit rtc-node SDK loaded');
} catch {
  console.log('[Voice] @livekit/rtc-node not available, voice room joining will be limited');
}

export interface QueueItem {
  /** URL or search query */
  query: string;
  /** Resolved title (populated after fetching metadata) */
  title?: string;
  /** Thumbnail/album art URL */
  thumbnail?: string;
  /** Video/track URL */
  url?: string;
  /** Duration string */
  duration?: string;
  /** Who requested it */
  requestedBy: string;
}

/**
 * Voice connection manager for a single guild.
 * Handles joining voice channels, managing the music queue,
 * and streaming audio through LiveKit via yt-dlp + ffmpeg.
 */
export class VoiceConnection extends EventEmitter {
  private config: BotConfig;
  private api: FluxerAPI;
  private gateway: FluxerGateway;
  private guildId: string;
  private channelId: string | null = null;
  private queue: QueueItem[] = [];
  private currentTrack: QueueItem | null = null;
  private ffmpegProcess: ChildProcess | null = null;
  private ytdlpProcess: ChildProcess | null = null;
  private isPlaying = false;
  private isPaused = false;
  private volume = 100;

  // LiveKit connection state
  private livekitToken: string | null = null;
  private livekitUrl: string | null = null;
  private livekitRoom: string | null = null;
  private room: any = null;
  private audioSource: any = null;
  private connected = false;

  constructor(config: BotConfig, api: FluxerAPI, gateway: FluxerGateway, guildId: string) {
    super();
    this.config = config;
    this.api = api;
    this.gateway = gateway;
    this.guildId = guildId;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get currentlyPlaying(): QueueItem | null {
    return this.currentTrack;
  }

  get queueList(): QueueItem[] {
    return [...this.queue];
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Join a voice channel.
   * This sends a voice state update via the gateway, then waits for
   * VOICE_SERVER_UPDATE to get LiveKit credentials.
   */
  async join(channelId: string): Promise<void> {
    this.channelId = channelId;
    console.log(`[Voice] Joining voice channel ${channelId} in guild ${this.guildId}`);

    // Send voice state update via gateway first
    this.gateway.sendVoiceStateUpdate(this.guildId, channelId, false, false);

    // Try to get a voice token from the API
    try {
      const voiceToken = await this.api.getVoiceToken(this.guildId, channelId);
      this.livekitToken = voiceToken.token;
      this.livekitUrl = voiceToken.url ?? this.config.livekitUrl;
      this.livekitRoom = voiceToken.room ?? undefined;
      console.log(`[Voice] Got LiveKit token via API`);
      console.log(`[Voice] LiveKit URL: ${this.livekitUrl}`);
      console.log(`[Voice] LiveKit Room: ${this.livekitRoom ?? 'from token'}`);
    } catch (err) {
      console.log(`[Voice] API voice token not available, waiting for gateway...`);
    }

    // Also listen for VOICE_SERVER_UPDATE from gateway
    const voiceServerHandler = (data: VoiceServerUpdateEvent) => {
      if (data.guild_id === this.guildId) {
        console.log(`[Voice] Got voice server update:`, JSON.stringify(data));
        // Use token from voice server update (more authoritative)
        this.livekitToken = data.token;
        // The endpoint from VOICE_SERVER_UPDATE is the REAL LiveKit server URL
        // (e.g., wss://alligator.mia.fluxer.media) — always prefer it
        if (data.endpoint) this.livekitUrl = data.endpoint;
        else if (data.livekit_url) this.livekitUrl = data.livekit_url;
        if (data.room) this.livekitRoom = data.room;
        this.gateway.removeListener('voiceServerUpdate', voiceServerHandler);

        // Connect to LiveKit if we haven't already
        if (!this.connected) {
          this.connectToLiveKit();
        }
      }
    };
    this.gateway.on('voiceServerUpdate', voiceServerHandler);

    // Wait for voice server update before connecting (it has the real LiveKit URL)
    // Don't connect immediately with API token - the VOICE_SERVER_UPDATE has the correct endpoint

    // Clean up listener after timeout
    setTimeout(() => {
      this.gateway.removeListener('voiceServerUpdate', voiceServerHandler);
    }, 15000);
  }

  /** Connect to the LiveKit room using the acquired token */
  private async connectToLiveKit(): Promise<void> {
    if (!this.livekitToken || !this.livekitUrl) {
      console.log('[Voice] Cannot connect to LiveKit: missing token or URL');
      return;
    }

    if (this.connected) {
      console.log('[Voice] Already connected to LiveKit');
      return;
    }

    if (!Room) {
      console.log('[Voice] @livekit/rtc-node not available, cannot connect to LiveKit room');
      return;
    }

    try {
      console.log(`[Voice] Connecting to LiveKit room at ${this.livekitUrl}...`);
      this.room = new Room();

      this.room.on('disconnected', () => {
        console.log('[Voice] Disconnected from LiveKit room');
        this.connected = false;
      });

      this.room.on('participantConnected', (participant: any) => {
        console.log(`[Voice] Participant joined: ${participant.identity}`);
      });

      await this.room.connect(this.livekitUrl, this.livekitToken, {
        autoSubscribe: true,
      });

      this.connected = true;
      console.log(`[Voice] ✅ Connected to LiveKit room! SID: ${this.room.sid ?? 'unknown'}`);

      // Create an audio source for publishing music
      if (AudioSource) {
        const rtc = await import('@livekit/rtc-node');
        this.audioSource = new rtc.AudioSource(48000, 2);
        const track = rtc.LocalAudioTrack.createAudioTrack('music', this.audioSource);
        await this.room.localParticipant.publishTrack(track, {
          source: rtc.TrackSource.SOURCE_MICROPHONE, // 2 = microphone
        });
        console.log('[Voice] ✅ Audio track published to LiveKit room (source: MICROPHONE)');
      }
    } catch (err) {
      console.error('[Voice] Failed to connect to LiveKit:', err instanceof Error ? err.message : err);
      this.connected = false;
    }
  }

  /** Leave the voice channel */
  leave(): void {
    console.log(`[Voice] Leaving voice channel in guild ${this.guildId}`);
    this.stop();
    this.queue = [];

    // Disconnect from LiveKit room
    if (this.room) {
      try { this.room.disconnect(); } catch {}
      this.room = null;
      this.audioSource = null;
      this.connected = false;
    }

    this.gateway.sendVoiceStateUpdate(this.guildId, null);
    this.channelId = null;
    this.livekitToken = null;
    this.emit('leave');
  }

  /** Add a track to the queue */
  async addToQueue(query: string, requestedBy: string): Promise<QueueItem> {
    // Get metadata from yt-dlp (title, thumbnail, url, duration)
    const metadata = await this.getTrackMetadata(query);
    const item: QueueItem = {
      query,
      title: metadata.title ?? query,
      thumbnail: metadata.thumbnail,
      url: metadata.url,
      duration: metadata.duration,
      requestedBy,
    };

    this.queue.push(item);
    console.log(`[Voice] Added to queue: ${item.title}`);

    // If nothing is playing, start playing
    if (!this.isPlaying) {
      this.playNext();
    }

    return item;
  }

  /** Skip the current track */
  skip(): void {
    console.log('[Voice] Skipping current track');
    this.stopCurrentProcess();
    this.playNext();
  }

  /** Stop playback and clear the queue */
  stop(): void {
    console.log('[Voice] Stopping playback');
    this.stopCurrentProcess();
    this.queue = [];
    this.currentTrack = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.emit('stop');
  }

  /** Pause playback */
  pause(): boolean {
    if (this.ffmpegProcess && this.isPlaying && !this.isPaused) {
      this.ffmpegProcess.kill('SIGSTOP');
      this.isPaused = true;
      this.emit('pause');
      return true;
    }
    return false;
  }

  /** Resume playback */
  resume(): boolean {
    if (this.ffmpegProcess && this.isPaused) {
      this.ffmpegProcess.kill('SIGCONT');
      this.isPaused = false;
      this.emit('resume');
      return true;
    }
    return false;
  }

  /** Set volume (0-200) */
  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(200, vol));
  }

  // ── Private Methods ──────────────────────────────────

  private async playNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.currentTrack = null;
      this.emit('queueEmpty');
      return;
    }

    const track = this.queue.shift()!;
    this.currentTrack = track;
    this.isPlaying = true;
    this.isPaused = false;

    console.log(`[Voice] Now playing: ${track.title}`);
    this.emit('trackStart', track);

    try {
      await this.streamTrack(track);
    } catch (err) {
      console.error(`[Voice] Error playing track:`, err);
      this.emit('trackError', track, err);
    }

    // Play next track when this one finishes
    this.playNext();
  }

  /**
   * Stream a track using yt-dlp piped to ffmpeg.
   * 
   * The audio pipeline is:
   *   yt-dlp (download) → ffmpeg (transcode to PCM/Opus) → LiveKit (publish)
   * 
   * Since LiveKit's Node SDK requires publishing audio tracks,
   * we output raw PCM from ffmpeg and would feed it to the LiveKit track.
   * 
   * For initial implementation, we pipe to LiveKit via the lk CLI tool
   * or via the @livekit/rtc-node AudioSource API.
   */
  private streamTrack(track: QueueItem): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.resolveUrl(track.query);
      const volumeFilter = this.volume !== 100 ? `-af volume=${this.volume / 100}` : '';

      // yt-dlp: extract best audio and output to stdout
      this.ytdlpProcess = spawn(YTDLP_PATH, [
        '--no-playlist',
        '-f', 'bestaudio',
        '-o', '-',
        url,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      // ffmpeg: transcode to 48kHz 16-bit PCM (LiveKit-compatible)
      // -re flag forces real-time output speed (critical for streaming)
      const ffmpegArgs = [
        '-re',                     // Real-time input reading speed (must be before -i)
        '-i', 'pipe:0',           // Read from stdin (yt-dlp output)
        '-f', 's16le',            // Raw PCM signed 16-bit little-endian
        '-ar', '48000',           // 48kHz sample rate
        '-ac', '2',               // Stereo
        ...(volumeFilter ? ['-af', `volume=${this.volume / 100}`] : []),
        '-loglevel', 'error',
        'pipe:1',                 // Output to stdout
      ];

      this.ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Pipe yt-dlp → ffmpeg
      if (this.ytdlpProcess.stdout && this.ffmpegProcess.stdin) {
        this.ytdlpProcess.stdout.pipe(this.ffmpegProcess.stdin);
      }

      // Handle PCM output from ffmpeg — feed it to LiveKit AudioSource
      if (this.ffmpegProcess.stdout) {
        let bytesProcessed = 0;
        const SAMPLE_RATE = 48000;
        const NUM_CHANNELS = 2;
        const BYTES_PER_SAMPLE = 2; // 16-bit = 2 bytes
        const FRAME_DURATION_MS = 20; // 20ms frames
        const FRAME_SIZE = SAMPLE_RATE * FRAME_DURATION_MS / 1000; // 960 samples per frame
        const FRAME_BYTES = FRAME_SIZE * NUM_CHANNELS * BYTES_PER_SAMPLE; // 3840 bytes per frame
        let pcmBuffer = Buffer.alloc(0);
        let frameQueue: Buffer[] = [];
        let sending = false;

        // Async frame sender that paces frames at real-time speed (20ms per frame)
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        let startTime = 0;
        let framesSent = 0;

        const sendFrames = async () => {
          if (sending) return;
          sending = true;
          if (startTime === 0) {
            startTime = Date.now();
            console.log(`[Voice] Starting audio frame transmission...`);
          }

          while (frameQueue.length > 0 && this.audioSource && AudioFrame) {
            const frameData = frameQueue.shift()!;
            try {
              const samples = new Int16Array(
                frameData.buffer.slice(frameData.byteOffset, frameData.byteOffset + frameData.byteLength)
              );
              const frame = new AudioFrame(samples, SAMPLE_RATE, NUM_CHANNELS, FRAME_SIZE);
              await this.audioSource.captureFrame(frame);
              framesSent++;

              // Log progress every 5 seconds (250 frames at 20ms each)
              if (framesSent % 250 === 0) {
                const elapsedSec = (Date.now() - startTime) / 1000;
                const audioSec = (framesSent * FRAME_DURATION_MS) / 1000;
                console.log(`[Voice] Sent ${framesSent} frames (${Math.round(audioSec)}s audio / ${Math.round(elapsedSec)}s elapsed, queue: ${frameQueue.length})`);
              }

              // captureFrame handles its own pacing via the LiveKit SDK
              // No additional sleep needed since -re flag paces ffmpeg output
            } catch (err) {
              // Log first few frame errors
              if (framesSent < 5) {
                console.error(`[Voice] Frame capture error at frame ${framesSent}:`, err instanceof Error ? err.message : err);
              }
            }
          }
          sending = false;
        };

        this.ffmpegProcess.stdout.on('data', (chunk: Buffer) => {
          bytesProcessed += chunk.length;
          pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

          // Extract complete frames and queue them
          while (pcmBuffer.length >= FRAME_BYTES) {
            const frameData = Buffer.from(pcmBuffer.subarray(0, FRAME_BYTES));
            pcmBuffer = pcmBuffer.subarray(FRAME_BYTES);
            frameQueue.push(frameData);
          }

          // Start sending if not already
          sendFrames();
        });

        this.ffmpegProcess.stdout.on('end', () => {
          const durationSec = bytesProcessed / (SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE);
          console.log(`[Voice] Track finished: ${track.title} (${Math.round(durationSec)}s)`);
        });
      }

      // Handle errors
      this.ytdlpProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[yt-dlp] ${msg}`);
      });

      this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[ffmpeg] ${msg}`);
      });

      this.ffmpegProcess.on('close', (code) => {
        this.ffmpegProcess = null;
        this.ytdlpProcess = null;
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      this.ffmpegProcess.on('error', (err) => {
        reject(err);
      });

      this.ytdlpProcess.on('error', (err) => {
        console.error('[Voice] yt-dlp error:', err.message);
        console.error('[Voice] Make sure yt-dlp is installed: pip install yt-dlp');
        reject(err);
      });
    });
  }

  /** Resolve a query to a URL (if it's not already a URL, treat as YouTube search) */
  private resolveUrl(query: string): string {
    if (query.startsWith('http://') || query.startsWith('https://')) {
      return query;
    }
    // Use yt-dlp's YouTube search
    return `ytsearch:${query}`;
  }

  /** Get track metadata from yt-dlp (title, thumbnail, url, duration) */
  private async getTrackMetadata(query: string): Promise<{ title?: string; thumbnail?: string; url?: string; duration?: string }> {
    return new Promise((resolve) => {
      const url = this.resolveUrl(query);
      const proc = spawn(YTDLP_PATH, [
        '--dump-json',
        '--no-playlist',
        '--quiet',
        '--no-download',
        url,
      ]);

      let output = '';
      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });

      proc.on('close', () => {
        try {
          const json = JSON.parse(output.trim());
          const durationSec = json.duration ?? 0;
          const mins = Math.floor(durationSec / 60);
          const secs = Math.floor(durationSec % 60);
          resolve({
            title: json.title ?? json.fulltitle,
            thumbnail: json.thumbnail ?? json.thumbnails?.[json.thumbnails.length - 1]?.url,
            url: json.webpage_url ?? json.url,
            duration: `${mins}:${secs.toString().padStart(2, '0')}`,
          });
        } catch {
          resolve({});
        }
      });

      proc.on('error', () => {
        resolve({});
      });

      // Timeout after 15 seconds
      setTimeout(() => {
        proc.kill();
        resolve({});
      }, 15000);
    });
  }

  private stopCurrentProcess(): void {
    if (this.ytdlpProcess) {
      this.ytdlpProcess.kill('SIGTERM');
      this.ytdlpProcess = null;
    }
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }
  }
}

/**
 * Manages voice connections across multiple guilds.
 */
export class VoiceManager {
  private connections = new Map<string, VoiceConnection>();
  private config: BotConfig;
  private api: FluxerAPI;
  private gateway: FluxerGateway;

  constructor(config: BotConfig, api: FluxerAPI, gateway: FluxerGateway) {
    this.config = config;
    this.api = api;
    this.gateway = gateway;
  }

  /** Get or create a voice connection for a guild */
  getConnection(guildId: string): VoiceConnection {
    let connection = this.connections.get(guildId);
    if (!connection) {
      connection = new VoiceConnection(this.config, this.api, this.gateway, guildId);
      connection.on('leave', () => {
        this.connections.delete(guildId);
      });
      this.connections.set(guildId, connection);
    }
    return connection;
  }

  /** Check if the bot is in a voice channel in a guild */
  hasConnection(guildId: string): boolean {
    return this.connections.has(guildId);
  }

  /** Disconnect all voice connections */
  disconnectAll(): void {
    for (const connection of this.connections.values()) {
      connection.leave();
    }
    this.connections.clear();
  }
}