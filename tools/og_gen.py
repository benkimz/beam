"""Generate og.png — 1200x630 social preview: spectral beam + wordmark."""
import math
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
BG = (11, 15, 22)
STOPS = [(43, 217, 255), (122, 90, 255), (255, 169, 77)]


def beam_color(t):
    seg, u = (0, t * 2) if t < 0.5 else (1, (t - 0.5) * 2)
    a, b = STOPS[seg], STOPS[seg + 1]
    return tuple(a[i] + (b[i] - a[i]) * u for i in range(3))


# --- background with spectral beam (lower third, behind the text) ---
img = Image.new("RGB", (W, H), BG)
px = img.load()
slope = math.tan(math.radians(-7))
line_center_y = H * 0.83
for y in range(H):
    for x in range(W):
        line_y = line_center_y + (x - W / 2) * slope
        d = abs(y - line_y)
        core = math.exp(-d * d / (2 * 5 * 5))
        glow = math.exp(-d * d / (2 * 80 * 80))
        c = beam_color(x / W)
        px[x, y] = tuple(
            min(255, round(BG[i] + c[i] * core * 0.95 + c[i] * glow * 0.28 + 255 * core * 0.25))
            for i in range(3)
        )

# --- gradient wordmark via text mask ---
display = ImageFont.truetype("tools/fonts/Unbounded.ttf", 148)
try:
    display.set_variation_by_axes([700])
except Exception:
    pass
body = ImageFont.truetype("tools/fonts/Atkinson.ttf", 46)

mask = Image.new("L", (W, H), 0)
mdraw = ImageDraw.Draw(mask)
WM_X, WM_Y = 88, 150
mdraw.text((WM_X, WM_Y), "beam", font=display, fill=255)

bbox = mdraw.textbbox((WM_X, WM_Y), "beam", font=display)
grad = Image.new("RGB", (W, H), BG)
gpx = grad.load()
for x in range(max(0, bbox[0] - 2), min(W, bbox[2] + 2)):
    t = (x - bbox[0]) / max(1, bbox[2] - bbox[0])
    c = tuple(round(v) for v in beam_color(t))
    for y in range(max(0, bbox[1] - 2), min(H, bbox[3] + 2)):
        gpx[x, y] = c

img = Image.composite(grad, img, mask)

# --- small superscript trademark, top-right of the wordmark ---
draw = ImageDraw.Draw(img)
tm_font = ImageFont.truetype("tools/fonts/Atkinson.ttf", 64)
draw.text((bbox[2] + 14, bbox[1] - 12), "™", font=tm_font, fill=(255, 169, 77))

# --- tagline ---
draw.text((WM_X + 8, WM_Y + 218), "Send anything to any device.",
          font=body, fill=(237, 242, 250))
draw.text((WM_X + 8, WM_Y + 282), "No app. No account. No size limit.",
          font=body, fill=(140, 153, 173))

img.save("og.png", optimize=True)
print("og.png written:", img.size)
