require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');
const { StreamType } = require('@discordjs/voice');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const ytDlp = require('youtube-dl-exec'); // Підключаємо "важку артилерію"

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
            const ytDlpProcess = ytDlp.exec(cleanUrl, {
                output: '-', // Направляємо аудіопотік прямо в програму (stdout)
                quiet: true, // Відключаємо зайві текстові логи yt-dlp
                format: 'bestaudio[ext=webm]/bestaudio/best', // Беремо лише найкраще аудіо (без відео)
                noWarnings: true,
                preferFreeFormats: true,
            }, { stdio: ['ignore', 'pipe', 'ignore'] });

            if (!ytDlpProcess.stdout) {
                throw new Error('Не вдалося отримати потік від yt-dlp');
            }

            const ffmpegProcess = spawn(ffmpeg, [
                '-i', 'pipe:0',
                '-analyzeduration', '0',
                '-loglevel', '0',
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
                'pipe:1',
            ], {
                stdio: ['pipe', 'pipe', 'ignore'],
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