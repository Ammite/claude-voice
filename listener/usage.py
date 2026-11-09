"""Cloud speech usage: one JSON line per Soniox call in listener/usage.jsonl, and a report.

Soniox bills by tokens; the cost here is an estimate from its public rates
(soniox.com/pricing, checked 2026-11-10), not the bill itself:
  STT real-time: audio in $2.00 / 1M tokens (~30,000 per hour of audio),
                 text out $4.00 / 1M tokens (~0.3 per character);
  TTS real-time: text in $4.00 / 1M tokens (~0.3 per character),
                 audio out $21.50 / 1M tokens (~30,000 per hour of speech).
"""
import json
import time
from collections import defaultdict
from pathlib import Path

AUDIO_TOKENS_PER_SEC = 30_000 / 3600
TOKENS_PER_CHAR = 0.3
STT_AUDIO_IN = 2.00 / 1e6
STT_TEXT_OUT = 4.00 / 1e6
TTS_TEXT_IN = 4.00 / 1e6
TTS_AUDIO_OUT = 21.50 / 1e6


def stt_cost(audio_sec, text_chars):
    return audio_sec * AUDIO_TOKENS_PER_SEC * STT_AUDIO_IN + text_chars * TOKENS_PER_CHAR * STT_TEXT_OUT


def tts_cost(text_chars, audio_sec):
    return text_chars * TOKENS_PER_CHAR * TTS_TEXT_IN + audio_sec * AUDIO_TOKENS_PER_SEC * TTS_AUDIO_OUT


def record(path, kind, model, audio_sec, chars, now=None):
    """`kind`: "stt" (a whole message), "stt-pause" (a piece checked for the end word) or "tts"."""
    cost = tts_cost(chars, audio_sec) if kind == "tts" else stt_cost(audio_sec, chars)
    entry = {"t": round(now if now is not None else time.time(), 3), "kind": kind, "model": model,
             "audio_sec": round(audio_sec, 2), "chars": chars, "usd": round(cost, 7)}
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass  # accounting must never stop the listener


def load(path):
    out = []
    try:
        lines = Path(path).read_text("utf-8").splitlines()
    except OSError:
        return out
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue  # a line cut by a crash
    return out


def summarize(entries, day=lambda t: time.strftime("%Y-%m-%d", time.localtime(t))):
    """{day: {kind: {"calls", "audio_sec", "chars", "usd"}}}, days in order."""
    days = defaultdict(lambda: defaultdict(lambda: {"calls": 0, "audio_sec": 0.0, "chars": 0, "usd": 0.0}))
    for e in entries:
        row = days[day(e["t"])][e["kind"]]
        row["calls"] += 1
        row["audio_sec"] += e.get("audio_sec", 0)
        row["chars"] += e.get("chars", 0)
        row["usd"] += e.get("usd", 0)
    return {d: dict(days[d]) for d in sorted(days)}


def report(path):
    days = summarize(load(path))
    if not days:
        return "no cloud usage yet"
    lines = [f"{'day':<10} {'kind':<9} {'calls':>5} {'audio, min':>10} {'chars':>7} {'$':>9}"]
    total = defaultdict(float)
    for d, kinds in days.items():
        for kind, r in sorted(kinds.items()):
            lines.append(f"{d:<10} {kind:<9} {r['calls']:>5} {r['audio_sec'] / 60:>10.2f} {r['chars']:>7} {r['usd']:>9.4f}")
            total[kind] += r["usd"]
    lines.append("total: " + ", ".join(f"{k} ${v:.4f}" for k, v in sorted(total.items()))
                 + f"; all ${sum(total.values()):.4f}")
    days_n = len(days)
    lines.append(f"per day on average: ${sum(total.values()) / days_n:.4f}, a 30-day month ≈ ${sum(total.values()) / days_n * 30:.2f}")
    return "\n".join(lines)


def selftest():
    import tempfile

    assert abs(stt_cost(3600, 0) - 0.06) < 1e-9  # 30,000 audio tokens at $2/1M
    assert abs(tts_cost(0, 3600) - 0.645) < 1e-9  # 30,000 audio tokens at $21.5/1M
    assert abs(tts_cost(1000, 0) - 0.0012) < 1e-9
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "usage.jsonl"
        assert report(p) == "no cloud usage yet"
        record(p, "stt", "m", 60, 100, now=0)
        record(p, "stt-pause", "m", 30, 50, now=10)
        record(p, "tts", "m", 5, 80, now=86400 * 1.5)
        with open(p, "a") as f:
            f.write('{"t": 1, "kind"\n')  # cut line
        days = summarize(load(p), day=lambda t: int(t // 86400))
        assert list(days) == [0, 1] and days[0]["stt"]["calls"] == 1 and days[0]["stt-pause"]["audio_sec"] == 30
        assert days[1]["tts"]["chars"] == 80
        assert "all $" in report(p)
    print("usage selftest ok")
