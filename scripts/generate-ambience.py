"""Generate original, loopable rain and forest ambience without external assets.
Run from any directory with Python 3; output is 16-bit mono PCM WAV.
"""
from pathlib import Path
import math
import random
import struct
import wave

ASSETS = Path(__file__).resolve().parents[1] / 'assets'
RATE = 22050
SECONDS = 16
COUNT = RATE * SECONDS

for name in ('rain', 'forest'):
    rng = random.Random(name)
    low = 0.0
    samples = []
    # Bird calls are silent at loop boundaries.
    calls = [(2.0, 0.6, 2300), (5.7, 0.8, 2900), (10.3, 0.5, 2100), (12.8, 0.7, 2700)]
    for i in range(COUNT):
        t = i / RATE
        noise = rng.uniform(-1, 1)
        low = low * 0.97 + noise * 0.03
        breeze = 0.75 + 0.25 * math.sin(2 * math.pi * t / SECONDS)
        if name == 'rain':
            sample = (noise * 0.16 + low * 0.9) * breeze
        else:
            sample = low * 0.7 * breeze + noise * 0.018
            for start, length, pitch in calls:
                u = (t - start) / length
                if 0 < u < 1:
                    envelope = math.sin(math.pi * u) ** 2
                    phase = 2 * math.pi * (pitch * (t - start) + 140 * length / (6 * math.pi) * math.sin(6 * math.pi * u))
                    sample += 0.12 * envelope * math.sin(phase) * (0.6 + 0.4 * math.sin(8 * math.pi * u))
        samples.append(sample)
    # Short overlap makes the noise continuous at the wrap point.
    overlap = RATE // 10
    for i in range(overlap):
        mix = i / overlap
        samples[COUNT - overlap + i] = samples[COUNT - overlap + i] * (1 - mix) + samples[i] * mix
    samples = samples[overlap:]
    with wave.open(str(ASSETS / f'{name}.wav'), 'wb') as audio:
        audio.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', max(-32768, min(32767, int(x * 32767)))) for x in samples))
