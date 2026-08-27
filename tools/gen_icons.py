#!/usr/bin/env python3
"""生成插件图标 icons/icon{16,48,128}.png。

深蓝圆角方块（VS Code 按钮蓝 #0e639c）+ 白色 "<>" 尖括号。
纯标准库实现（zlib 手写 PNG chunk），无需 Pillow。用法：

    python3 tools/gen_icons.py
"""

import struct
import zlib
from pathlib import Path

SIZES = (16, 48, 128)
BG = (14, 99, 156)        # #0e639c VS Code 蓝
FG = (255, 255, 255)      # 白

# "<>" 两段折线，坐标在 16x16 设计空间内：(x, y)
STROKES = [
    [(10.5, 3.5), (4.5, 8.0), (10.5, 12.5)],   # <
    [(5.5, 3.5), (11.5, 8.0), (5.5, 12.5)],    # >
]
HALF_WIDTH = 1.05          # 线宽的一半（设计空间）
SS = 8                     # 超采样倍数（抗锯齿）
CORNER_RADIUS = 2.6        # 圆角半径（设计空间）


def _dist_point_seg(px, py, x1, y1, x2, y2):
    vx, vy = x2 - x1, y2 - y1
    wx, wy = px - x1, py - y1
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    dx, dy = px - (x1 + t * vx), py - (y1 + t * vy)
    return (dx * dx + dy * dy) ** 0.5


def _coverage(px, py):
    """单个设计空间采样点的墨水覆盖率：折线 × 圆角方块。"""
    ink = 0.0
    for pts in STROKES:
        d = min(
            _dist_point_seg(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
            for i in range(len(pts) - 1)
        )
        ink = max(ink, min(1.0, HALF_WIDTH - d + 0.5))

    r = CORNER_RADIUS
    dx = min(max(px, r), 16 - r) - px
    dy = min(max(py, r), 16 - r) - py
    outside_corner = (dx * dx + dy * dy) > r * r
    inside_box = 0 <= px <= 16 and 0 <= py <= 16
    bg = 0.0 if (outside_corner or not inside_box) else 1.0

    # 前景叠在背景上，返回 (背景覆盖, 前景覆盖)
    return bg, ink


def render(size: int) -> bytes:
    """渲染 size×size RGBA PNG 文件字节。"""
    n = size * SS
    # 设计空间固定 16x16，采样步长随目标尺寸缩放
    step = 16.0 / n
    acc_bg = [[0.0] * size for _ in range(size)]
    acc_fg = [[0.0] * size for _ in range(size)]

    for sy in range(n):
        for sx in range(n):
            # 设计空间坐标：像素中心
            u = (sx + 0.5) * step
            v = (sy + 0.5) * step
            bg, fg = _coverage(u, v)
            acc_bg[sy // SS][sx // SS] += bg
            acc_fg[sy // SS][sx // SS] += fg

    denom = float(SS * SS)
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # PNG filter type: None
        for x in range(size):
            b = acc_bg[y][x] / denom
            f = acc_fg[y][x] / denom
            color = tuple(round(BG[i] * b + FG[i] * f) for i in range(3))
            alpha = round(255 * max(b, f))
            raw.extend((*color, alpha))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    out_dir = Path(__file__).resolve().parent.parent / "icons"
    out_dir.mkdir(exist_ok=True)
    for size in SIZES:
        path = out_dir / f"icon{size}.png"
        path.write_bytes(render(size))
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
