#!/usr/bin/env python3
"""insert-strings 后处理（必跑）：还原共享字节串 + 终止符碰撞修复 + 可选引擎补丁。

背景（2026-09/06 EliteRedux 设置页"文字消失/小字消失"）：
  消息串的尾部字节常被其它指针引用为独立子串（设置页值串 "Easy"/"Disabled"、
  描述副本、宝可梦名表首字母）。旧版 insert 的"残尾清 FF/原址清 FF"把这些字节
  擦掉 → 值列/描述空白。insert-strings.js 自 2026-09-06 起默认不清尾；
  本脚本负责：
  1) 毯式还原：FF 填充区（保留每行 mt 自己的终止符）还原为 pristine base 原文
     —— 同时修复旧构建（清尾时代）继承的损伤；
  2) 终止符碰撞修复：FF-run 首字节（mt 终止符）恰落在被指针引用的原文字节上时，
     终止符回退 1 字节并还原该字节（仅 mt 末字节为 ASCII 时可字节级修，
     CJK 结尾的需在 CSV 缩短该行译文后重插）；
  3) --gsw-patch：EliteRedux GSW 0xF7 中和补丁（踩坑 40；基座已含补丁则自动跳过）。

用法:
  python restore-tails.py <insert输出.gba> <pristine原版.gba> <out.gba> [--gsw-patch]
"""
import sys

GSW_OFF = 0x82577BC - 0x08000000
GSW_ORIG = bytes.fromhex('6878B8F65FF98346')
GSW_PATCH = bytes.fromhex('0C3C02350237E0E7')

def main():
    src, basep, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    gsw = '--gsw-patch' in sys.argv
    base = open(basep, 'rb').read()
    cur = bytearray(open(src, 'rb').read())
    N = min(len(cur), len(base))

    # 1) 毯式还原：FF-run 内（保留首字节 = mt 终止符）还原 base
    restored = 0
    i = 0
    while i < N:
        if cur[i] == 0xFF:
            j = i
            while j < N and cur[j] == 0xFF:
                j += 1
            if j - i >= 2:
                for k in range(i + 1, j):
                    if cur[k] != base[k]:
                        cur[k] = base[k]
                        restored += 1
            i = j
        else:
            i += 1

    # 指针目标集合（从 pristine base 扫，2 字节步进；指针表在两个 ROM 中同位同值）
    ptrs = set()
    for off in range(0, N - 3, 2):
        w = base[off] | (base[off+1] << 8) | (base[off+2] << 16) | (base[off+3] << 24)
        if 0x08000000 <= w < 0x09000000:
            ptrs.add(w - 0x08000000)

    # 2) 终止符碰撞修复（3 轮迭代处理级联）
    fixed = skipped = 0
    for _ in range(3):
        i = 0
        fixed_this = 0
        while i < N:
            if cur[i] == 0xFF:
                j = i
                while j < N and cur[j] == 0xFF:
                    j += 1
                a = i
                if a in ptrs and base[a] != 0xFF and a >= 1 and cur[a-1] != 0xFF:
                    if a >= 3 and cur[a-3] == 0xF7 and 0x01 <= cur[a-2] <= 0x1E:
                        skipped += 1        # mt 末字节是 CJK 的 lo，字节级截断会碎字 → CSV 处理
                    else:
                        cur[a-1] = 0xFF
                        cur[a] = base[a]
                        fixed += 1
                        fixed_this += 1
                i = j
            else:
                i += 1
        if fixed_this == 0:
            break

    # 3) 可选 GSW 补丁（已打则跳过）
    gswmsg = 'n/a'
    if gsw:
        if cur[GSW_OFF:GSW_OFF+8] == GSW_ORIG:
            cur[GSW_OFF:GSW_OFF+8] = GSW_PATCH
            gswmsg = 'applied'
        elif cur[GSW_OFF:GSW_OFF+8] == GSW_PATCH:
            gswmsg = 'already'
        else:
            print('⚠ GSW 原文不匹配（非 EliteRedux 基座？），跳过 GSW 补丁')
            gswmsg = 'skipped-base-mismatch'

    open(dst, 'wb').write(bytes(cur))
    print(f'{dst}: 还原 {restored} 字节, 碰撞修复 {fixed} (CJK 待 CSV {skipped}), GSW: {gswmsg}')

if __name__ == '__main__':
    main()
