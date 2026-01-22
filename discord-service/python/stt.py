import sys
import json
import re
import unicodedata

from faster_whisper import WhisperModel

MODEL_SIZE = "base"
DEVICE = "cpu"
COMPUTE_TYPE = "int8"

# ============================
# Normalización (anti errores STT)
# ============================
def normalize_text(text: str) -> str:
    t = text.lower().strip()

    # quita tildes
    t = "".join(
        c for c in unicodedata.normalize("NFD", t)
        if unicodedata.category(c) != "Mn"
    )

    # deja solo letras/numeros/espacios
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


# ============================
# Patrones
# ============================

# STOP más tolerante a errores típicos
STOP_PATTERNS = [
    r"\bcallate\b",
    r"\bcalla\b",
    r"\bcaya\b",              # (whisper: “caya”)
    r"\bpara\b",
    r"\bstop\b",

    # combos típicos: maldito/malito + bot/vot
    r"\bmaldit[oa]\b.*\bbot\b",
    r"\bmalit[oa]\b.*\bbot\b",
    r"\bmaldit[oa]\b.*\bvot\b",
    r"\bmalit[oa]\b.*\bvot\b",
]

# SAD (ojo:solo frases comunes)
SAD_PATTERNS = [
    r"\bestoy triste\b",
    r"\bme siento mal\b",
    r"\bdepre\b",
    r"\bdeprimid",
    r"\bno tengo ganas\b",
]

CORNY_PATTERNS = [
    r"\bay\b",
    r"\buwu\b",
    r"\bque lindo\b",
    r"\bque tierno\b",
    r"\bmi amor\b",
    r"\bay si\b",
    r"\bgoggogoc\b",
]

HYPE_PATTERNS = [
    r"\bepico\b",
    r"\bbrutal\b",
    r"\bque buena\b",
    r"\bgo go\b",
    r"\bvamo\b",
    r"\blets go\b",
]

TENSE_PATTERNS = [
    r"\bque miedo\b",
    r"\bno me gusta\b",
    r"\bno confio\b",
    r"\bsospechoso\b",
]

# CHAOS (mala palabra + risas / gritos / spam)
# ✅ idea: detectar “ambiente tóxico/meme” sin que sea ultra sensible
SWEAR_WORDS = [

    r"\bwea\b", r"\bweas\b", r"\bhuea\b", r"\bhueas\b",
    r"\bweon\b", r"\bweones\b",
    r"\bctm\b", r"\bconchetumare\b",
    r"\bputa\b",
    r"\bculiao\b", r"\bculia(o|os|a|as)\b",
    r"\bchucha\b",
    r"\bmierda\b",
    r"\bcarajo\b",
    r"\b(cago|cagai|cagamo?s|cagaron|cagaste)\b",
    r"\bpendejo\b", r"\bpendeja\b",
    r"\bgil\b", r"\bgiles\b",
    r"\bmaricon\b", r"\bmaricona\b",
    r"\bfacho\b", r"\bfacha\b",
    r"\bimbecil\b", r"\bimbeciles\b",
    r"\bidiota\b", r"\bidiotas\b",
    r"\bestupido\b", r"\bestupida\b", r"\bestupidos\b", r"\bestupidas\b",
    r"\btonto\b", r"\btonta\b", r"\btontos\b", r"\btontas\b",
    

]

CHAOS_EXTRA = [
    r"\bjaja\b",
    r"\bjajaja\b",
    r"\blol\b",
    r"\bxd\b",
    r"\bgrita\b",
    r"\bcalla\b",  # a veces se gritan entre sí
]

JOYFUL_PATTERNS = [
    r"\bque buena\b",
    r"\bepico\b",
    r"\bbrutal\b",
    r"\bvamo\b",
    r"\blets go\b",
]

EVIL_PATTERNS = [
    r"\bmaldit[oa]\b",
    r"\bmalit[oa]\b",
    r"\bMUAJAJAJ\b",
    r"\bmuehehehe\b",
    r"\bmuajajaja\b",
    r"\bcallate\b",
    r"\bcalla\b",
    r"\bcaya\b",
    r"\btu mamita\b",    
]
    

def match_any(text: str, patterns) -> bool:
    for p in patterns:
        if re.search(p, text, flags=re.IGNORECASE):
            return True
    return False


def analyze_text(text: str):
    raw = text.strip()
    t = normalize_text(raw)

    # Debug opcional (te ayuda a entender qué entendió)
    print("TRANSCRIPCION_NORMALIZADA:", t, file=sys.stderr)

    # ============
    # STOP (prioridad máxima)
    # ============
    if match_any(t, STOP_PATTERNS):
        return {"intent": "STOP", "mood": "STOP", "confidence": 0.92, "text": raw}

    # ============
    # CHAOS
    # ============
    swear_hits = sum(1 for p in SWEAR_WORDS if re.search(p, t))
    chaos_hits = sum(1 for p in CHAOS_EXTRA if re.search(p, t))

    # ✅ regla razonable:
    # - 3 insultos, o
    # - 2 insultos + risas/spam
    if swear_hits >= 3 or (swear_hits >= 2 and chaos_hits >= 1):
        return {"intent": "MOOD", "mood": "CHAOS", "confidence": 0.80, "text": raw}

    # SAD
    if match_any(t, SAD_PATTERNS):
        return {"intent": "MOOD", "mood": "SAD", "confidence": 0.78, "text": raw}

    # CORNY
    if match_any(t, CORNY_PATTERNS):
        return {"intent": "MOOD", "mood": "CORNY", "confidence": 0.75, "text": raw}

    # HYPE
    if match_any(t, HYPE_PATTERNS):
        return {"intent": "MOOD", "mood": "HYPE", "confidence": 0.74, "text": raw}

    # TENSE
    if match_any(t, TENSE_PATTERNS):
        return {"intent": "MOOD", "mood": "TENSE", "confidence": 0.72, "text": raw}

    return {"intent": "NONE", "mood": "NONE", "confidence": 0.50, "text": raw}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"intent": "NONE", "mood": "NONE", "confidence": 0.0, "text": ""}))
        return

    audio_path = sys.argv[1]

    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)

    segments, info = model.transcribe(
        audio_path,
        vad_filter=True,
        beam_size=3,       # ✅ mejor que 1 para precisión
        language="es",
    )

    text = " ".join([s.text.strip() for s in segments]).strip()

    result = analyze_text(text)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
