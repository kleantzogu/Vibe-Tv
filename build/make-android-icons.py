import sys, os, glob
from PIL import Image, ImageDraw, ImageFont
# Makes the Android launcher icons, the Android TV banner and the splash images from
# build/icon-source.png (the same artwork as the desktop icons).
# Run from the project folder: python3 build/make-android-icons.py   (needs Pillow)
root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
res = f'{root}/android/app/src/main/res'
src = Image.open(f'{root}/build/icon-source.png').convert('RGBA')  # artwork on black, full bleed
BG = (22, 22, 24, 255)  # the app's dark background; also res/values/ic_launcher_background.xml
SS = 4  # supersampling for smooth edges

def mask(size, radius):
    big = size * SS
    m = Image.new('L', (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, big - 1, big - 1), radius=radius * SS, fill=255)
    return m.resize((size, size), Image.LANCZOS)

def tile(size, radius):
    t = src.resize((size, size), Image.LANCZOS)
    t.putalpha(mask(size, radius))
    return t

def centred(canvas, body, radius, background=(0, 0, 0, 0)):
    w, h = canvas if isinstance(canvas, tuple) else (canvas, canvas)
    out = Image.new('RGBA', (w, h), background)
    t = tile(body, radius)
    out.alpha_composite(t, ((w - body) // 2, (h - body) // 2))
    return out

def font(size):
    for f in ('/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc', 'C:/Windows/Fonts/segoeui.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'):
        try:
            ft = ImageFont.truetype(f, size)
            try: ft.set_variation_by_name('Bold')
            except Exception: pass
            return ft
        except Exception:
            pass
    return ImageFont.load_default()

# Launcher icons. dp sizes: 48 (legacy and round), 108 (adaptive foreground, artwork inside the
# 66 dp safe zone so no launcher shape crops it).
for name, scale in (('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)):
    d = f'{res}/mipmap-{name}'
    os.makedirs(d, exist_ok=True)
    s = round(48 * scale)
    centred(s, round(s * 0.92), round(s * 0.2)).save(f'{d}/ic_launcher.png')
    centred(s, s, s // 2).save(f'{d}/ic_launcher_round.png')
    f = round(108 * scale)
    centred(f, round(f * 0.56), round(f * 0.12)).save(f'{d}/ic_launcher_foreground.png')

# Android TV banner: 320×180 dp, shown in the launcher's app row. Made at xhdpi (2×).
banner = Image.new('RGBA', (640, 360), BG)
banner.alpha_composite(tile(200, 44), (56, 80))
ImageDraw.Draw(banner).text((296, 180), 'Vibe TV', font=font(84), fill=(245, 245, 247), anchor='lm')
os.makedirs(f'{res}/drawable-xhdpi', exist_ok=True)
banner.convert('RGB').save(f'{res}/drawable-xhdpi/tv_banner.png')

# Splash images: the icon on the app's background, at the sizes the Android project came with.
for path in glob.glob(f'{res}/drawable*/splash.png'):
    w, h = Image.open(path).size
    body = round(min(w, h) * 0.28)
    centred((w, h), body, round(body * 0.22), BG).convert('RGB').save(path)
print('ok')
