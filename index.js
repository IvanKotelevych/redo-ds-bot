const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');
const {
    StreamType,
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
} = require('@discordjs/voice');

const cookiesPath = path.join(__dirname, 'cookies.txt');

if (process.env.YOUTUBE_COOKIES) {
    const decoded = Buffer.from(process.env.YOUTUBE_COOKIES, 'base64').toString('utf-8');
    fs.writeFileSync(cookiesPath, decoded);
    console.log('[cookies] Файл записано, розмір:', fs.statSync(cookiesPath).size, 'байт');
} else {
    console.log('[cookies] ЗМІННА YOUTUBE_COOKIES ВІДСУТНЯ!');
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '!';

// ==== Черги по серверах (guildId -> queue) ====
// queue = { connection, player, songs: [{ url, title }], textChannel, voiceChannel }
const queues = new Map();

function getQueue(guildId) {
    return queues.get(guildId);
}

function createQueue(guildId, connection, textChannel, voiceChannel) {
    const player = createAudioPlayer();
    const queue = {
        connection,
        player,
        songs: [],
        textChannel,
        voiceChannel,
    };
    queues.set(guildId, queue);

    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
        // Поточна пісня закінчилась (або її скіпнули) — граємо наступну
        queue.songs.shift();
        if (queue.songs.length > 0) {
            playSong(guildId, queue.songs[0]);
        } else {
            // Черга порожня — виходимо з каналу
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                connection.destroy();
            }
            queues.delete(guildId);
        }
    });

    player.on('error', (error) => {
        console.error(`[player error]: ${error.message}`);
        queue.textChannel.send('❌ Помилка під час відтворення, пропускаю трек.');
        queue.songs.shift();
        if (queue.songs.length > 0) {
            playSong(guildId, queue.songs[0]);
        } else {
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                connection.destroy();
            }
            queues.delete(guildId);
        }
    });

    return queue;
}

function playSong(guildId, song) {
    const queue = getQueue(guildId);
    if (!queue) return;

    const args = [
        song.url,
        '--output', '-',
        '--quiet',
        '--format', 'bestaudio[ext=webm]/bestaudio/best',
        '--no-warnings',
        '--prefer-free-formats',
        '--cookies', cookiesPath,
    ];

    const ytDlpProcess = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    ytDlpProcess.stderr.on('data', (data) => {
        console.error(`[yt-dlp stderr]: ${data}`);
    });
    ytDlpProcess.on('error', (err) => {
        console.error('[yt-dlp process error]:', err);
    });

    const ffmpegProcess = spawn(ffmpeg, [
        '-i', 'pipe:0',
        '-analyzeduration', '0',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ffmpegProcess.stderr.on('data', (data) => {
        console.error(`[ffmpeg stderr]: ${data}`);
    });

    ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

    const resource = createAudioResource(ffmpegProcess.stdout, {
        inputType: StreamType.Raw,
    });

    queue.player.play(resource);
    queue.textChannel.send(`🎵 Відтворення розпочато: **${song.title}**`);
}

// Витягує список відео з плейлиста без завантаження (--flat-playlist --dump-json)
function fetchPlaylistEntries(url) {
    return new Promise((resolve, reject) => {
        const args = [
            url,
            '--flat-playlist',
            '--dump-json',
            '--no-warnings',
            '--quiet',
            '--cookies', cookiesPath,
        ];

        const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        proc.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(stderr || `yt-dlp завершився з кодом ${code}`));
            }
            try {
                const entries = stdout
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line))
                    .map((info) => ({
                        url: `https://www.youtube.com/watch?v=${info.id}`,
                        title: info.title || info.id,
                    }));
                resolve(entries);
            } catch (err) {
                reject(err);
            }
        });
    });
}

