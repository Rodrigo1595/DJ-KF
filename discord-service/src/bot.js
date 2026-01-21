require("dotenv").config();
const prism = require("prism-media");
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Events } = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection,
  StreamType,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
} = require("@discordjs/voice");

// =====================
// Discord Client
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Para comandos tipo !join
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// =====================
// Players cache
// =====================
const players = new Map(); // guildId -> AudioPlayer

function getOrCreatePlayer(guildId) {
  if (players.has(guildId)) return players.get(guildId);

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  players.set(guildId, player);
  return player;
}

// =====================
// Helpers
// =====================
function safeSoundPath(userInput) {
  // Permite: "tense/drama1.mp3"
  // Bloquea: "../" o rutas raras
  if (!userInput || userInput.includes("..") || userInput.includes("\\")) {
    return null;
  }

  const base = path.resolve(__dirname, "../../sounds");
  const target = path.resolve(base, userInput);

  if (!target.startsWith(base)) return null;
  if (!fs.existsSync(target)) return null;

  return target;
}

function computeRmsInt16LE(pcmBuffer) {
  // pcmBuffer = PCM 16-bit signed little endian
  // devuelve RMS normalizado 0..1 aprox
  let sumSquares = 0;
  const sampleCount = Math.floor(pcmBuffer.length / 2);

  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2); // -32768..32767
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }

  const mean = sumSquares / Math.max(sampleCount, 1);
  return Math.sqrt(mean);
}

// Para evitar duplicados de speaking start por usuario
const activeSpeakers = new Set(); // userId

// Para poder apagar listeners al desconectar (por guild)
const speakingListeners = new Map(); // guildId -> function

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot listo como ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const [cmd, arg] = message.content.trim().split(/\s+/, 2);
  const guild = message.guild;
  if (!guild) return;

  // =====================
  // !join
  // =====================
  if (cmd === "!join") {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply(
        "⚠️ Debes estar en un canal de voz para que yo me una.",
      );
    }

    const existing = getVoiceConnection(guild.id);
    if (existing) {
      return message.reply("⚠️ Ya estoy conectado. Usa `!disconnect` primero.");
    }

    // Conexión a voz (DAVE off para evitar decrypt issues en MVP)
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      daveEncryption: false,
    });

    try {
      // ✅ Esperar READY antes de usar receiver/subscribe
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      console.error("❌ No se pudo entrar a VoiceConnection READY:", err);
      connection.destroy();
      return message.reply("❌ No pude conectarme al canal de voz (timeout).");
    }

    // Player asociado a la guild
    const player = getOrCreatePlayer(guild.id);
    connection.subscribe(player);

    // Receiver: escuchar usuarios
    const receiver = connection.receiver;

    // Listener speaking start (guardado para cleanup)
    const onSpeakingStart = (userId) => {
      // Evita duplicar streams por el mismo usuario
      if (activeSpeakers.has(userId)) return;
      activeSpeakers.add(userId);

      const user = guild.members.cache.get(userId)?.user;
      console.log(`🎤 Hablando: ${user?.username ?? userId}`);

      const audioStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1000, // corta cuando hay 1s de silencio
        },
      });

      let bytes = 0;
      let startedAt = Date.now();

      // decoder Opus -> PCM (16-bit signed)
      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960, // 20ms a 48kHz (recomendado)
      });

      const pcmStream = audioStream.pipe(decoder);

      let rmsAccum = 0;
      let rmsCount = 0;

      pcmStream.on("data", (pcmChunk) => {
        // pcmChunk = Buffer PCM S16LE (stereo)
        const rms = computeRmsInt16LE(pcmChunk);
        rmsAccum += rms;
        rmsCount++;

        const elapsed = (Date.now() - startedAt) / 1000;
        if (elapsed >= 1) {
          const avgRms = rmsCount > 0 ? rmsAccum / rmsCount : 0;
          console.log(`   ↳ RMS: ${avgRms.toFixed(4)}`);
          // reset por segundo
          rmsAccum = 0;
          rmsCount = 0;
          startedAt = Date.now();
        }
      });

      pcmStream.on("error", (err) => {
        console.error("PCM stream error:", err);
      });

      audioStream.on("end", () => {
        console.log(`🛑 Terminó de hablar: ${user?.username ?? userId}`);
        activeSpeakers.delete(userId);

        try {
          decoder.destroy();
        } catch (_) {}
      });

      audioStream.on("error", (err) => {
        console.error("Receiver stream error:", err);
        activeSpeakers.delete(userId);
        try {
          decoder.destroy();
        } catch (_) {}
      });
    };

    // Registrar listener
    receiver.speaking.on("start", onSpeakingStart);
    speakingListeners.set(guild.id, onSpeakingStart);

    return message.reply(`✅ Conectado a **${voiceChannel.name}**`);
  }

  // =====================
  // !leave / !disconnect
  // =====================
  if (cmd === "!leave" || cmd === "!disconnect") {
    const conn = getVoiceConnection(guild.id);
    if (!conn) return message.reply("⚠️ No estoy conectado a ningún canal.");

    // Cleanup listeners
    const listener = speakingListeners.get(guild.id);
    if (listener) {
      try {
        conn.receiver?.speaking?.off("start", listener);
      } catch (_) {
        // no-op
      }
      speakingListeners.delete(guild.id);
    }

    // Limpieza de speakers activos
    activeSpeakers.clear();

    // Desconectar
    conn.destroy();

    // Liberar player del cache (opcional, pero deja todo limpio)
    players.delete(guild.id);

    return message.reply("✅ Me desconecté del canal de voz.");
  }

  // =====================
  // !play tense/drama1.mp3
  // =====================
  if (cmd === "!play") {
    const conn = getVoiceConnection(guild.id);
    if (!conn) {
      return message.reply("⚠️ Primero usa `!join` para que me conecte.");
    }

    const filePath = safeSoundPath(arg);
    if (!filePath) {
      return message.reply(
        "⚠️ Archivo inválido o no existe. Ej: `!play tense/drama1.mp3`",
      );
    }

    const player = getOrCreatePlayer(guild.id);

    const resource = createAudioResource(fs.createReadStream(filePath), {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });

    // volumen inicial (0.0 a 1.0)
    resource.volume?.setVolume(0.9);

    player.play(resource);

    player.once(AudioPlayerStatus.Playing, () => {
      console.log("▶️ Reproduciendo:", filePath);
    });

    player.once(AudioPlayerStatus.Idle, () => {
      console.log("⏹️ Terminado:", filePath);
    });

    return message.reply(`🎧 Reproduciendo: **${arg}**`);
  }
});

// =====================
// Login
// =====================
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("❌ Falta DISCORD_TOKEN en el archivo .env");
  process.exit(1);
}

client.login(token);
