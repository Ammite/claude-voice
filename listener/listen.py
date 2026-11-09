"""Wake-word voice input for Claude Code Desktop.

Listens on the mic; after the wake phrase ("Клод приём") records a message
until the end word ("приём"; a long silence as fallback), transcribes it with faster-whisper and prints one JSON line to
stdout per utterance: {"text": "...", "submit": bool}. Status lines look
like {"status": "..."}; logs go to stderr.

  python listen.py              # run
  python listen.py --levels     # print mic RMS levels to tune energy_threshold
  python listen.py --wav f.wav  # run the pipeline on a 16 kHz mono wav (no mic)
  python listen.py --selftest   # check the text rules
  python listen.py --say "Hi"   # speak a line with the reply voice (Kokoro)

The mod writes a reply's spoken line to listener/say; the mic loop speaks it
(wake word off meanwhile, so the speaker does not trigger it).
"""
import json
import os
import queue
import re
import socket
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
RATE = 16000
BLOCK = 1600  # 0.1 s
STOP_BLOCKS = 3  # the stop phrase in this many partial results in a row counts as said

DEFAULTS = {
    "wake_phrase": "клод приём",  # words must be in the Vosk vocabulary (it spells ё)
    "text_phrase": "клод текст",  # like the wake phrase, but the message is only inserted, never sent
    "stop_phrase": "клод стоп",  # interrupts Claude's running turn at once, no end word needed
    "cancel_word": "отмена",  # a pause after this word throws the recording away
    "end_word": "приём",  # the message is recorded until this word, however long the pauses
    "submit_on_end": True,  # the end word also sends; False: insert only, send with submit_word
    "submit_word": "отправь",  # with submit_on_end false: "…, отправь, приём" sends
    "vosk_model": "models/vosk-model-small-ru-0.22",
    "whisper_model": "models/faster-whisper-small",
    "language": "ru",  # "ru", "en" or "auto"
    "whisper_device": "auto",  # "auto" (GPU if it works, else CPU), "cuda" or "cpu"
    "beam_size": 5,  # 1 is faster, 5 makes fewer gross mistakes
    # Words you say often: whisper leans toward them. Not the end word: on near
    # silence whisper may echo the prompt, and an echoed "приём" would send.
    "whisper_prompt": "Claude. Сессия, мод, коммит, ветка, тест, воспроизведение, распознавание.",
    "energy_threshold": 500,  # only for --levels
    "end_guard_sec": 0.8,  # ignore the end word this long after the trigger (tail of the wake phrase)
    "start_timeout_sec": 8,  # no speech at all this long after the wake phrase: cancel
    "max_sec": 300,  # hard cap without the end word: the text is inserted, not sent
    "preroll_sec": 1.0,  # audio before the trigger kept (the phrase often starts with the wake word)
    "beep": True,
    "toast": True,
    "device": None,  # mic index or name; None = default
    "lock_port": 47821,
    "speak": True,  # speak the reply's 🔊 line (the mod asks Claude for one on voice prompts)
    "voice": "bf_emma",  # a Kokoro voice: bf_/bm_ British, af_/am_ American
    "speed": 1.0,
    "kokoro_model": "models/kokoro/kokoro-v1.0.onnx",
    "kokoro_voices": "models/kokoro/voices-v1.0.bin",
    # Voice goes to the session Claude Desktop shows, read from its log; null = its default place.
    "follow_desktop": True,
    "desktop_log": None,
}

PUNCT = r"[\s,.!?:;-]*"
NUMBERS = "один два три четыре пять шесть семь восемь девять".split()


def command_phrases():
    """Voice commands after "клод" (no end word): phrase -> the line emitted to the mod.
    Every word must be in the Vosk vocabulary."""
    out = {"клод какая сессия": {"cmd": "which"}, "клод сотри": {"cmd": "clear"}, "клод повтори": {"cmd": "repeat"}}
    for n, word in enumerate(NUMBERS, 1):
        out[f"клод сессия {word}"] = out[f"клод перейди на сессию {word}"] = {"cmd": "session", "n": n}
    return out


def word_re(word):
    """A config word as a regex that takes е for ё and for и: whisper writes
    "приём" as "прием" or "преем"."""
    return r"\b" + re.escape(word.lower()).replace("ё", "[её]").replace("и", "[ие]") + r"\b"


