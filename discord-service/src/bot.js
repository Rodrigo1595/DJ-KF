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

// ======================================================
// ✅ RUTA REAL A /sounds (desde discord-service/src/bot.js)
// ======================================================
const SOUNDS_BASE_DIR = path.resolve(__dirname, "../../sounds");

// =====================
// Discord Client
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  players.set(guildId, player);
  return player;
}

// =====================
// Helpers
// =====================
function safeSoundPath(userInput) {
  // Bloquea traversal o rutas raras
  if (!userInput || userInput.includes("..") || userInput.includes("\\")) return null;

  const base = SOUNDS_BASE_DIR;
  const target = path.resolve(base, userInput);

  if (!target.startsWith(base)) return null;
  if (!fs.existsSync(target)) return null;

  return target;
}

function computeRmsInt16LE(pcmBuffer) {
  let sumSquares = 0;
  const sampleCount = Math.floor(pcmBuffer.length / 2);

  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }

  const mean = sumSquares / Math.max(sampleCount, 1);
  return Math.sqrt(mean);
}

function pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// =====================
// ✅ SOUND_PACKS dinámico (lee /sounds/mood/*)
// =====================
function loadSoundPacks() {
  const moodDir = path.join(SOUNDS_BASE_DIR, "mood");
  const packs = {};

  if (!fs.existsSync(moodDir)) {
    console.log("⚠️ No existe carpeta mood:", moodDir);
    return packs;
  }

  const folders = fs
    .readdirSync(moodDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const allowedExt = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a"]);

  for (const folder of folders) {
    const absFolder = path.join(moodDir, folder);

    const files = fs
      .readdirSync(absFolder, { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => f.name)
      .filter((name) => allowedExt.has(path.extname(name).toLowerCase()));

    const moodKey = folder.toUpperCase(); // calm -> CALM
    packs[moodKey] = files.map((file) => `mood/${folder}/${file}`);
  }

  console.log("📦 SOUND_PACKS cargados desde:", moodDir);
  for (const [k, arr] of Object.entries(packs)) {
    console.log(`   - ${k}: ${arr.length} sonidos`);
  }

  return packs;
}

const SOUND_PACKS = loadSoundPacks();

// =====================
// Voice capture state
// =====================
/**
 * userStreams: userId -> {
 *   guildId,
 *   audioStream, decoder, pcmStream,
 *   startedAt, rmsAccum, rmsCount,
 *   username, lastRms,
 *   lastPcmAt, rmsEma
 * }
 */
const userStreams = new Map();
const endTimers = new Map(); // userId -> Timeout
const speakingListeners = new Map(); // guildId -> { onStart, onEnd }

// =====================
// Paso 5: AutoDJ + Anti-Spam Engine
// =====================
const autoDjEnabled = new Map(); // guildId -> boolean
const lastGlobalPlayAt = new Map(); // guildId -> timestamp
const lastMoodPlayAt = new Map(); // `${guildId}:${mood}` -> timestamp

const AUTO_DJ = {
  globalCooldownMs: 12_000,
  perMoodCooldownMs: 22_000,
  minSilenceMs: 900,
  minEnergyToReact: 0.012,
  volume: 0.85,
};

function canAutoPlay(guildId, mood, moodState) {
  // 0) STOP jamás debe “autodispararse”
  if (mood === "STOP") return { ok: false, reason: "STOP is manual only" };

  // 1) AutoDJ habilitado?
  const enabled = autoDjEnabled.get(guildId) ?? true;
  if (!enabled) return { ok: false, reason: "AutoDJ OFF" };

  // 2) conexión
  const conn = getVoiceConnection(guildId);
  if (!conn) return { ok: false, reason: "No voice connection" };

  // 3) player libre?
  const player = getOrCreatePlayer(guildId);
  if (player.state?.status === AudioPlayerStatus.Playing) {
    return { ok: false, reason: "Player busy" };
  }

  const now = Date.now();

  // 4) silencio mínimo
  const lastVoiceAt = moodState?.lastVoiceAt ?? 0;
  if (now - lastVoiceAt < AUTO_DJ.minSilenceMs) {
    return { ok: false, reason: "Not enough silence" };
  }

  // 5) global cooldown
  const lastG = lastGlobalPlayAt.get(guildId) ?? 0;
  if (now - lastG < AUTO_DJ.globalCooldownMs) {
    return { ok: false, reason: "Global cooldown" };
  }

  // 6) per-mood cooldown
  const key = `${guildId}:${mood}`;
  const lastM = lastMoodPlayAt.get(key) ?? 0;
  if (now - lastM < AUTO_DJ.perMoodCooldownMs) {
    return { ok: false, reason: "Mood cooldown" };
  }

  // 7) energía mínima para reaccionar
  if (moodState && moodState.emaEnergy < AUTO_DJ.minEnergyToReact) {
    if (mood !== "CALM") {
      return { ok: false, reason: "Energy too low" };
    }
  }

  return { ok: true };
}

function playSoundAuto(guildId, relativePath, volume = AUTO_DJ.volume) {
  const conn = getVoiceConnection(guildId);
  if (!conn) return false;

  const filePath = safeSoundPath(relativePath);
  if (!filePath) {
    console.log("⚠️ AutoDJ sound missing/invalid:", relativePath);
    return false;
  }

  const player = getOrCreatePlayer(guildId);

  const resource = createAudioResource(fs.createReadStream(filePath), {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });

  resource.volume?.setVolume(volume);
  player.play(resource);

  player.once(AudioPlayerStatus.Playing, () => {
    console.log(`🤖🎧 AutoDJ PLAY: ${relativePath}`);
  });

  player.once(AudioPlayerStatus.Idle, () => {
    console.log(`🤖⏹️ AutoDJ END: ${relativePath}`);
  });

  return true;
}

// ✅ STOP inmediato: corta audio y (si existe) responde con pack STOP
async function stopNow(guildId) {
  const player = getOrCreatePlayer(guildId);
  try {
    player.stop(true);
  } catch (_) {}

  const pack = SOUND_PACKS["STOP"] ?? [];
  const stopSound = pickRandom(pack);
  if (stopSound) {
    playSoundAuto(guildId, stopSound, 0.9);
  }
}

// =====================
// Mood Analyzer
// =====================
const moodStateByGuild = new Map(); // guildId -> state

function createMoodState(guildId) {
  return {
    guildId,
    tickMs: 200,
    windowMs: 2000,
    stabilityMs: 3000,

    history: [],
    emaEnergy: 0,
    emaVoice: 0,
    startsInTick: 0,

    lastCandidateMood: "NORMAL",
    candidateSince: Date.now(),

    confirmedMood: "NORMAL",
    lastLogAt: 0,
    intervalId: null,

    lastVoiceAt: 0,
  };
}

/**
 * ✅ Mood Heuristics (mejoradas)
 * - CALM: poca voz o energía baja real
 * - SAD: habla suave sostenida (no cero) + pocas interrupciones
 * - CORNY: conversación liviana (energía media-baja) + burst moderado-bajo
 */
function classifyMood(voiceRatio, energy, burstPerSec) {
  // ✅ CALM: casi no hay voz o energía mínima real
  if (voiceRatio < 0.12 || energy < 0.006) return "CALM";

  // ✅ SAD: conversación suave sostenida
  if (
    voiceRatio >= 0.28 &&
    voiceRatio <= 0.75 &&
    energy >= 0.006 &&
    energy <= 0.016 &&
    burstPerSec <= 0.6
  ) {
    return "SAD";
  }

  // ✅ CORNY: conversación liviana / risas suaves, sin caos
  if (
    voiceRatio >= 0.22 &&
    voiceRatio <= 0.70 &&
    energy >= 0.016 &&
    energy <= 0.032 &&
    burstPerSec <= 1.1
  ) {
    return "CORNY";
  }

  // ✅ CHAOS: mucha conversación + interrupciones
  if (voiceRatio > 0.55 && burstPerSec > 2.2) return "CHAOS";

  // ✅ HYPE: mucha conversación + energía alta
  if (voiceRatio > 0.5 && energy > 0.05) return "HYPE";

  // ✅ TENSE: energía alta pero no todos hablando
  if (voiceRatio < 0.35 && energy > 0.04) return "TENSE";

  return "NORMAL";
}

function startMoodLoop(guildId) {
  if (moodStateByGuild.has(guildId)) return;

  const state = createMoodState(guildId);
  moodStateByGuild.set(guildId, state);

  state.intervalId = setInterval(() => {
    const now = Date.now();

    // ✅ voz: SOLO streams activos en ESTA guild + PCM reciente
    let activeCount = 0;
    let energySum = 0;

    const VOICE_RMS_MIN = 0.006; // ✅ más estricto
    const PCM_FRESH_MS = 450;    // ✅ si no hay PCM reciente, no cuenta

    for (const [, u] of userStreams) {
      // ✅ FIX: filtrar por guild
      if (u.guildId !== guildId) continue;

      // ✅ FIX: freshness de PCM (evita RMS viejo)
      const fresh = (now - (u.lastPcmAt ?? 0)) <= PCM_FRESH_MS;
      if (!fresh) continue;

      // ✅ FIX: usar rmsEma (suavizado) en vez de lastRms
      const e = u.rmsEma ?? 0;
      if (e > VOICE_RMS_MIN) {
        activeCount++;
        energySum += e;
      }
    }

    const hasVoice = activeCount > 0;
    if (hasVoice) state.lastVoiceAt = now;

    const energyInstant = activeCount > 0 ? energySum / activeCount : 0;

    state.history.push({
      hasVoice,
      energy: energyInstant,
      starts: state.startsInTick,
    });

    state.startsInTick = 0;

    const maxLen = Math.ceil(state.windowMs / state.tickMs);
    if (state.history.length > maxLen) state.history.shift();

    const n = state.history.length || 1;
    const voiceTicks = state.history.reduce((acc, x) => acc + (x.hasVoice ? 1 : 0), 0);
    const voiceRatio = voiceTicks / n;

    const energyAvg = state.history.reduce((acc, x) => acc + x.energy, 0) / n;

    const startsTotal = state.history.reduce((acc, x) => acc + x.starts, 0);
    const burstPerSec = startsTotal / (state.windowMs / 1000);

    // ✅ suavizado general
    const alpha = 0.25;
    state.emaEnergy = alpha * energyAvg + (1 - alpha) * state.emaEnergy;
    state.emaVoice = alpha * voiceRatio + (1 - alpha) * state.emaVoice;

    const candidate = classifyMood(state.emaVoice, state.emaEnergy, burstPerSec);

    // estabilidad
    if (candidate !== state.lastCandidateMood) {
      state.lastCandidateMood = candidate;
      state.candidateSince = now;
    } else {
      const stableFor = now - state.candidateSince;
      if (stableFor >= state.stabilityMs && state.confirmedMood !== candidate) {
        state.confirmedMood = candidate;

        console.log(
          `📊 Mood CONFIRMADO: ${candidate} (voice_ratio=${state.emaVoice.toFixed(
            2,
          )} energy=${state.emaEnergy.toFixed(4)} burst=${burstPerSec.toFixed(1)})`,
        );

        // AutoDJ: solo en cambios confirmados
        const pack = SOUND_PACKS[candidate] ?? [];
        const sound = pickRandom(pack);

        if (sound) {
          const check = canAutoPlay(guildId, candidate, state);
          if (check.ok) {
            const ok = playSoundAuto(guildId, sound, AUTO_DJ.volume);
            if (ok) {
              lastGlobalPlayAt.set(guildId, now);
              lastMoodPlayAt.set(`${guildId}:${candidate}`, now);
            }
          }
        }
      }
    }

    // log cada ~2s
    if (now - state.lastLogAt >= 2000) {
      state.lastLogAt = now;
      console.log(
        `📈 Mood: ${state.confirmedMood} (voice_ratio=${state.emaVoice.toFixed(
          2,
        )} energy=${state.emaEnergy.toFixed(4)} burst=${burstPerSec.toFixed(1)})`,
      );
    }
  }, state.tickMs);
}

function stopMoodLoop(guildId) {
  const state = moodStateByGuild.get(guildId);
  if (!state) return;

  if (state.intervalId) clearInterval(state.intervalId);
  moodStateByGuild.delete(guildId);
}

// =====================
// Ready
// =====================
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot listo como ${client.user.tag}`);
  console.log(`🔊 Sounds base: ${SOUNDS_BASE_DIR}`);
});

// =====================
// Commands
// =====================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const guild = message.guild;
  if (!guild) return;

  const contentLower = message.content.toLowerCase();
  const [cmd, arg] = message.content.trim().split(/\s+/, 2);

  // =====================
  // STOP por chat (texto) o comando
  // =====================
  if (cmd === "!stop" || contentLower.includes("callate maldito bot")) {
    stopNow(guild.id);
    return message.reply("😶‍🌫️ ok... me callo.");
  }

  // =====================
  // !packs
  // =====================
  if (cmd === "!packs") {
    const lines = Object.entries(SOUND_PACKS).map(([k, v]) => `• ${k}: ${v.length}`);
    return message.reply("📦 Packs detectados:\n" + lines.join("\n"));
  }

  // =====================
  // !autodj on/off
  // =====================
  if (cmd === "!autodj") {
    const value = (arg ?? "").toLowerCase();
    if (value !== "on" && value !== "off") {
      const current = autoDjEnabled.get(guild.id) ?? true;
      return message.reply(
        `🤖 AutoDJ está **${current ? "ON" : "OFF"}**. Usa: \`!autodj on\` o \`!autodj off\``,
      );
    }

    const enabled = value === "on";
    autoDjEnabled.set(guild.id, enabled);
    return message.reply(`✅ AutoDJ ahora está **${enabled ? "ON" : "OFF"}**`);
  }

  // =====================
  // !join
  // =====================
  if (cmd === "!join") {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply("⚠️ Debes estar en un canal de voz para que yo me una.");
    }

    const existing = getVoiceConnection(guild.id);
    if (existing) {
      return message.reply("⚠️ Ya estoy conectado. Usa `!disconnect` primero.");
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      daveEncryption: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      console.error("❌ No se pudo entrar a VoiceConnection READY:", err);
      connection.destroy();
      return message.reply("❌ No pude conectarme al canal de voz (timeout).");
    }

    const player = getOrCreatePlayer(guild.id);
    connection.subscribe(player);

    const receiver = connection.receiver;

    const onSpeakingStart = (userId) => {
      if (userStreams.has(userId)) return;

      const pending = endTimers.get(userId);
      if (pending) {
        clearTimeout(pending);
        endTimers.delete(userId);
      }

      const user = guild.members.cache.get(userId)?.user;
      const username = user?.username ?? userId;

      console.log(`🎤 Hablando: ${username}`);

      const mood = moodStateByGuild.get(guild.id);
      if (mood) mood.startsInTick++;

      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
      });

      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960,
      });

      const pcmStream = audioStream.pipe(decoder);

      const state = {
        guildId: guild.id,
        audioStream,
        decoder,
        pcmStream,

        startedAt: Date.now(),
        rmsAccum: 0,
        rmsCount: 0,
        lastRms: 0,

        // ✅ nuevos campos anti-falsos positivos
        lastPcmAt: 0,
        rmsEma: 0,

        username,
      };

      userStreams.set(userId, state);

      pcmStream.on("data", (pcmChunk) => {
        const rms = computeRmsInt16LE(pcmChunk);

        // ✅ FIX: freshness de PCM
        state.lastPcmAt = Date.now();

        // ✅ FIX: guardado RMS + suavizado por usuario
        state.lastRms = rms;
        const a = 0.35; // smoothing factor
        state.rmsEma = a * rms + (1 - a) * (state.rmsEma ?? 0);

        state.rmsAccum += rms;
        state.rmsCount++;

        const elapsed = (Date.now() - state.startedAt) / 1000;
        if (elapsed >= 1) {
          const avgRms = state.rmsCount > 0 ? state.rmsAccum / state.rmsCount : 0;

          // (solo debug)
          if (avgRms > 0.005) console.log(`   ↳ RMS(avg): ${avgRms.toFixed(4)} | EMA: ${state.rmsEma.toFixed(4)}`);

          state.rmsAccum = 0;
          state.rmsCount = 0;
          state.startedAt = Date.now();
        }
      });

      pcmStream.on("error", (err) => console.error("PCM stream error:", err));
      audioStream.on("error", (err) => console.error("Receiver stream error:", err));
    };

    const onSpeakingEnd = (userId) => {
      const t = setTimeout(() => {
        const state = userStreams.get(userId);
        if (!state) return;

        console.log(`🛑 Terminó de hablar: ${state.username}`);

        try { state.pcmStream?.destroy(); } catch (_) {}
        try { state.decoder?.destroy(); } catch (_) {}
        try { state.audioStream?.destroy(); } catch (_) {}

        userStreams.delete(userId);
        endTimers.delete(userId);
      }, 350);

      endTimers.set(userId, t);
    };

    receiver.speaking.on("start", onSpeakingStart);
    receiver.speaking.on("end", onSpeakingEnd);
    speakingListeners.set(guild.id, { onStart: onSpeakingStart, onEnd: onSpeakingEnd });

    // ✅ iniciar mood loop ya conectado
    startMoodLoop(guild.id);

    return message.reply(`✅ Conectado a **${voiceChannel.name}**`);
  }

  // =====================
  // !leave / !disconnect
  // =====================
  if (cmd === "!leave" || cmd === "!disconnect") {
    const conn = getVoiceConnection(guild.id);
    if (!conn) return message.reply("⚠️ No estoy conectado a ningún canal.");

    stopMoodLoop(guild.id);

    const handlers = speakingListeners.get(guild.id);
    if (handlers) {
      try {
        conn.receiver?.speaking?.off("start", handlers.onStart);
        conn.receiver?.speaking?.off("end", handlers.onEnd);
      } catch (_) {}
      speakingListeners.delete(guild.id);
    }

    for (const [, t] of endTimers) {
      try { clearTimeout(t); } catch (_) {}
    }
    endTimers.clear();

    // ✅ destruir streams SOLO de esta guild
    for (const [userId, state] of userStreams) {
      if (state.guildId !== guild.id) continue;

      try { state.pcmStream?.destroy(); } catch (_) {}
      try { state.decoder?.destroy(); } catch (_) {}
      try { state.audioStream?.destroy(); } catch (_) {}

      userStreams.delete(userId);
    }

    // Reproducir sonido STOP antes de desconectar y esperar hasta 5s máximo
    try {
      stopNow(guild.id);
      const player = getOrCreatePlayer(guild.id);
      await entersState(player, AudioPlayerStatus.Idle, 5000);
    } catch (err) {
      console.log("⚠️ Timeout o error esperando stop sound:", err);
    }

    conn.destroy();
    players.delete(guild.id);

    return message.reply("✅ Me desconecté del canal de voz.");
  }

  // =====================
  // !play mood/tense/xxx.mp3 (manual)
  // =====================
  if (cmd === "!play") {
    const conn = getVoiceConnection(guild.id);
    if (!conn) return message.reply("⚠️ Primero usa `!join` para que me conecte.");

    const filePath = safeSoundPath(arg);
    if (!filePath) {
      return message.reply("⚠️ Archivo inválido o no existe. Ej: `!play mood/tense/suspense1.mp3`");
    }

    const player = getOrCreatePlayer(guild.id);

    const resource = createAudioResource(fs.createReadStream(filePath), {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });

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
