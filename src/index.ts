import { loadConfig } from './config.js';
import { FluxerAPI, type Message, type Channel, ChannelType, type Embed } from './api.js';
import { FluxerGateway, type ReadyEvent } from './gateway.js';
import { VoiceManager, type QueueItem } from './voice.js';

// ── Welcome/Goodbye Config ─────────────────────────────
// Map of guildId → { welcomeChannelId, goodbyeChannelId, welcomeMessage, goodbyeMessage }
const greetingConfig = new Map<string, {
  welcomeChannel?: string;
  goodbyeChannel?: string;
  welcomeMsg: string;
  goodbyeMsg: string;
}>();

// ── Load Config ────────────────────────────────────────

const config = loadConfig();
const api = new FluxerAPI(config);
const gateway = new FluxerGateway(config, api);
const voiceManager = new VoiceManager(config, api, gateway);

// ── Gateway Events ─────────────────────────────────────

gateway.on('ready', (ready: ReadyEvent) => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       🎵 Fluxer Music Bot Online 🎵      ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  User: ${ready.user.username.padEnd(33)}║`);
  console.log(`║  ID:   ${ready.user.id.padEnd(33)}║`);
  console.log(`║  Guilds: ${String(ready.guilds.length).padEnd(31)}║`);
  console.log(`║  Prefix: ${config.prefix.padEnd(31)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`Commands: ${config.prefix}play, ${config.prefix}skip, ${config.prefix}stop, ${config.prefix}queue, ${config.prefix}pause, ${config.prefix}resume, ${config.prefix}volume, ${config.prefix}join, ${config.prefix}leave, ${config.prefix}np, ${config.prefix}help`);
  console.log('');
});