def speech_pieces(text, min_len=25):
    """Split a line to speak at commas and sentence ends, each piece at least
    `min_len` long (short ones join the next): the first piece plays while the
    next is synthesized."""
    out = []
    for part in re.split(r"(?<=[,.;:!?])\s+", text.strip()):
        if out and len(out[-1]) < min_len:
            out[-1] += " " + part
        else:
            out.append(part)
    return [p for p in out if p]


# Leading "Клод" as whisper may spell it, stripped from the transcript; the
# rest of the wake phrase ("приём") is stripped by clean().
WAKE_PREFIX = re.compile(r"^\s*(клод|клот|клоуд|клауд|клод[ауе]|claude|clod|claud)\b" + PUNCT, re.I)
# What may follow "Клод" in the preroll of «Клод, текст»: stripped like "приём".
TEXT_PREFIX = re.compile(r"^\s*(текст|text)\b" + PUNCT, re.I)


def log(*a):
    print(*a, file=sys.stderr, flush=True)
    if LOG_FILE:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            print(time.strftime("%H:%M:%S"), *a, file=f)


LOG_FILE = None  # set by the mic run: listener/listen.log, readable while Claude runs us


def emit(obj):
    print(json.dumps(obj, ensure_ascii=True), flush=True)


CMD_FILE = HERE / "cmd"  # the mod writes "dictate" or "stop" here (its band's buttons)
SAY_FILE = HERE / "say"  # the mod writes a reply's spoken line here


def take(path):
    """Read and remove a file the mod left, or None."""
    try:
        text = path.read_text(encoding="utf-8").strip()
        path.unlink()
        return text
    except OSError:
        return None


def take_cmd():
    return take(CMD_FILE)


SESSIONS = HERE / "sessions"  # the mod's registry (see mod/hooks/register.tsx)
# Claude Desktop's log is the only place that says which session is on screen.
# ponytail: undocumented lines; if a Desktop update changes them, voice falls back
# to the mic's session (the mod's default) and nothing else breaks.
DESKTOP_MAP = re.compile(r"Mapping internal session (local_[\w-]+) to CLI session ([\w-]+)")
DESKTOP_FOCUS = re.compile(r"setFocusedSession: sessionId=(local_[\w-]+)")


def scan_desktop_log(lines, ids, focused=None):
    """Read Claude Desktop's log lines: fill `ids` {Desktop id: CLI session id}
    and return the session last put on screen (its Desktop id), else `focused`.
    "sessionId=null" (between two sessions, the window hidden) keeps the last one."""
    for line in lines:
        m = DESKTOP_MAP.search(line)
        if m:
            ids[m[1]] = m[2]
            continue
        m = DESKTOP_FOCUS.search(line)
        if m:
            focused = m[1]
    return focused


def follow_desktop(path, reg=SESSIONS):
    """Keep reg/focused = the CLI id of the session Desktop shows, and
    reg/desktop-ids.json = {CLI id: Desktop id} (the mod opens a session by it).
    Putting another session on screen drops the pane's choice (reg/target), so
    voice follows the screen until the next choice."""
    ids, focused, shown, written, pos, live = {}, None, None, None, 0, False
    while True:
        try:
            size = path.stat().st_size
            if size < pos:  # the log rotated (main.log -> main1.log at 10 MB)
                pos = 0
            if size > pos:
                with open(path, "rb") as f:
                    f.seek(pos)
                    data = f.read()
                end = data.rfind(b"\n") + 1  # whole lines only; the rest waits for its end
                pos += end
                known = len(ids)
                focused = scan_desktop_log(data[:end].decode("utf-8", "replace").splitlines(), ids, focused)
                if len(ids) != known:
                    (reg / "desktop-ids.json").write_text(json.dumps({c: d for d, c in ids.items()}), encoding="utf-8")
            if live and focused != shown and ids.get(focused):
                target = reg / "target"
                if target.exists() and target.read_text(encoding="utf-8").strip() not in ("", ids[focused]):
                    target.write_text("", encoding="utf-8")
            if ids.get(focused):
                shown = focused
            cli = ids.get(focused)
            if cli and cli != written:
                (reg / "focused").write_text(cli, encoding="utf-8")
                written = cli
                log(f"desktop shows session {cli}")
            live = True  # what was in the log before this run is not a switch
        except OSError as e:
            log(f"desktop log: {e}")
        time.sleep(0.5)


