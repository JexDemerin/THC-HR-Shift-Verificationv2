#!/usr/bin/env python3
"""Regenerates the extension's icon set.

    python3 tools/make-icons.py          (needs Pillow)

The icons are committed, so this only needs running when the mark or the brand
colours change -- but they are generated rather than hand-drawn so a palette
change stays a one-line edit instead of a round trip through a design tool.

This mark is the SHIFT SCANNER's own: a schedule card with a check, i.e. shifts
verified. It is deliberately not the Together Homecare logo -- the company logo
belongs in the panel header (popup.html, icons/logo.png), where it sits on the
white backing the brand guidelines ask for.
"""
from PIL import Image, ImageDraw

ROSE = (172, 107, 117, 255)       # #AC6B75 Dusty Rose -- primary brand colour
ROSE_DEEP = (143, 85, 96, 255)    # header band, same family
WHITE = (255, 255, 255, 255)

SIZES = (16, 32, 48, 128)
S = 1024  # drawn large and downsampled, which keeps 16px crisp


def build():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # App tile in the primary brand colour.
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=ROSE)

    # The schedule card.
    pad = int(S * 0.19)
    card = [pad, int(S * 0.25), S - pad, S - int(S * 0.21)]
    d.rounded_rectangle(card, radius=int(S * 0.06), fill=WHITE)

    # Its header band, squared off at the bottom so it reads as one card.
    band = int((card[3] - card[1]) * 0.24)
    d.rounded_rectangle([card[0], card[1], card[2], card[1] + band],
                        radius=int(S * 0.06), fill=ROSE_DEEP)
    d.rectangle([card[0], card[1] + band - int(S * 0.05), card[2], card[1] + band],
                fill=ROSE_DEEP)

    # A check: the verification the tool exists to do. Centred in the card
    # body and kept to two thick strokes with round caps -- anything finer or
    # off-centre turns to mush at 16px, which is the size that actually matters.
    body_top, body_bottom = card[1] + band, card[3]
    cx = (card[0] + card[2]) // 2
    cy = (body_top + body_bottom) // 2
    cw = card[2] - card[0]
    w = int(S * 0.10)

    pts = [
        (cx - int(cw * 0.28), cy + int(cw * 0.02)),
        (cx - int(cw * 0.06), cy + int(cw * 0.20)),
        (cx + int(cw * 0.30), cy - int(cw * 0.22)),
    ]
    d.line(pts, fill=ROSE, width=w, joint='curve')
    # Round caps -- PIL's line() leaves them square.
    for (px, py) in (pts[0], pts[2]):
        d.ellipse([px - w // 2, py - w // 2, px + w // 2, py + w // 2], fill=ROSE)

    return img


def main():
    img = build()
    for size in SIZES:
        out = f'extension/icons/icon{size}.png'
        img.resize((size, size), Image.LANCZOS).save(out)
        print(out)


if __name__ == '__main__':
    main()
