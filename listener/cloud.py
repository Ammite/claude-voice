"""Soniox cloud speech: recognition (STT) and voice (TTS).

The key comes from SONIOX_API_KEY, else from ~/.config/soniox.env
(a line SONIOX_API_KEY=...). Pure helpers (messages, token folding, request
body) are separate from the network calls, so --selftest checks them offline.
"""
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

STT_URL = "wss://stt-rt.soniox.com/transcribe-websocket"
STT_MODEL = "stt-rt-v6"
TTS_URL = "https://tts-rt.soniox.com/tts"
TTS_MODEL = "tts-rt-v2"
USER_AGENT = "claude-voice/1.0"  # Soniox answers 403 to the default Python user agent
END_TOKEN = "<end>"
RATE = 16000
CHUNK = RATE  # bytes: 0.5 s of s16le per websocket frame
STT_TIMEOUT = 10.0  # a hung socket must not hold the listener forever
TTS_RATE = 24000


class CloudError(Exception):
    """`fatal`: retrying will not help (bad key, refused): stop using the cloud."""

    def __init__(self, message, fatal=False):
        super().__init__(message)
        self.fatal = fatal


def load_key(env=None, config_dir=None):
    env = os.environ if env is None else env
    value = (env.get("SONIOX_API_KEY") or "").strip()
    if value:
        return value
    path = Path(config_dir or Path.home() / ".config") / "soniox.env"
    try:
        lines = path.read_text("utf-8").splitlines()
    except OSError:
        return ""
    for line in lines:
        line = line.strip().removeprefix("export ").strip()
        key, sep, val = line.partition("=")
        if sep and key.strip() == "SONIOX_API_KEY":
            return val.strip().strip("\"'")
    return ""


def is_fatal(status):
    return status in (401, 402, 403)


def stt_config(language, terms):
    """The first websocket message. `language` "auto": no hint, Soniox detects it."""
    msg = {"model": STT_MODEL, "audio_format": "s16le", "sample_rate": RATE, "num_channels": 1}
    if language and language != "auto":
        msg["language_hints"] = [language]
    if terms:
        msg["context"] = {"terms": list(terms)}
    return json.dumps(msg, ensure_ascii=False)


def fold(final, message):
    """Add a server message's final tokens to `final` (a list of text pieces).
    Returns (finished, error): error is (code, text) or None."""
    if message.get("error_code") or message.get("error_message"):
        return True, (message.get("error_code"), str(message.get("error_message") or ""))
    for token in message.get("tokens") or []:
        text = token.get("text", "")
        if token.get("is_final") and text != END_TOKEN:
            final.append(text)
    return bool(message.get("finished")), None


def tts_request(key, text, language, voice):
    body = json.dumps({"model": TTS_MODEL, "language": language, "voice": voice, "audio_format": "pcm_s16le",
                       "sample_rate": TTS_RATE, "text": text}, ensure_ascii=False).encode()
    return urllib.request.Request(TTS_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": USER_AGENT})


def transcribe(audio, key, language, terms=(), timeout=STT_TIMEOUT):
    """Recognize a finished recording (int16 numpy, 16 kHz mono): send it all, then wait for the result."""
    import time

    from websockets.exceptions import InvalidStatus, WebSocketException
    from websockets.sync.client import connect

    pcm = audio.astype("<i2").tobytes()
    deadline = time.monotonic() + timeout
    final = []
    try:
        with connect(STT_URL, open_timeout=5, close_timeout=0.5, user_agent_header=USER_AGENT,
                     additional_headers={"Authorization": f"Bearer {key}"}) as ws:
            ws.send(stt_config(language, terms))
            for i in range(0, len(pcm), CHUNK):
                ws.send(pcm[i:i + CHUNK])
            ws.send("")  # end of audio
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise CloudError(f"Soniox did not finish in {timeout} s")
                finished, error = fold(final, json.loads(ws.recv(timeout=left)))
                if error:
                    code, text = error
                    raise CloudError(f"Soniox {code}: {text}", is_fatal(code))
                if finished:
                    return "".join(final).strip()
    except InvalidStatus as e:
        code = e.response.status_code
        raise CloudError(f"Soniox HTTP {code}", is_fatal(code)) from e
    except (WebSocketException, OSError, TimeoutError) as e:
        raise CloudError(f"Soniox: {e.__class__.__name__}: {e}") from e


def synthesize(text, key, language, voice, timeout=30):
    """One piece of speech: (int16 numpy, rate)."""
    import numpy as np

    try:
        with urllib.request.urlopen(tts_request(key, text, language, voice), timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raise CloudError(f"Soniox TTS HTTP {e.code}", is_fatal(e.code)) from e
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise CloudError(f"Soniox TTS: {e}") from e
    return np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2"), TTS_RATE


def selftest():
    import tempfile

    assert load_key({"SONIOX_API_KEY": " k1 "}) == "k1"
    with tempfile.TemporaryDirectory() as d:
        Path(d, "soniox.env").write_text('export SONIOX_API_KEY="k2"\n', "utf-8")
        assert load_key({}, d) == "k2"
        assert load_key({}, Path(d) / "none") == ""

    m = json.loads(stt_config("ru", ["Claude"]))
    assert m["language_hints"] == ["ru"] and m["context"] == {"terms": ["Claude"]} and "api_key" not in m
    assert "language_hints" not in json.loads(stt_config("auto", []))

    final = []
    assert fold(final, {"tokens": [{"text": "При", "is_final": True}, {"text": "вет", "is_final": False}]}) == (False, None)
    assert fold(final, {"tokens": [{"text": "вет", "is_final": True}, {"text": END_TOKEN, "is_final": True}],
                        "finished": True}) == (True, None)
    assert "".join(final) == "Привет"
    assert fold([], {"error_code": 401, "error_message": "bad key"}) == (True, (401, "bad key"))
    assert is_fatal(401) and is_fatal(403) and not is_fatal(500) and not is_fatal(None)

    req = tts_request("k", "Привет", "ru", "Kirill")
    assert req.get_header("User-agent") == USER_AGENT and req.get_header("Authorization") == "Bearer k"
    assert json.loads(req.data)["text"] == "Привет"
    print("cloud selftest ok")