def selftest_follow_desktop():
    """follow_desktop on a log in a temp folder: what was on screen before the
    run keeps the pane's choice; a switch during the run drops it."""
    import tempfile
    import threading

    with tempfile.TemporaryDirectory() as d:
        reg, path = Path(d), Path(d) / "main.log"
        path.write_text(
            "Mapping internal session local_a1 to CLI session cli-a\n"
            "Mapping internal session local_b2 to CLI session cli-b\n"
            "LocalSessions.setFocusedSession: sessionId=local_a1\n",
            encoding="utf-8",
        )
        (reg / "target").write_text("cli-b", encoding="utf-8")  # chosen in the pane
        threading.Thread(target=follow_desktop, args=(path, reg), daemon=True).start()
        time.sleep(0.8)
        assert (reg / "focused").read_text(encoding="utf-8") == "cli-a"
        assert (reg / "target").read_text(encoding="utf-8") == "cli-b"  # the start is not a switch
        assert json.loads((reg / "desktop-ids.json").read_text(encoding="utf-8")) == {"cli-a": "local_a1", "cli-b": "local_b2"}
        (reg / "target").write_text("cli-a", encoding="utf-8")
        with open(path, "a", encoding="utf-8") as f:
            f.write("LocalSessions.setFocusedSession: sessionId=null\nLocalSessions.setFocusedSession: sessionId=local_b2\n")
        time.sleep(0.8)
        assert (reg / "focused").read_text(encoding="utf-8") == "cli-b"
        assert (reg / "target").read_text(encoding="utf-8") == ""  # another session on screen: the choice goes


def desktop_log_path(cfg):
    return Path(cfg["desktop_log"] or Path(os.environ.get("LOCALAPPDATA", "")) / "Claude" / "Logs" / "main.log")


def load_config():
    cfg = dict(DEFAULTS)
    p = HERE / "config.json"
    if p.exists():
        cfg.update(json.loads(p.read_text(encoding="utf-8")))
    return cfg


def clean(text, submit_word, end_word="приём"):
    """Strip "Клод приём" in front, the end word and the submit word at the end.
    Returns (text, submit)."""
    text = WAKE_PREFIX.sub("", text.strip())
    text = TEXT_PREFIX.sub("", text)
    # The preroll often holds only the tail of the wake phrase ("приём"), so a
    # leading end word is always dropped. ponytail: eats a message that really
    # starts with "приём"; say something before it if that matters.
    text = re.sub(r"^" + word_re(end_word) + PUNCT, "", text, flags=re.I)
    text = re.sub(PUNCT + word_re(end_word) + r"[\s.!?]*$", "", text, flags=re.I)
    tail = re.compile(PUNCT + word_re(submit_word) + r"[\s.!?]*$", re.I)
    submit = bool(tail.search(text))
    if submit:
        text = tail.sub("", text)
    text = text.strip()
    if text:
        text = text[0].upper() + text[1:]
    return text, submit


