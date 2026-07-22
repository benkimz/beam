"""Generate favicon.ico (16/32/48) and apple-touch-icon.png from the beam mark."""
import math
from PIL import Image, ImageDraw

S = 256
BG = (16, 23, 36, 255)
STOPS = [(43, 217, 255), (122, 90, 255), (255, 169, 77)]


def beam_color(t):
    seg, u = (0, t * 2) if t < 0.5 else (1, (t - 0.5) * 2)
    a, b = STOPS[seg], STOPS[seg + 1]
    return tuple(int(a[i] + (b[i] - a[i]) * u) for i in range(3))


img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.rounded_rectangle([0, 0, S - 1, S - 1], radius=56, fill=BG)

# spectral beam through the center at -24°
px = img.load()
slope = math.tan(math.radians(-24))
for y in range(S):
    for x in range(S):
        if px[x, y][3] == 0:
            continue
        line_y = S / 2 + (x - S / 2) * slope
        d = abs(y - line_y)
        core = math.exp(-d * d / (2 * 11 * 11))
        glow = math.exp(-d * d / (2 * 40 * 40))
        # gradient runs along the beam axis
        t = (x + (S / 2 - y) * 0.4) / S
        t = min(1, max(0, t))
        c = beam_color(t)
        r, g, b, a = px[x, y]
        px[x, y] = (
            min(255, int(r + c[0] * core * 1.0 + c[0] * glow * 0.25 + 235 * core * 0.28)),
            min(255, int(g + c[1] * core * 1.0 + c[1] * glow * 0.25 + 235 * core * 0.28)),
            min(255, int(b + c[2] * core * 1.0 + c[2] * glow * 0.25 + 235 * core * 0.28)),
            a,
        )

img.resize((180, 180), Image.LANCZOS).save("apple-touch-icon.png", optimize=True)
img.save("favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("favicon.ico + apple-touch-icon.png written")
