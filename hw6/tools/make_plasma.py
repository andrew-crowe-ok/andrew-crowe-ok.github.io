"""Render a seamless looping plasma swirl for the Bussard collectors.

Columns are u (wraps around the nacelle axis), rows are v (top row = cap tip).
Every term is periodic in u (integer arm counts) and in time (integer multiples
of the loop phase), so the video tiles around the sphere and loops cleanly.
"""
import subprocess, sys
import numpy as np
import imageio_ffmpeg

W = H = 256
FPS, SECONDS = 30, 3
N = FPS * SECONDS
out_dir = sys.argv[1]

u = np.linspace(0, 1, W, endpoint=False)[None, :]
v = 1 - np.linspace(0, 1, H)[:, None]          # 1 at the top row (tip)
d = 1 - v                                       # distance back from the tip

def frame(i):
    p = 2 * np.pi * i / N
    arms = np.sin(2 * np.pi * 3 * u + 9 * d - 3 * p)        # 3 spiral vanes spinning
    rings = np.sin(16 * d - 2 * p)                          # pulses flowing back from the tip
    churn = np.sin(2 * np.pi * 5 * u - 6 * d + p) * np.sin(2 * np.pi * 2 * u + 11 * d - 2 * p)
    val = 0.42 + 0.26 * arms + 0.12 * rings + 0.12 * churn + 0.35 * v ** 4  # hotter at the tip
    r = np.clip(0.25 + 1.4 * val, 0, 1)
    g = np.clip((val - 0.45) * 1.7, 0, 1)
    b = np.clip((val - 0.85) * 3.0, 0, 1)
    return (np.stack([r, g, b], -1) * 255).astype(np.uint8)

frames = b"".join(frame(i).tobytes() for i in range(N))
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
src = ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
for args, name in [
    (["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-pix_fmt", "yuv420p"], "plasma.webm"),
    (["-c:v", "libx264", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart"], "plasma.mp4"),
]:
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", *src, "-an", *args, f"{out_dir}/{name}"],
                   input=frames, check=True)
    print("wrote", name)