def selftest():
    w = "отправь"
    assert clean("Клод, приём. Привет, приём.", w) == ("Привет", False)
    assert clean("Клод прием, привет мир. Отправь. Прием.", w) == ("Привет мир", True)
    assert clean("Claude, приём, напиши тест, отправь, приём", w) == ("Напиши тест", True)
    assert clean("Приём. Привет, приём.", w) == ("Привет", False)  # preroll without "Клод"
    assert clean("отправьте письмо Пете приём", w) == ("Отправьте письмо Пете", False)
    assert clean("Клод приём отправь приём", w) == ("", True)
    assert clean("Привет", w) == ("Привет", False)
    assert clean("Клод, текст. Купить молоко, приём.", w) == ("Купить молоко", False)
    assert clean("Текст, привет, приём", w) == ("Привет", False)  # preroll without "Клод"  # end word missed by whisper: still fine
    assert clean("Claude. Write a test. Send. Over.", "send", "over") == ("Write a test", True)
    assert clean("Преем. Какие еще есть принципы? Скажи список. Преем.", w) == ("Какие еще есть принципы? Скажи список", False)
    assert speech_pieces("Key principles include KISS, DRY, YAGNI, statelessness, and the CAP theorem.") == [
        "Key principles include KISS,", "DRY, YAGNI, statelessness,", "and the CAP theorem."]
    assert speech_pieces("Done.") == ["Done."]
    assert command_phrases()["клод перейди на сессию три"] == {"cmd": "session", "n": 3}
    ids = {}
    desktop = [
        "2026-11-09 20:24:29 [info] Mapping internal session local_a1 to CLI session 91c0fcb7-0985",
        "2026-11-09 20:24:30 [info] [CCD] LocalSessions.setFocusedSession: sessionId=local_a1",
        "2026-11-09 20:24:31 [info] [CCD] LocalSessions.setFocusedSession: sessionId=null",
        "2026-11-09 20:24:31 [info] [WarmLifecycle:preview] Warming up session local_b2",
    ]
    assert scan_desktop_log(desktop, ids) == "local_a1"  # null between switches keeps the last
    assert ids == {"local_a1": "91c0fcb7-0985"}
    assert scan_desktop_log(["[CCD] LocalSessions.setFocusedSession: sessionId=local_b2"], ids, "local_a1") == "local_b2"
    selftest_follow_desktop()

    class Rec:  # a Vosk recognizer that plays back (final?, text) per block
        def __init__(self, script):
            self.script, self.now = list(script), (False, "")

        def AcceptWaveform(self, _):
            self.now = self.script.pop(0)
            return self.now[0]

        def PartialResult(self):
            return json.dumps({"partial": self.now[1]}, ensure_ascii=False)

        def Result(self):
            return json.dumps({"text": self.now[1]}, ensure_ascii=False)

        def Reset(self):
            pass

    class Block:
        def tobytes(self):
            return b""

    def heard(script):
        lst = Listener.__new__(Listener)
        lst.wake, lst.stop, lst.commands, lst.stop_seen = "клод приём", "клод стоп", command_phrases(), 0
        lst.text_only = "клод текст"
        lst.rec = Rec(script)
        return [lst.heard_phrase(Block()) for _ in script]

    p = (False, "клод стоп")
    assert heard([p, p, p]) == [None, None, "клод стоп"]  # stop from a steady partial, before the pause
    assert heard([p, (False, ""), p, p]) == [None] * 4  # a flicker is not enough
    assert heard([(False, "клод сессия"), (True, "клод сессия три")]) == [None, "клод сессия три"]
    assert heard([(True, "клод текст")]) == ["клод текст"]
    assert heard([(False, "клод приём"), (False, "клод приём"), (False, "клод приём")]) == [None] * 3  # only stop is early
    print("selftest ok")


def take_lock(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))  # released by the OS when this process dies; never listens
        return s
    except OSError:
        return None


def parent_pid(pid):
    """Parent of `pid` via a Toolhelp snapshot, or None."""
    import ctypes
    from ctypes import wintypes

    class PE(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_char * 260),
        ]

    k32 = ctypes.windll.kernel32
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snap = k32.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS
    e = PE()
    e.dwSize = ctypes.sizeof(PE)
    try:
        ok = k32.Process32First(wintypes.HANDLE(snap), ctypes.byref(e))
        while ok:
            if e.th32ProcessID == pid:
                return e.th32ParentProcessID
            ok = k32.Process32Next(wintypes.HANDLE(snap), ctypes.byref(e))
    finally:
        k32.CloseHandle(wintypes.HANDLE(snap))
    return None


def exit_with_parent():
    """Exit when the parent or the grandparent dies. On Windows the venv
    python.exe is a launcher whose child is the real interpreter, so the
    parent is the launcher and the grandparent is Claude: either one going
    away would otherwise leave us holding the mic and the lock."""
    import ctypes
    import os
    import threading

    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = ctypes.c_void_p
    ppid = os.getppid()
    handles = [h for h in (k32.OpenProcess(0x00100000, False, p) for p in (ppid, parent_pid(ppid)) if p) if h]
    if not handles:
        return
    arr = (ctypes.c_void_p * len(handles))(*handles)

    def wait():
        k32.WaitForMultipleObjects(len(handles), arr, False, 0xFFFFFFFF)
        os._exit(0)

    threading.Thread(target=wait, daemon=True).start()


def rms(block):
    import numpy as np

    return float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))


def load_whisper(path, device):
    """faster-whisper on the GPU (float16) if it works, else on the CPU (int8).
    The CUDA DLLs come from the nvidia-cublas/cudnn pip packages; a missing DLL
    only shows on the first transcribe, so a second of silence is run to check."""
    import numpy as np
    from faster_whisper import WhisperModel

    nvidia = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    # "auto" without the CUDA libraries (install.py skips them with no NVIDIA card): CPU, no try.
    if device == "cuda" or (device == "auto" and nvidia.exists()):
        for bin_dir in nvidia.glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"
        try:
            m = WhisperModel(path, device="cuda", compute_type="float16")
            list(m.transcribe(np.zeros(RATE, dtype="float32"), language="ru")[0])
            log("whisper on GPU")
            return m
        except Exception as e:
            if device == "cuda":
                raise
            log(f"whisper GPU failed, using CPU: {e}")
    return WhisperModel(path, device="cpu", compute_type="int8")


