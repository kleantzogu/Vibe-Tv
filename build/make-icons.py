import sys, os, math, subprocess, shutil
from PIL import Image, ImageDraw, ImageFilter
# Makes every app icon from build/icon-source.png (the 1200 px Figma frame, exported as PNG).
# Run from the project folder: python3 build/make-icons.py   (needs Pillow; macOS for the .icns)
import tempfile
root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd(); tmp = tempfile.mkdtemp()
src = Image.open(f'{root}/build/icon-source.png').convert('RGBA')  # the Figma frame: artwork on black, full bleed
SS = 4  # supersampling for smooth edges

def rounded_mask(size, radius):
    big = size * SS
    m = Image.new('L', (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, big - 1, big - 1), radius=radius * SS, fill=255)
    return m.resize((size, size), Image.LANCZOS)

def compose(canvas, body, mask, shadow):
    out = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    off = (canvas - body) // 2
    tile = src.resize((body, body), Image.LANCZOS)
    tile.putalpha(mask)
    if shadow:
        sh = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
        dark = Image.new('RGBA', (body, body), (0, 0, 0, 110))
        dark.putalpha(mask.point(lambda v: v * 110 // 255))
        sh.paste(dark, (off, off + 12), dark)
        out = Image.alpha_composite(out, sh.filter(ImageFilter.GaussianBlur(14)))
    layer = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    layer.paste(tile, (off, off), tile)
    return Image.alpha_composite(out, layer)

# macOS: Apple's grid, an 824 px squircle centred on a 1024 canvas, with a soft shadow.
mac = compose(1024, 824, rounded_mask(824, 185), shadow=True)
# Windows / Linux: a rounded square that fills more of the canvas (these systems don't add margins).
other = compose(1024, 944, rounded_mask(944, 200), shadow=False)
mac.save(f'{root}/build/icon-mac.png')
other.save(f'{root}/build/icon.png')
other.resize((512, 512), Image.LANCZOS).save(f'{root}/src/icon.png')

# .icns from the macOS artwork
iconset = f'{tmp}/icon.iconset'
shutil.rmtree(iconset, ignore_errors=True); os.makedirs(iconset)
for s in (16, 32, 128, 256, 512):
    mac.resize((s, s), Image.LANCZOS).save(f'{iconset}/icon_{s}x{s}.png')
    mac.resize((s * 2, s * 2), Image.LANCZOS).save(f'{iconset}/icon_{s}x{s}@2x.png')
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', f'{root}/build/icon.icns'], check=True)
# .ico for Windows
other.save(f'{root}/build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('ok')