// Дістає назву одного відео (для відображення в черзі)
function fetchSingleTitle(url) {
    return new Promise((resolve) => {
        const args = ['--dump-json', '--no-warnings', '--quiet', '--cookies', cookiesPath, url];
        const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        proc.stdout.on('data', (data) => { stdout += data; });
        proc.on('close', () => {
            try {
                const info = JSON.parse(stdout);
                resolve(info.title || url);
            } catch {
                resolve(url);
            }
        });
    });
}

client.once(Events.ClientReady, () => {
    console.log(`🤖 Бот успішно запущений як ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const guildId = message.guild.id;

    if (command === 'play') {
        const url = args[0];
        const voiceChannel = message.member.voice.channel;
        let queue = getQueue(guildId);

        // !play без посилання — продовжити з паузи
        if (!url) {
            if (queue && queue.player.state.status === AudioPlayerStatus.Paused) {
                queue.player.unpause();
                return message.reply('▶️ Відтворення продовжено.');
            }
            return message.reply('❌ Вкажи посилання на YouTube відео/плейлист, або спочатку постав щось на паузу.');
        }

        if (!voiceChannel) {
            return message.reply('❌ Тобі потрібно спочатку зайти в будь-який голосовий канал!');
        }

        try {
            // Створюємо чергу і з'єднання, якщо їх ще немає
            if (!queue) {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId,
                    adapterCreator: message.guild.voiceAdapterCreator,
                });
                queue = createQueue(guildId, connection, message.channel, voiceChannel);
            }

            const isPlaylist = url.includes('list=');

            if (isPlaylist) {
                message.reply('⏳ Обробляю плейлист, зачекай секунду...');
                const entries = await fetchPlaylistEntries(url);
                if (entries.length === 0) {
                    return message.reply('❌ Не вдалося знайти треки в цьому плейлисті.');
                }
                queue.songs.push(...entries);
                message.channel.send(`📜 Додано в чергу **${entries.length}** треків з плейлиста.`);
            } else {
                const cleanUrl = url.split('&')[0];
                const wasEmpty = queue.songs.length === 0;

                if (!wasEmpty) {
                    message.reply('⏳ Додаю трек у чергу...');
                }

                const title = await fetchSingleTitle(cleanUrl);
                queue.songs.push({ url: cleanUrl, title });

                if (!wasEmpty) {
                    message.channel.send(`➕ Додано в чергу: **${title}**`);
                }
            }

            // Якщо це перший трек у черзі — починаємо відтворення
            if (queue.songs.length >= 1 && queue.player.state.status !== AudioPlayerStatus.Playing
                && queue.player.state.status !== AudioPlayerStatus.Paused) {
                playSong(guildId, queue.songs[0]);
            }
        } catch (error) {
            console.error('Помилка під час відтворення:', error);
            message.reply('❌ Виникла помилка під час спроби відтворити аудіо.');
        }
    }

    if (command === 'skip') {
        const queue = getQueue(guildId);
        if (!queue || queue.songs.length === 0) {
            return message.reply('❌ Зараз нічого не грає.');
        }
        message.reply('⏭️ Пропускаю трек...');
        queue.player.stop(); // це викличе Idle -> playNext автоматично
    }

    if (command === 'pause') {
        const queue = getQueue(guildId);
        if (!queue || queue.player.state.status !== AudioPlayerStatus.Playing) {
            return message.reply('❌ Зараз нічого не грає.');
        }
        queue.player.pause();
        message.reply('⏸️ Пауза.');
    }

    if (command === 'queue') {
        const queue = getQueue(guildId);
        if (!queue || queue.songs.length === 0) {
            return message.reply('📭 Черга порожня.');
        }
        const list = queue.songs
            .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title}`)
            .slice(0, 15)
            .join('\n');
        message.reply(`📜 **Черга:**\n${list}`);
    }

    if (command === 'stop') {
        const queue = getQueue(guildId);
        if (queue) {
            queue.songs = [];
            queue.player.stop();
            if (queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                queue.connection.destroy();
            }
            queues.delete(guildId);
            message.reply('👋 Бувай! Відтворення зупинено.');
        }
    }
});

client.login(TOKEN);