class Listener:
    def __init__(self, cfg):
        from vosk import KaldiRecognizer, Model, SetLogLevel

        SetLogLevel(-1)
        self.cfg = cfg
        log("loading vosk...")
        self.vosk = Model(str(HERE / cfg["vosk_model"]))
        self.wake = cfg["wake_phrase"].lower()
        self.end = cfg["end_word"].lower()
        self.stop = cfg["stop_phrase"].lower()
        self.text_only = cfg["text_phrase"].lower()
        self.commands = command_phrases()
        self.last_said = ""  # for "клод повтори"
        self.stop_seen = 0  # blocks in a row whose partial result holds the stop phrase
        grammar = [self.wake, self.text_only, self.stop, *self.commands, "[unk]"]
        self.rec = KaldiRecognizer(self.vosk, RATE, json.dumps(grammar, ensure_ascii=False))
        self.end_rec = KaldiRecognizer(self.vosk, RATE)  # free decoding: only marks pauses
        log("loading whisper...")
        self.whisper = load_whisper(str(HERE / cfg["whisper_model"]), cfg["whisper_device"])
        self.history = []  # recent blocks for preroll
        self.start_tts()

    def start_tts(self):
        """Load and warm Kokoro in the background, so the first reply speaks without the ~3 s load."""
        import threading

        self.tts = None
        self.tts_loader = threading.Thread(target=self.load_tts, daemon=True)
        if self.cfg["speak"]:
            self.tts_loader.start()

    def tts_lang(self):
        return "en-gb" if self.cfg["voice"].startswith("b") else "en-us"

    def load_tts(self):
        from kokoro_onnx import Kokoro

        c = self.cfg
        log("loading kokoro...")
        tts = Kokoro(str(HERE / c["kokoro_model"]), str(HERE / c["kokoro_voices"]))
        tts.create("Ready.", voice=c["voice"], speed=c["speed"], lang=self.tts_lang())  # the first synthesis is slow
        self.tts = tts

    def beep(self, freq):
        if self.cfg["beep"]:
            import winsound

            winsound.Beep(freq, 120)

    def heard_phrase(self, block):
        """Feed a block to the grammar recognizer; a grammar phrase once heard
        (then reset), else None. Final results, which come after a short pause:
        partials under a small grammar fire on almost anything. The stop phrase
        alone is taken from a partial too, once it has held for STOP_BLOCKS
        blocks, so «Клод, стоп» does not wait for the pause."""
        if not self.rec.AcceptWaveform(block.tobytes()):
            # ponytail: 0.3 s of a steady partial; raise STOP_BLOCKS if noise ever stops Claude.
            partial = f" {json.loads(self.rec.PartialResult()).get('partial', '')} "
            self.stop_seen = self.stop_seen + 1 if f" {self.stop} " in partial else 0
            if self.stop_seen < STOP_BLOCKS:
                return None
            heard = partial
        else:
            heard = f" {json.loads(self.rec.Result()).get('text', '')} "
        self.stop_seen = 0
        for phrase in (self.wake, self.text_only, self.stop, *self.commands):
            if f" {phrase} " in heard:
                self.rec.Reset()
                return phrase
        return None

    def pause_word(self, audio):
        """What the speech since the last pause ends with: "end", "cancel" or None."""
        tail = self.transcribe(audio)
        log(f"pause, heard: {tail!r}")
        for kind, word in (("end", self.end), ("cancel", self.cfg["cancel_word"])):
            if re.search(word_re(word) + r"[\s,.!?]*$", tail, re.I):
                return kind
        return None

    def record(self, blocks):
        """Collect blocks after the trigger until the end word. Returns (audio, ended).

        Vosk marks the pauses (a final result of free decoding, so
        no energy threshold is involved). At each pause whisper reads the speech
        since the previous pause and the recording ends only if that ends with
        the end word. Vosk's own guess of the word is not trusted: under a
        one-word grammar it hears "приём" in unrelated speech, and the small
        model's free decoding misses it often."""
        import numpy as np

        c = self.cfg
        out = list(self.history)
        seg = len(out)  # first block of the speech since the last pause
        overlap = int(0.3 * RATE / BLOCK)
        spoke = False
        t = 0.0
        self.end_rec.Reset()
        for b in blocks:
            out.append(b)
            t += len(b) / RATE
            if self.heard_phrase(b) == self.stop:  # «Клод, стоп» mid-message: drop it, stop Claude too
                log("stop phrase while recording")
                emit({"stop": True})
                return None, False
            if self.end_rec.AcceptWaveform(b.tobytes()):
                heard = json.loads(self.end_rec.Result()).get("text", "")
                if heard:
                    spoke = True
                    word = self.pause_word(np.concatenate(out[max(0, seg - overlap) :])) if t >= c["end_guard_sec"] else None
                    if word == "end":
                        return np.concatenate(out), True
                    if word == "cancel":
                        log("cancelled")
                        return None, False
                seg = len(out)
            elif json.loads(self.end_rec.PartialResult()).get("partial"):
                spoke = True
            if take_cmd():  # the band's "Готово" (or a second "Диктовать"): ends like the end word
                return np.concatenate(out), True
            if not spoke and t >= c["start_timeout_sec"]:
                return None, False
            if t >= c["max_sec"]:
                break
        return np.concatenate(out), False

    def transcribe(self, audio):
        lang = None if self.cfg["language"] == "auto" else self.cfg["language"]
        segs, _ = self.whisper.transcribe(
            audio.astype("float32") / 32768.0,
            language=lang,
            beam_size=self.cfg["beam_size"],
            initial_prompt=self.cfg["whisper_prompt"] or None,
            condition_on_previous_text=False,  # one misheard piece must not steer the next
            vad_filter=True,
        )
        return " ".join(s.text.strip() for s in segs).strip()

    def handle(self, blocks, insert_only=False):
        """Process one utterance after the wake word. Returns True if something was emitted.
        `insert_only` (after «Клод, текст»): the text goes into the box, never sent."""
        emit({"status": "recording"})
        self.beep(880)
        audio, ended = self.record(blocks)
        self.history.clear()
        if audio is None:
            self.beep(330)
            return False
        emit({"status": "transcribing"})
        raw = self.transcribe(audio)
        text, submit = clean(raw, self.cfg["submit_word"], self.end)
        # Cut off by max_sec: never send. Nothing said: send the draft only on an explicit "отправь".
        submit = ended and not insert_only and (submit or (self.cfg["submit_on_end"] and bool(text)))
        log(f"heard: {raw!r} ended={ended}")
        if not text and not submit:  # "Клод, отправь" alone sends the draft
            self.beep(330)
            return False
        self.beep(1320)
        emit({"text": text, "submit": submit})
        self.toast(text, submit)
        return True

    def speak(self, text, mic=None):
        """Speak `text` with Kokoro, piece by piece: the next piece is synthesized
        while one plays. The band's "Замолчать" (cmd "stop") cuts it off, and so
        does «Клод, стоп» when `mic` (the mic's block queue) is given."""
        import threading

        import sounddevice as sd

        c = self.cfg
        if self.tts_loader.is_alive():
            self.tts_loader.join()
        if self.tts is None:  # not preloaded, or the preload failed: load here, errors and all
            self.load_tts()
        ready = queue.Queue()

        def synth():
            for piece in speech_pieces(text):
                ready.put(self.tts.create(piece, voice=c["voice"], speed=c["speed"], lang=self.tts_lang()))
            ready.put(None)

        self.last_said = text
        threading.Thread(target=synth, daemon=True).start()
        while (item := ready.get()) is not None:
            sd.play(*item)
            while sd.get_stream().active:
                said_stop = False
                while mic is not None and not mic.empty():
                    said_stop = said_stop or self.feed(mic.get_nowait()) == self.stop
                if said_stop:
                    log("stop phrase while speaking")
                    emit({"stop": True})
                if said_stop or take_cmd() == "stop":
                    sd.stop()
                    return
                time.sleep(0.02)

    def toast(self, text, submit):
        if not self.cfg["toast"]:
            return
        try:
            from winotify import Notification

            msg = text[:200] or "(текст из поля ввода)"
            Notification(app_id="Claude Voice", title="Отправлено" if submit else "Вставлено", msg=msg).show()
        except Exception as e:  # a toast is a nicety, never fatal
            log(f"toast failed: {e}")

    def feed(self, block):
        """Feed one block in idle mode; returns the wake or stop phrase once heard, else None."""
        keep = int(self.cfg["preroll_sec"] * RATE / BLOCK)
        self.history.append(block)
        del self.history[:-keep or None]
        return self.heard_phrase(block)


