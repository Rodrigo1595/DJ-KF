require("dotenv").config();
const prism = require("prism-media");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
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
// Paths
// ======================================================
// DJ-KIUT/sounds  => ../../sounds (desde discord-service/src/bot.js)
const SOUNDS_BASE_DIR = path.resolve(__dirname, "../../sounds");

// Temp para WAV chunks (dentro de discord-service/)
const TMP_DIR = path.resolve(__dirname, "../tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Python STT (discord-service/python/stt.py)
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const STT_SCRIPT = path.resolve(__dirname, "../python/stt.py");

// ======================================================
// STT settings
// ======================================================
const STT = {
  enabled: true,
  // Analiza cada ~2.5s mientras alguien habla (más rápido = más CPU)
  maxChunkMs: 2500,
  // Anti-spam por usuario
  cooldownMs: 3000,
  // mínimo antes de analizar (1.2s recomendado)
  minAudioMs: 1200,
  // timeout del proceso python
  timeoutMs: 15000,
};

// userId -> lastSttTs
const sttCooldownByUser = new Map();
// guildId -> boolean (evita 10 procesos python en paralelo)
const sttBusyByGuild = new Map();

// ======================================================
// Discord Client
// ======================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ======================================================
// Players cache
// ======================================================
const players = new Map(); // guildId -> AudioPlayer

function getOrCreatePlayer(guildId) {
  if (players.has(guildId)) return players.get(guildId);

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  players.set(guildId, player);
  return player;
}

// ======================================================
// Helpers
// ======================================================
function safeSoundPath(userInput) {
  if (!userInput || userInput.includes("..") || userInput.includes("\\"))
    return null;

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

// WAV writer: PCM 48kHz, 16-bit, stereo
function writeWav16LE(filePath, pcmBuffer, sampleRate = 48000, channels = 2) {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);

  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

function runSttOnWav(wavPath, timeoutMs = STT.timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, [STT_SCRIPT, wavPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (_) {}
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", () => {
      clearTimeout(killTimer);

      if (!stdout.trim()) {
        if (stderr.trim()) console.log("⚠️ STT stderr:", stderr.trim());
        return resolve(null);
      }

      try {
        const json = JSON.parse(stdout.trim());
        resolve(json);
      } catch (e) {
        console.log("⚠️ STT parse error:", e.message);
        console.log("⚠️ STT raw stdout:", stdout);
        resolve(null);
      }
    });
  });
}

// ======================================================
// ✅ SOUND_PACKS dinámico (lee /sounds/mood/*)
// ======================================================
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

    const moodKey = folder.toUpperCase();
    packs[moodKey] = files.map((file) => `mood/${folder}/${file}`);
  }

  console.log("📦 SOUND_PACKS cargados desde:", moodDir);
  for (const [k, arr] of Object.entries(packs)) {
    console.log(`   - ${k}: ${arr.length} sonidos`);
  }

  return packs;
}

const SOUND_PACKS = loadSoundPacks();

// ======================================================
// Voice capture + chunk recorder state
// ======================================================

const userStreams = new Map();
const endTimers = new Map();
const speakingListeners = new Map();

// ======================================================
// AutoDJ + Anti-Spam Engine
// ======================================================
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
  if (mood === "STOP") return { ok: false, reason: "STOP is manual only" };

  const enabled = autoDjEnabled.get(guildId) ?? true;
  if (!enabled) return { ok: false, reason: "AutoDJ OFF" };

  const conn = getVoiceConnection(guildId);
  if (!conn) return { ok: false, reason: "No voice connection" };

  const player = getOrCreatePlayer(guildId);
  if (player.state?.status === AudioPlayerStatus.Playing) {
    return { ok: false, reason: "Player busy" };
  }

  const now = Date.now();

  const lastVoiceAt = moodState?.lastVoiceAt ?? 0;
  if (now - lastVoiceAt < AUTO_DJ.minSilenceMs) {
    return { ok: false, reason: "Not enough silence" };
  }

  const lastG = lastGlobalPlayAt.get(guildId) ?? 0;
  if (now - lastG < AUTO_DJ.globalCooldownMs) {
    return { ok: false, reason: "Global cooldown" };
  }

  const key = `${guildId}:${mood}`;
  const lastM = lastMoodPlayAt.get(key) ?? 0;
  if (now - lastM < AUTO_DJ.perMoodCooldownMs) {
    return { ok: false, reason: "Mood cooldown" };
  }

  if (moodState && moodState.emaEnergy < AUTO_DJ.minEnergyToReact) {
    if (mood !== "CALM") return { ok: false, reason: "Energy too low" };
  }

  return { ok: true };
}

