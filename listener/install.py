"""One-time setup: venv, deps, models. Run: python listener/install.py [--gpu | --cpu]

The CUDA libraries (~2 GB) are installed only with an NVIDIA card (found by
`nvidia-smi -L`) or --gpu; --cpu skips them. Whisper runs on the CPU without them.
"""
import hashlib
import io
import shutil
import subprocess
import sys
import urllib.request
import venv
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV = HERE / ".venv"
PY = VENV / "Scripts" / "python.exe"
MODELS = HERE / "models"
VOSK = "vosk-model-small-ru-0.22"
# Downloads are checked against these before use: a swapped file is refused, not loaded.
SHA256 = {
    f"{VOSK}.zip": "961d5ff98a17f4aa6de69864d0aa71fa5bac682301d2b5d17a3f24c5c99a46d4",
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}


def check(name, data):
    got = hashlib.sha256(data).hexdigest()
    if got != SHA256[name]:
        sys.exit(f"{name}: sha256 {got} does not match the expected {SHA256[name]}; not installed")

if not PY.exists():
    print("creating venv...")
    venv.create(VENV, with_pip=True)
subprocess.check_call([str(PY), "-m", "pip", "install", "-q", "-r", str(HERE / "requirements.txt")])


def has_nvidia():
    smi = shutil.which("nvidia-smi")  # comes with the NVIDIA driver
    return bool(smi) and subprocess.run([smi, "-L"], capture_output=True, text=True).stdout.startswith("GPU")


gpu = "--gpu" in sys.argv or ("--cpu" not in sys.argv and has_nvidia())
print(f"GPU: {'NVIDIA, installing CUDA libraries (~2 GB)' if gpu else 'none, whisper runs on the CPU'}")
if gpu:
    subprocess.check_call([str(PY), "-m", "pip", "install", "-q", "-r", str(HERE / "requirements-cuda.txt")])

MODELS.mkdir(exist_ok=True)
if not (MODELS / VOSK).exists():
    print(f"downloading {VOSK} (~45 MB)...")
    data = urllib.request.urlopen(f"https://alphacephei.com/vosk/models/{VOSK}.zip").read()
    check(f"{VOSK}.zip", data)
    zipfile.ZipFile(io.BytesIO(data)).extractall(MODELS)

if not (MODELS / "faster-whisper-small" / "model.bin").exists():
    print("downloading faster-whisper small (~480 MB)...")
    subprocess.check_call([
        str(PY), "-c",
        "import sys; from faster_whisper import download_model; download_model('small', output_dir=sys.argv[1])",
        str(MODELS / "faster-whisper-small"),
    ])

KOKORO = MODELS / "kokoro"
KOKORO_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
KOKORO.mkdir(exist_ok=True)
for name, size in [("kokoro-v1.0.onnx", "~310 MB"), ("voices-v1.0.bin", "~27 MB")]:
    if not (KOKORO / name).exists():
        print(f"downloading kokoro {name} ({size})...")
        part = KOKORO / (name + ".part")
        urllib.request.urlretrieve(KOKORO_URL + name, part)
        check(name, part.read_bytes())
        part.rename(KOKORO / name)

subprocess.check_call([str(PY), str(HERE / "listen.py"), "--selftest"])
print(f"done. run: {PY} {HERE / 'listen.py'}")