def run_mic(cfg):
    import sounddevice as sd

    lst = Listener(cfg)
    q = queue.Queue()

    def cb(indata, frames, t, status):
        q.put(indata[:, 0].copy())

    def blocks():
        while True:
            yield q.get()

    with sd.InputStream(samplerate=RATE, blocksize=BLOCK, channels=1, dtype="int16", device=cfg["device"], callback=cb):
        take_cmd()  # a press left over from an earlier run
        take(SAY_FILE)  # a reply from before this run: stale
        emit({"status": "ready"})
        log("listening; say the wake word")
        while True:
            phrase = lst.feed(q.get())
            if phrase == lst.stop:
                log("stop phrase")
                lst.beep(440)
                emit({"stop": True})
                continue
            command = lst.commands.get(phrase)
            if command and command["cmd"] != "repeat":
                log(f"command: {phrase}")
                lst.beep(440)
                emit(command)  # the mod answers "which" and "session" through SAY_FILE
                continue
            woke = phrase in (lst.wake, lst.text_only)
            pressed = take_cmd() == "dictate"
            say = take(SAY_FILE) or (command and lst.last_said)
            if say and cfg["speak"]:
                log(f"say: {say!r}")
                emit({"status": "speaking"})
                try:
                    lst.speak(say, q)
                except Exception as e:  # no model, no audio device: keep listening
                    log(f"speak failed: {e}")
            elif woke or pressed:
                log(f"wake phrase: {phrase}" if woke else "dictate button")
                if pressed:
                    lst.history.clear()  # the preroll is for the wake phrase, not a button
                lst.handle(blocks(), insert_only=phrase == lst.text_only)
            else:
                continue
            while not q.empty():  # drop audio captured while busy (incl. our beeps and speech)
                q.get_nowait()
            lst.rec.Reset()
            emit({"status": "ready"})


