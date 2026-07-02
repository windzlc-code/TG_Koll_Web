from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


def build_icon(size: int = 512) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle((28, 28, size - 28, size - 28), radius=108, fill=(15, 138, 95, 255))
    draw.rounded_rectangle((74, 74, size - 74, size - 74), radius=84, fill=(244, 248, 251, 255))
    draw.rounded_rectangle((118, 118, size - 118, size - 118), radius=64, fill=(15, 23, 42, 255))

    draw.rounded_rectangle((154, 168, 358, 356), radius=34, fill=(255, 255, 255, 255))
    draw.rounded_rectangle((344, 196, 394, 314), radius=22, fill=(245, 158, 11, 255))

    draw.rounded_rectangle((166, 190, 318, 214), radius=10, fill=(15, 138, 95, 255))
    draw.rounded_rectangle((166, 230, 318, 254), radius=10, fill=(203, 213, 225, 255))
    draw.rounded_rectangle((166, 270, 318, 294), radius=10, fill=(203, 213, 225, 255))
    draw.rounded_rectangle((166, 310, 280, 334), radius=10, fill=(203, 213, 225, 255))
    draw.ellipse((292, 306, 324, 338), fill=(15, 138, 95, 255))

    return img


def main() -> int:
    out_dir = Path(__file__).resolve().parent
    out_dir.mkdir(parents=True, exist_ok=True)

    png_path = out_dir / "desktop-icon.png"
    ico_path = out_dir / "desktop-icon.ico"

    img = build_icon()
    img.save(png_path)
    img.save(
        ico_path,
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(png_path)
    print(ico_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
