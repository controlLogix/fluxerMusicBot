# Fluxer Music Bot

A simple music bot for [Fluxer](https://fluxer.app) servers. Plays audio from
YouTube, SoundCloud, and anything else `yt-dlp` supports into a Fluxer voice
channel over LiveKit.

## Requirements

- Node.js 20+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your `PATH`
- [ffmpeg](https://ffmpeg.org/) on your `PATH`
- A Fluxer bot token
- LiveKit credentials from your Fluxer instance

## Install

```bash
git clone <your-repo-url> fluxer-music-bot
cd fluxer-music-bot
npm install
```

## Configure

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

`.env`:

```env
FLUXER_BOT_TOKEN=your-bot-token
FLUXER_BASE_URL=https://fluxer.app
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=your-key
LIVEKIT_API_SECRET=your-secret
BOT_PREFIX=!
```

## Run

Development (auto-reload):

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

## Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `!play <url or query>` | `!p` | Play a track or add it to the queue |
| `!skip` | `!s` | Skip the current track |
| `!stop` | — | Stop playback and clear the queue |
| `!pause` | — | Pause playback |
| `!resume` | — | Resume playback |
| `!queue` | `!q` | Show the queue |
| `!np` | `!nowplaying` | Show the current track |
| `!volume <0-200>` | `!vol` | Set the volume |
| `!join [channel_id]` | `!j` | Join a voice channel |
| `!leave` | `!dc` | Leave the voice channel |
| `!help` | `!h` | Show help |

## Project Layout

```
src/
  index.ts     # entry point + command handlers
  config.ts    # env loader
  api.ts       # Fluxer HTTP client
  gateway.ts   # Fluxer WebSocket gateway client
  voice.ts     # LiveKit voice + queue manager
```

## Notes

This is early-stage and tracks an evolving Fluxer API. Expect to tweak auth
headers / endpoints for your instance. PRs welcome.

## License

MIT