function playSoundAuto(guildId, relativePath, volume = AUTO_DJ.volume) {
  const conn = getVoiceConnection(guildId);
  if (!conn) return false;

  const filePath = safeSoundPath(relativePath);
  if (!filePath) {
    console.log("⚠️ Sound missing/invalid:", relativePath);
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
    console.log(`🤖🎧 PLAY: ${relativePath}`);
  });

  player.once(AudioPlayerStatus.Idle, () => {
    console.log(`🤖⏹️ END: ${relativePath}`);
  });

  return true;
}

async function stopNow(guildId) {
  const player = getOrCreatePlayer(guildId);
  try {
    player.stop(true);
  } catch (_) {}

  const pack = SOUND_PACKS["STOP"] ?? [];
  const stopSound = pickRandom(pack);
  if (stopSound) playSoundAuto(guildId, stopSound, 0.9);
}

// ======================================================
// Mood Analyzer (Acústico base)
// ======================================================
const moodStateByGuild = new Map();

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

function classifyMood(voiceRatio, energy, burstPerSec) {
  if (energy < 0.004) return "CALM";
  if (voiceRatio > 0.55 && burstPerSec > 2.2) return "CHAOS";
  if (voiceRatio > 0.5 && energy > 0.05) return "HYPE";
  if (voiceRatio < 0.35 && energy > 0.04) return "TENSE";
  return "NORMAL";
}

