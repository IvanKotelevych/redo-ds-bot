const { Client, GatewayIntentBits, Events } = require('discord.js');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');
const { StreamType } = require('@discordjs/voice');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');

// Створюємо клієнта бота
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '!';

client.once(Events.ClientReady, () => {
    console.log(`🤖 Бот успішно запущений як ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'play') {
        const url = args[0];
        
        if (!url) {
            return message.reply('❌ Будь ласка, вкажи посилання на YouTube відео після команди! Приклад: `!play URL`');
        }

        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.reply('❌ Тобі потрібно спочатку зайти в будь-який голосовий канал!');
        }

        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
            });

            message.reply('⏳ Завантажую аудіо через yt-dlp, зачекай секунду...');

            // Очищаємо посилання від плейлістів
            const cleanUrl = url.split('&')[0];

            // Запускаємо yt-dlp для прямого витягування потоку
            const ytDlpProcess = spawn('yt-dlp', [
                cleanUrl,
                '--output', '-',
                '--quiet',
                '--format', 'bestaudio[ext=webm]/bestaudio/best',
                '--no-warnings',
                '--prefer-free-formats',
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            ytDlpProcess.stderr.on('data', (data) => {
                console.error(`[yt-dlp stderr]: ${data}`);
            });

            ytDlpProcess.on('error', (err) => {
                console.error('[yt-dlp process error]:', err);
            });

            ytDlpProcess.on('close', (code) => {
                console.log(`[yt-dlp завершився з кодом]: ${code}`);
            });

            if (!ytDlpProcess.stdout) {
                throw new Error('Не вдалося отримати потік від yt-dlp');
            }

            const ffmpegProcess = spawn(ffmpeg, [
                '-i', 'pipe:0',
                '-analyzeduration', '0',
                '-loglevel', 'error',
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
                'pipe:1',
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            ffmpegProcess.stderr.on('data', (data) => {
                console.error(`[ffmpeg stderr]: ${data}`);
            });

            ffmpegProcess.on('close', (code) => {
                console.log(`[ffmpeg завершився з кодом]: ${code}`);
            });

            ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

            const resource = createAudioResource(ffmpegProcess.stdout, {
                inputType: StreamType.Raw, // бо це вже сирий PCM
            });
            const player = createAudioPlayer();

            player.play(resource);
            connection.subscribe(player);

            // Оповіщення, коли музика реально почне грати
            player.on(AudioPlayerStatus.Playing, () => {
                message.channel.send(`🎵 Відтворення розпочато!`);
            });

            player.on(AudioPlayerStatus.Idle, () => {
                console.log('[player]: перейшов у стан Idle — потік завершився або обірвався');
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            });

            player.on('error', error => {
                console.error(`Помилка плеєра: ${error.message}`);
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            });

        } catch (error) {
            console.error('Помилка під час відтворення:', error);
            message.reply('❌ Виникла помилка під час спроби відтворити аудіо.');
        }
    }

    if (command === 'stop') {
        const connection = joinVoiceChannel({
            channelId: message.member.voice.channel?.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
        });
        
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
            connection.destroy();
            message.reply('👋 Бувай! Відтворення зупинено.');
        }
    }
});

client.login(TOKEN);