def run_wav(cfg, path):
    import wave

    import numpy as np

    with wave.open(path) as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16 kHz mono 16-bit"
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    data = np.concatenate([data, np.zeros(RATE * 3, dtype=np.int16)])  # trailing silence ends the phrase
    cfg = {**cfg, "beep": False, "toast": False}
    lst = Listener(cfg)
    it = (data[i : i + BLOCK] for i in range(0, len(data), BLOCK))
    for b in it:
        if lst.feed(b) == lst.wake:
            log("wake word")
            lst.handle(it)
    lst.rec.Reset()


def run_levels(cfg):
    import sounddevice as sd

    log(f"energy_threshold={cfg['energy_threshold']}; speak, then stay quiet. Ctrl+C to stop.")
    with sd.InputStream(samplerate=RATE, blocksize=BLOCK * 2, channels=1, dtype="int16", device=cfg["device"]) as s:
        while True:
            b, _ = s.read(BLOCK * 2)
            v = rms(b[:, 0])
            print(f"{v:7.0f} {'#' * min(60, int(v / 50))}", flush=True)


def main():
    args = sys.argv[1:]
    if "--selftest" in args:
        return selftest()
    cfg = load_config()
    if "--levels" in args:
        return run_levels(cfg)
    if "--wav" in args:
        return run_wav(cfg, args[args.index("--wav") + 1])
    if "--say" in args:
        lst = Listener.__new__(Listener)  # no vosk or whisper needed to speak
        lst.cfg = cfg
        lst.start_tts()
        lst.tts_loader.join()
        t = time.time()
        lst.speak(args[args.index("--say") + 1])
        log(f"spoke in {time.time() - t:.1f} s")
        return None
    lock = take_lock(cfg["lock_port"])
    if lock is None:
        emit({"status": "busy"})
        log("another listener already owns the microphone (Claude's? /claude-voice-off there turns it off); its log: listener/listen.log")
        sys.exit(3)
    exit_with_parent()
    global LOG_FILE
    LOG_FILE = HERE / "listen.log"
    LOG_FILE.write_text("", encoding="utf-8")  # one run per file
    if cfg["follow_desktop"]:
        import threading

        threading.Thread(target=follow_desktop, args=(desktop_log_path(cfg),), daemon=True).start()
    try:
        run_mic(cfg)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