function startMoodLoop(guildId) {
  if (moodStateByGuild.has(guildId)) return;

  const state = createMoodState(guildId);
  moodStateByGuild.set(guildId, state);

  state.intervalId = setInterval(() => {
    const now = Date.now();

    let activeCount = 0;
    let energySum = 0;
    const VOICE_RMS_MIN = 0.0035;

    for (const [, u] of userStreams) {
      if (u.guildId !== guildId) continue;
      if (u.lastRms && u.lastRms > VOICE_RMS_MIN) {
        activeCount++;
        energySum += u.lastRms;
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
    const voiceTicks = state.history.reduce(
      (acc, x) => acc + (x.hasVoice ? 1 : 0),
      0,
    );
    const voiceRatio = voiceTicks / n;

    const energyAvg = state.history.reduce((acc, x) => acc + x.energy, 0) / n;

    const startsTotal = state.history.reduce((acc, x) => acc + x.starts, 0);
    const burstPerSec = startsTotal / (state.windowMs / 1000);

    const alpha = 0.25;
    state.emaEnergy = alpha * energyAvg + (1 - alpha) * state.emaEnergy;
    state.emaVoice = alpha * voiceRatio + (1 - alpha) * state.emaVoice;

    const candidate = classifyMood(
      state.emaVoice,
      state.emaEnergy,
      burstPerSec,
    );

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
          )} energy=${state.emaEnergy.toFixed(3)} burst=${burstPerSec.toFixed(1)})`,
        );

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

    if (now - state.lastLogAt >= 2000) {
      state.lastLogAt = now;
      console.log(
        `📈 Mood: ${state.confirmedMood} (voice_ratio=${state.emaVoice.toFixed(
          2,
        )} energy=${state.emaEnergy.toFixed(3)} burst=${burstPerSec.toFixed(1)})`,
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

// ======================================================
// STT-driven ACTIONS
// ======================================================
async function handleSttResult(guildId, username, sttJson) {
  if (!sttJson) return;

  const intent = (sttJson.intent || "").toUpperCase();
  const mood = (sttJson.mood || "").toUpperCase();
  const confidence = Number(sttJson.confidence ?? 0);
  const text = sttJson.text || "";

  if (text.trim()) {
    console.log(
      `📝 STT (${username}): "${text}" (intent=${intent} mood=${mood} conf=${confidence.toFixed(
        2,
      )})`,
    );
  }

  if (intent === "STOP" && confidence >= 0.65) {
    console.log("🛑 Intent STOP detectado por VOZ");
    await stopNow(guildId);
    return;
  }

  if (mood && confidence >= 0.7 && SOUND_PACKS[mood]?.length) {
    const moodState = moodStateByGuild.get(guildId);
    const check = canAutoPlay(guildId, mood, moodState);

    if (check.ok) {
      const sound = pickRandom(SOUND_PACKS[mood]);
      if (sound) {
        const ok = playSoundAuto(guildId, sound, AUTO_DJ.volume);
        if (ok) {
          const now = Date.now();
          lastGlobalPlayAt.set(guildId, now);
          lastMoodPlayAt.set(`${guildId}:${mood}`, now);
        }
      }
    }
  }
}

// ======================================================
// STT chunk execution (while speaking)
// ======================================================
async function maybeRunSttChunk(userId, state) {
  if (!STT.enabled) return;
  if (!state) return;

  const now = Date.now();
  const elapsedMs = now - state.chunkStartedAt;

  if (elapsedMs < STT.minAudioMs) return;

  const last = sttCooldownByUser.get(userId) ?? 0;
  if (now - last < STT.cooldownMs) return;

  if (sttBusyByGuild.get(state.guildId)) return;

  // 1.2s stereo 48kHz 16-bit ~= 230k bytes
  const MIN_BYTES = 150_000;
  if (state.chunkBytes < MIN_BYTES) return;

  const pcmBuffer = Buffer.concat(state.pcmChunks);

  // reset antes (para no perder audio si python se demora)
  state.pcmChunks = [];
  state.chunkBytes = 0;
  state.chunkStartedAt = now;

  const wavPath = path.join(TMP_DIR, `${state.guildId}_${userId}_${Date.now()}.wav`);

  try {
    writeWav16LE(wavPath, pcmBuffer, 48000, 2);

    sttCooldownByUser.set(userId, now);
    sttBusyByGuild.set(state.guildId, true);

    const sttJson = await runSttOnWav(wavPath);

    try {
      fs.unlinkSync(wavPath);
    } catch (_) {}

    await handleSttResult(state.guildId, state.username, sttJson);
  } catch (err) {
    console.log("⚠️ STT chunk error:", err?.message || err);
    try {
      fs.unlinkSync(wavPath);
    } catch (_) {}
  } finally {
    sttBusyByGuild.set(state.guildId, false);
  }
}

// ======================================================
// Ready
// ======================================================
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot listo como ${client.user.tag}`);
  console.log(`🔊 Sounds base: ${SOUNDS_BASE_DIR}`);
  console.log(`🧠 STT: ${PYTHON_BIN} ${STT_SCRIPT}`);
  console.log(`🎙️ Temp WAV: ${TMP_DIR}`);
});

