# kokoro-render.py — one Kokoro-82M synthesis, subprocess-per-render (voice-out.ts's kokoro arm).
#
# Runs under the INSTALL's own venv python (kokoro-onnx + onnxruntime + soundfile live there, this
# repo ships none of them): <install>/.venv/bin/python scripts/kokoro-render.py <install> <voice>
# <speed> <out.wav>, text on stdin. The stderr line states voice+speed so a render's parameters are
# observable in the daemon log — the setting must be provable in the synthesis args, not by ear.
#
# Subprocess-per-render is the recorded architecture decision (bus ask 99): the cold start is ~2.6s
# on a path that is manual-gesture-only, and a resident ~0.5-1.2GB python on this box is an earlyoom
# target. If that trade flips, this file is the seam: replace the body with a client to a resident
# server and voice-out.ts never learns.
import sys

def main() -> int:
    if len(sys.argv) != 5:
        print("usage: kokoro-render.py <install-dir> <voice> <speed> <out.wav>  (text on stdin)", file=sys.stderr)
        return 2
    install, voice, speed, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
    text = sys.stdin.read().strip()
    if not text:
        print("kokoro-render: no text on stdin", file=sys.stderr)
        return 2
    import onnxruntime as ort            # imported after argv checks: a usage error should not pay the 0.4s
    import soundfile as sf
    from kokoro_onnx import Kokoro
    # 4 intra-op threads is the spike's measured sweet spot for this 4-core box; inter-op 1 because
    # there is exactly one graph.
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    so.inter_op_num_threads = 1
    k = Kokoro.from_session(
        ort.InferenceSession(f"{install}/models/kokoro-v1.0.onnx", sess_options=so, providers=["CPUExecutionProvider"]),
        f"{install}/models/voices-v1.0.bin",
    )
    print(f"kokoro-render: voice={voice} speed={speed} chars={len(text)}", file=sys.stderr)
    samples, rate = k.create(text, voice=voice, speed=speed)
    sf.write(out, samples, rate)
    return 0

if __name__ == "__main__":
    sys.exit(main())