gateway.on('messageCreate', async (message: Message) => {
  // Ignore messages from bots (including ourselves)
  if (message.author.bot) return;

  // Ignore messages without our prefix
  if (!message.content.startsWith(config.prefix)) return;

  // Ignore DMs (no guild_id)
  if (!message.guild_id) return;

  const args = message.content.slice(config.prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (!command) return;

  try {
    switch (command) {
      case 'play':
      case 'p':
        await handlePlay(message, args);
        break;

      case 'skip':
      case 's':
        await handleSkip(message);
        break;

      case 'stop':
        await handleStop(message);
        break;

      case 'queue':
      case 'q':
        await handleQueue(message);
        break;

      case 'pause':
        await handlePause(message);
        break;

      case 'resume':
        await handleResume(message);
        break;

      case 'volume':
      case 'vol':
        await handleVolume(message, args);
        break;

      case 'join':
      case 'j':
        await handleJoin(message, args);
        break;

      case 'leave':
      case 'disconnect':
      case 'dc':
        await handleLeave(message);
        break;

      case 'np':
      case 'nowplaying':
        await handleNowPlaying(message);
        break;

      case 'help':
      case 'h':
        await handleHelp(message);
        break;

      case 'setwelcome':
        await handleSetWelcome(message, args);
        break;

      case 'setgoodbye':
        await handleSetGoodbye(message, args);
        break;

      case 'testwelcome':
        await handleTestWelcome(message);
        break;

      case 'testgoodbye':
        await handleTestGoodbye(message);
        break;

      default:
        // Unknown command, ignore silently
        break;
    }
  } catch (err) {
    console.error(`[Bot] Error handling command '${command}':`, err);
    await api.sendMessage(message.channel_id, `❌ An error occurred: ${err instanceof Error ? err.message : 'Unknown error'}`).catch(() => {});
  }
});

// ── Command Handlers ───────────────────────────────────

async function handlePlay(message: Message, args: string[]): Promise<void> {
  if (args.length === 0) {
    await api.sendMessage(message.channel_id, `Usage: \`${config.prefix}play <url or search query>\``);
    return;
  }

  const guildId = message.guild_id!;
  const query = args.join(' ');

  // Get or create voice connection
  const connection = voiceManager.getConnection(guildId);

  // If not in a voice channel, try to join one
  if (!voiceManager.hasConnection(guildId)) {
    // Try to find a voice channel in the guild
    try {
      const channels = await api.getGuildChannels(guildId);
      const voiceChannel = channels.find((ch) => ch.type === ChannelType.GUILD_VOICE);
      if (voiceChannel) {
        await connection.join(voiceChannel.id);
        await api.sendMessage(message.channel_id, `🔊 Joined **${voiceChannel.name ?? 'voice channel'}**`);
      } else {
        await api.sendMessage(message.channel_id, '❌ No voice channels found. Use `!join <channel_id>` to specify one.');
        return;
      }
    } catch {
      await api.sendMessage(message.channel_id, '❌ Could not find a voice channel to join.');
      return;
    }
  }

  // Set up event listeners for this connection
  connection.removeAllListeners('trackStart');
  connection.removeAllListeners('trackError');
  connection.removeAllListeners('queueEmpty');

  connection.on('trackStart', (track: QueueItem) => {
    const embed: Embed = {
      title: `🎵 Now Playing`,
      description: `**${track.title}**`,
      url: track.url,
      color: 0x1DB954,
      thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
      fields: [
        { name: '⏱️ Duration', value: track.duration ?? 'Unknown', inline: true },
        { name: '👤 Requested by', value: track.requestedBy, inline: true },
      ],
    };
    // Send with button components (Discord-like action rows)
    const components = [{
      type: 1, // ACTION_ROW
      components: [
        { type: 2, style: 2, label: 'Pause', custom_id: 'music_pause' },
        { type: 2, style: 3, label: 'Resume', custom_id: 'music_resume' },
        { type: 2, style: 1, label: 'Skip', custom_id: 'music_skip' },
        { type: 2, style: 4, label: 'Stop', custom_id: 'music_stop' },
      ]
    }];
    api.sendMessage(message.channel_id, '', embed, components).catch(() => {});
  });

  connection.on('trackError', (track: QueueItem, err: Error) => {
    api.sendMessage(message.channel_id, `❌ Error playing **${track.title}**: ${err.message}`).catch(() => {});
  });

  connection.on('queueEmpty', () => {
    api.sendMessage(message.channel_id, '📭 Queue is empty. Add more songs with `!play`!').catch(() => {});
  });

  // Add to queue
  await api.sendMessage(message.channel_id, `🔍 Searching for: **${query}**...`);
  const item = await connection.addToQueue(query, message.author.username);
  
  if (connection.queueLength > 0) {
    const embed: Embed = {
      title: '✅ Added to Queue',
      description: `**${item.title}**`,
      url: item.url,
      color: 0x5865F2, // Blurple
      thumbnail: item.thumbnail ? { url: item.thumbnail } : undefined,
      fields: [
        { name: '⏱️ Duration', value: item.duration ?? 'Unknown', inline: true },
        { name: '📋 Position', value: `#${connection.queueLength}`, inline: true },
        { name: '👤 Requested by', value: item.requestedBy, inline: true },
      ],
    };
    api.sendMessage(message.channel_id, '', embed).catch(() => {});
  }
}

async function handleSkip(message: Message): Promise<void> {
  const guildId = message.guild_id!;
  if (!voiceManager.hasConnection(guildId)) {
    await api.sendMessage(message.channel_id, '❌ Not playing anything.');
    return;
  }

  const connection = voiceManager.getConnection(guildId);
  const current = connection.currentlyPlaying;
  connection.skip();
  await api.sendMessage(message.channel_id, `⏭️ Skipped: **${current?.title ?? 'Unknown'}**`);
}

async function handleStop(message: Message): Promise<void> {
  const guildId = message.guild_id!;
  if (!voiceManager.hasConnection(guildId)) {
    await api.sendMessage(message.channel_id, '❌ Not playing anything.');
    return;
  }

  const connection = voiceManager.getConnection(guildId);
  connection.stop();
  await api.sendMessage(message.channel_id, '⏹️ Stopped playback and cleared the queue.');
}

async function handleQueue(message: Message): Promise<void> {
  const guildId = message.guild_id!;
  if (!voiceManager.hasConnection(guildId)) {
    await api.sendMessage(message.channel_id, '📭 Queue is empty.');
    return;
  }

  const connection = voiceManager.getConnection(guildId);
  const current = connection.currentlyPlaying;
  const queue = connection.queueList;

  let response = '';

  if (current) {
    response += `🎵 **Now Playing:** ${current.title} (requested by ${current.requestedBy})\n\n`;
  }

  if (queue.length === 0) {
    response += '📭 Queue is empty.';
  } else {
    response += '**Queue:**\n';
    const maxShow = 10;
    for (let i = 0; i < Math.min(queue.length, maxShow); i++) {
      response += `${i + 1}. **${queue[i].title}** (requested by ${queue[i].requestedBy})\n`;
    }
    if (queue.length > maxShow) {
      response += `\n...and ${queue.length - maxShow} more tracks.`;
    }
  }

  await api.sendMessage(message.channel_id, response);
}

async function handlePause(message: Message): Promise<void> {
  const guildId = message.guild_id!;
  if (!voiceManager.hasConnection(guildId)) {
    await api.sendMessage(message.channel_id, '❌ Not playing anything.');
    return;
  }

  const connection = voiceManager.getConnection(guildId);
  if (connection.pause()) {
    await api.sendMessage(message.channel_id, '⏸️ Paused.');
  } else {
    await api.sendMessage(message.channel_id, '❌ Nothing to pause.');
  }
}

async function handleResume(message: Message): Promise<void> {
  const guildId = message.guild_id!;
  if (!voiceManager.hasConnection(guildId)) {
    await api.sendMessage(message.channel_id, '❌ Not playing anything.');
    return;
  }

  const connection = voiceManager.getConnection(guildId);
  if (connection.resume()) {
    await api.sendMessage(message.channel_id, '▶️ Resumed.');
  } else {
    await api.sendMessage(message.channel_id, '❌ Nothing to resume.');
  }
}

async function handleVolume(message: Message, args: string[]): Promise<void> {
  const guildId = message.guild_id!;
  if (!voiceManager.hasConnection(guildId)) {
    await api.sendMessage(message.channel_id, '❌ Not in a voice channel.');
    return;
  }

  if (args.length === 0) {
    await api.sendMessage(message.channel_id, `Usage: \`${config.prefix}volume <0-200>\``);
    return;
  }

  const vol = parseInt(args[0], 10);
  if (isNaN(vol) || vol < 0 || vol > 200) {
    await api.sendMessage(message.channel_id, '❌ Volume must be between 0 and 200.');
    return;
  }

  const connection = voiceManager.getConnection(guildId);
  connection.setVolume(vol);
  await api.sendMessage(message.channel_id, `🔊 Volume set to **${vol}%**`);
}

async function handleJoin(message: Message, args: string[]): Promise<void> {
  const guildId = message.guild_id!;

  let channelId: string | undefined;
  let channelName: string | undefined;

  // Try to get guild channels to resolve name → ID
  let channels: Channel[] = [];
  try {
    channels = await api.getGuildChannels(guildId);
    console.log(`[Bot] Found ${channels.length} channels in guild. Voice channels:`,
      channels.filter(ch => ch.type === ChannelType.GUILD_VOICE).map(ch => `${ch.name} (${ch.id})`));
  } catch (err) {
    console.log(`[Bot] Could not fetch guild channels:`, err instanceof Error ? err.message : err);
  }

  if (args.length > 0) {
    const query = args.join(' ');
    // Check if it's a numeric ID or a channel name
    if (/^\d+$/.test(query)) {
      channelId = query;
    } else {
      // Look up by name (case-insensitive)
      const voiceChannel = channels.find(
        (ch) => ch.type === ChannelType.GUILD_VOICE &&
          ch.name?.toLowerCase() === query.toLowerCase()
      );
      if (voiceChannel) {
        channelId = voiceChannel.id;
        channelName = voiceChannel.name ?? query;
      } else {
        // Try partial match
        const partial = channels.find(
          (ch) => ch.type === ChannelType.GUILD_VOICE &&
            ch.name?.toLowerCase().includes(query.toLowerCase())
        );
        if (partial) {
          channelId = partial.id;
          channelName = partial.name ?? query;
        }
      }
    }
  } else {
    // No args: join the first voice channel
    const voiceChannel = channels.find((ch) => ch.type === ChannelType.GUILD_VOICE);
    if (voiceChannel) {
      channelId = voiceChannel.id;
      channelName = voiceChannel.name ?? 'voice channel';
    }
  }

  if (!channelId) {
    const voiceChannels = channels
      .filter(ch => ch.type === ChannelType.GUILD_VOICE)
      .map(ch => `\`${ch.name}\` (${ch.id})`)
      .join(', ');

    if (voiceChannels) {
      await api.sendMessage(message.channel_id,
        `❌ Could not find voice channel "${args.join(' ')}". Available: ${voiceChannels}`);
    } else {
      await api.sendMessage(message.channel_id,
        `Usage: \`${config.prefix}join <channel_name_or_id>\``);
    }
    return;
  }

  const connection = voiceManager.getConnection(guildId);
  await connection.join(channelId);
  api.sendMessage(message.channel_id,
    `🔊 Joining **${channelName ?? channelId}**... (LiveKit token acquired)`).catch(() => {});
}

async function handleLeave(message: Message): Promise<void> {
  const guildId = message.guild_id!;
  if (!voiceManager.hasConnection(guildId)) {
    await api.sendMessage(message.channel_id, '❌ Not in a voice channel.');
    return;
  }

  const connection = voiceManager.getConnection(guildId);
  connection.leave();
  await api.sendMessage(message.channel_id, '👋 Left the voice channel.');
}

async function handleNowPlaying(message: Message): Promise<void> {
  const guildId = message.guild_id!;
  if (!voiceManager.hasConnection(guildId)) {
    await api.sendMessage(message.channel_id, '❌ Not playing anything.');
    return;
  }

  const connection = voiceManager.getConnection(guildId);
  const current = connection.currentlyPlaying;

  if (current) {
    const status = connection.paused ? '⏸️ Paused' : '▶️ Playing';
    await api.sendMessage(message.channel_id, `${status}: **${current.title}** (requested by ${current.requestedBy})`);
  } else {
    await api.sendMessage(message.channel_id, '❌ Not playing anything.');
  }
}

async function handleHelp(message: Message): Promise<void> {
  const p = config.prefix;
  const help = [
    '🎵 **Fluxer Music Bot** — Commands:',
    '',
    `\`${p}play <url/query>\` — Play a song or add it to the queue`,
    `\`${p}skip\` — Skip the current track`,
    `\`${p}stop\` — Stop playback and clear the queue`,
    `\`${p}pause\` — Pause the current track`,
    `\`${p}resume\` — Resume playback`,
    `\`${p}queue\` — Show the current queue`,
    `\`${p}np\` — Show the currently playing track`,
    `\`${p}volume <0-200>\` — Set the volume`,
    `\`${p}join [channel_id]\` — Join a voice channel`,
    `\`${p}leave\` — Leave the voice channel`,
    `\`${p}help\` — Show this help message`,
    '',
    '**Aliases:** `p`=play, `s`=skip, `q`=queue, `j`=join, `dc`=leave, `vol`=volume',
    '',
    'Supports YouTube URLs, SoundCloud, and text search queries.',
  ].join('\n');

  await api.sendMessage(message.channel_id, help);
}

// ── Welcome/Goodbye Handlers ───────────────────────────

async function handleSetWelcome(message: Message, args: string[]): Promise<void> {
  const guildId = message.guild_id!;
  const text = args.join(' ');

  if (!text) {
    await api.sendMessage(message.channel_id,
      `Usage: \`${config.prefix}setwelcome <message>\`\n` +
      `Use \`{user}\` for the username, \`{server}\` for the server name.\n` +
      `Example: \`${config.prefix}setwelcome Welcome to the server, {user}! 🎉\`\n` +
      `The welcome message will be sent to this channel.\n` +
      `To disable: \`${config.prefix}setwelcome off\``);
    return;
  }

  if (text.toLowerCase() === 'off') {
    const cfg = greetingConfig.get(guildId);
    if (cfg) { cfg.welcomeChannel = undefined; cfg.welcomeMsg = ''; }
    await api.sendMessage(message.channel_id, '✅ Welcome messages disabled.');
    return;
  }

  const cfg = greetingConfig.get(guildId) ?? { welcomeMsg: '', goodbyeMsg: '' };
  cfg.welcomeChannel = message.channel_id;
  cfg.welcomeMsg = text;
  greetingConfig.set(guildId, cfg);

  await api.sendMessage(message.channel_id,
    `✅ Welcome message set! It will be sent in this channel when someone joins.\n` +
    `Preview: ${text.replace('{user}', message.author.username).replace('{server}', 'this server')}`);
}

async function handleSetGoodbye(message: Message, args: string[]): Promise<void> {
  const guildId = message.guild_id!;
  const text = args.join(' ');

  if (!text) {
    await api.sendMessage(message.channel_id,
      `Usage: \`${config.prefix}setgoodbye <message>\`\n` +
      `Use \`{user}\` for the username.\n` +
      `Example: \`${config.prefix}setgoodbye Goodbye {user}, we'll miss you! 👋\`\n` +
      `The goodbye message will be sent to this channel.\n` +
      `To disable: \`${config.prefix}setgoodbye off\``);
    return;
  }

  if (text.toLowerCase() === 'off') {
    const cfg = greetingConfig.get(guildId);
    if (cfg) { cfg.goodbyeChannel = undefined; cfg.goodbyeMsg = ''; }
    await api.sendMessage(message.channel_id, '✅ Goodbye messages disabled.');
    return;
  }

  const cfg = greetingConfig.get(guildId) ?? { welcomeMsg: '', goodbyeMsg: '' };
  cfg.goodbyeChannel = message.channel_id;
  cfg.goodbyeMsg = text;
  greetingConfig.set(guildId, cfg);

  await api.sendMessage(message.channel_id,
    `✅ Goodbye message set! It will be sent in this channel when someone leaves.\n` +
    `Preview: ${text.replace('{user}', message.author.username)}`);
}

async function handleTestWelcome(message: Message): Promise<void> {
  const guildId = message.guild_id!;
  const cfg = greetingConfig.get(guildId);
  if (!cfg?.welcomeChannel || !cfg.welcomeMsg) {
    await api.sendMessage(message.channel_id, `❌ No welcome message set. Use \`${config.prefix}setwelcome <message>\``);
    return;
  }
  const msg = cfg.welcomeMsg.replace('{user}', message.author.username).replace('{server}', 'this server');
  await api.sendMessage(cfg.welcomeChannel, msg);
}

async function handleTestGoodbye(message: Message): Promise<void> {
  const guildId = message.guild_id!;
  const cfg = greetingConfig.get(guildId);
  if (!cfg?.goodbyeChannel || !cfg.goodbyeMsg) {
    await api.sendMessage(message.channel_id, `❌ No goodbye message set. Use \`${config.prefix}setgoodbye <message>\``);
    return;
  }
  const msg = cfg.goodbyeMsg.replace('{user}', message.author.username);
  await api.sendMessage(cfg.goodbyeChannel, msg);
}

// ── Button Interaction Handler ─────────────────────────

gateway.on('interactionCreate', async (data: any) => {
  // Handle button interactions (type 3 = MESSAGE_COMPONENT)
  if (data.type !== 3) return;
  
  const customId = data.data?.custom_id;
  const guildId = data.guild_id;
  const channelId = data.channel_id;
  
  if (!customId || !guildId) return;
  
  console.log(`[Bot] Button clicked: ${customId} by ${data.member?.user?.username ?? 'unknown'}`);

  const connection = voiceManager.hasConnection(guildId) ? voiceManager.getConnection(guildId) : null;
  
  switch (customId) {
    case 'music_pause':
      if (connection?.pause()) {
        api.sendMessage(channelId, '⏸️ Paused.').catch(() => {});
      }
      break;
    case 'music_resume':
      if (connection?.resume()) {
        api.sendMessage(channelId, '▶️ Resumed.').catch(() => {});
      }
      break;
    case 'music_skip':
      if (connection) {
        const current = connection.currentlyPlaying;
        connection.skip();
        api.sendMessage(channelId, `⏭️ Skipped: **${current?.title ?? 'Unknown'}**`).catch(() => {});
      }
      break;
    case 'music_stop':
      if (connection) {
        connection.stop();
        api.sendMessage(channelId, '⏹️ Stopped playback.').catch(() => {});
      }
      break;
  }
});

// ── Member Join/Leave Events ───────────────────────────

gateway.on('guildMemberAdd', async (data: any) => {
  const guildId = data.guild_id;
  const user = data.user;
  if (!guildId || !user) return;

  console.log(`[Bot] Member joined: ${user.username} in guild ${guildId}`);

  const cfg = greetingConfig.get(guildId);
  if (cfg?.welcomeChannel && cfg.welcomeMsg) {
    const msg = cfg.welcomeMsg
      .replace('{user}', user.username)
      .replace('{server}', 'the server');
    api.sendMessage(cfg.welcomeChannel, msg).catch(() => {});
  }
});

gateway.on('guildMemberRemove', async (data: any) => {
  const guildId = data.guild_id;
  const user = data.user;
  if (!guildId || !user) return;

  console.log(`[Bot] Member left: ${user.username} from guild ${guildId}`);

  const cfg = greetingConfig.get(guildId);
  if (cfg?.goodbyeChannel && cfg.goodbyeMsg) {
    const msg = cfg.goodbyeMsg.replace('{user}', user.username);
    api.sendMessage(cfg.goodbyeChannel, msg).catch(() => {});
  }
});

// ── Startup ────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[Bot] Starting Fluxer Music Bot...');
  console.log(`[Bot] Instance: ${config.baseUrl}`);
  console.log(`[Bot] LiveKit: ${config.livekitUrl}`);
  console.log('');

  // Connect to the gateway
  await gateway.connect();
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Bot] Shutting down...');
  voiceManager.disconnectAll();
  gateway.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Bot] Shutting down...');
  voiceManager.disconnectAll();
  gateway.disconnect();
  process.exit(0);
});

// Handle uncaught errors so the bot doesn't crash
process.on('uncaughtException', (err) => {
  console.error('[Bot] Uncaught exception (non-fatal):', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('[Bot] Unhandled rejection (non-fatal):', err instanceof Error ? err.message : err);
});

// Start the bot
main().catch((err) => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