// ======================================================
// Commands
// ======================================================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const guild = message.guild;
  if (!guild) return;

  const contentLower = message.content.toLowerCase();
  const [cmd, arg] = message.content.trim().split(/\s+/, 2);

  // STOP por chat
  if (cmd === "!stop" || contentLower.includes("callate maldito bot")) {
    stopNow(guild.id);
    return message.reply("😶‍🌫️ ok... me callo.");
  }

  // packs
  if (cmd === "!packs") {
    const lines = Object.entries(SOUND_PACKS).map(
      ([k, v]) => `• ${k}: ${v.length}`,
    );
    return message.reply("📦 Packs detectados:\n" + lines.join("\n"));
  }

  // autodj
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

  // join
  if (cmd === "!join") {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel)
      return message.reply(
        "⚠️ Debes estar en un canal de voz para que yo me una.",
      );

    const existing = getVoiceConnection(guild.id);
    if (existing)
      return message.reply("⚠️ Ya estoy conectado. Usa `!disconnect` primero.");

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
        username,
        lastRms: 0,
        pcmChunks: [],
        chunkStartedAt: Date.now(),
        chunkBytes: 0,
      };

      userStreams.set(userId, state);

      pcmStream.on("data", (pcmChunk) => {
        const rms = computeRmsInt16LE(pcmChunk);
        state.lastRms = rms;

        state.pcmChunks.push(pcmChunk);
        state.chunkBytes += pcmChunk.length;

        const elapsed = Date.now() - state.chunkStartedAt;
        if (elapsed >= STT.maxChunkMs) {
          // Dispara análisis en vivo (sin bloquear el stream)
          maybeRunSttChunk(userId, state);
        }
      });

      pcmStream.on("error", (err) => console.error("PCM stream error:", err));
      audioStream.on("error", (err) =>
        console.error("Receiver stream error:", err),
      );
    };

    const onSpeakingEnd = (userId) => {
      const t = setTimeout(async () => {
        const state = userStreams.get(userId);
        if (!state) return;

        console.log(`🛑 Terminó de hablar: ${state.username}`);

        // Último intento STT con lo pendiente
        try {
          await maybeRunSttChunk(userId, state);
        } catch (_) {}

        try {
          state.pcmStream?.destroy();
        } catch (_) {}
        try {
          state.decoder?.destroy();
        } catch (_) {}
        try {
          state.audioStream?.destroy();
        } catch (_) {}

        userStreams.delete(userId);
        endTimers.delete(userId);
      }, 350);

      endTimers.set(userId, t);
    };

    receiver.speaking.on("start", onSpeakingStart);
    receiver.speaking.on("end", onSpeakingEnd);
    speakingListeners.set(guild.id, { onStart: onSpeakingStart, onEnd: onSpeakingEnd });

    startMoodLoop(guild.id);

    return message.reply(`✅ Conectado a **${voiceChannel.name}**`);
  }

  // leave
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
      try {
        clearTimeout(t);
      } catch (_) {}
    }
    endTimers.clear();

    for (const [userId, state] of userStreams) {
      if (state.guildId !== guild.id) continue;
      try {
        state.pcmStream?.destroy();
      } catch (_) {}
      try {
        state.decoder?.destroy();
      } catch (_) {}
      try {
        state.audioStream?.destroy();
      } catch (_) {}
      userStreams.delete(userId);
    }

    try {
      stopNow(guild.id);
      const player = getOrCreatePlayer(guild.id);
      await entersState(player, AudioPlayerStatus.Idle, 5000);
    } catch (_) {}

    conn.destroy();
    players.delete(guild.id);

    return message.reply("✅ Me desconecté del canal de voz.");
  }

  // play manual
  if (cmd === "!play") {
    const conn = getVoiceConnection(guild.id);
    if (!conn)
      return message.reply("⚠️ Primero usa `!join` para que me conecte.");

    const filePath = safeSoundPath(arg);
    if (!filePath) {
      return message.reply(
        "⚠️ Archivo inválido o no existe. Ej: `!play mood/tense/suspense1.mp3`",
      );
    }

    const player = getOrCreatePlayer(guild.id);

    const resource = createAudioResource(fs.createReadStream(filePath), {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });

    resource.volume?.setVolume(0.9);
    player.play(resource);

    player.once(AudioPlayerStatus.Playing, () =>
      console.log("▶️ Reproduciendo:", filePath),
    );
    player.once(AudioPlayerStatus.Idle, () =>
      console.log("⏹️ Terminado:", filePath),
    );

    return message.reply(`🎧 Reproduciendo: **${arg}**`);
  }
});

// ======================================================
// Login
// ======================================================
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("❌ Falta DISCORD_TOKEN en el archivo .env");
  process.exit(1);
}

client.login(token);
