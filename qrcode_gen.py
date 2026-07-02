"""Minimal QR code SVG generator. Pure Python standard library.

Generates QR codes for short URLs (up to ~60 bytes). Byte-mode encoding
with error correction level M. Auto-selects the smallest sufficient version.
"""

# ── GF(256) arithmetic (primitive polynomial 0x11D) ──────────────────────

_EXP = [0] * 512
_LOG = [0] * 256

_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


# ── Reed-Solomon generator polynomial ────────────────────────────────────

def _rs_generator_poly(nsym: int) -> list[int]:
    g = [1]
    for i in range(nsym):
        g = [_gf_mul(x, y) for x, y in zip(g + [0], [0] + g)]
        g[0] ^= _EXP[i]
    return g


def _rs_encode(msg: list[int], nsym: int) -> list[int]:
    gen = _rs_generator_poly(nsym)
    result = msg + [0] * nsym
    for i in range(len(msg)):
        coef = result[i]
        if coef:
            for j in range(len(gen)):
                result[i + j] ^= _gf_mul(gen[j], coef)
    return result[-nsym:]


# ── Version capacity table (ECC level M) ─────────────────────────────────

_VERSION_CAPACITY = {
    1:  (26,  10, 1),   # 16 data
    2:  (44,  16, 1),   # 28 data
    3:  (70,  26, 1),   # 44 data
    4:  (100, 18, 2),   # 64 data
    5:  (134, 24, 2),   # 86 data
    6:  (172, 18, 4),   # 100 data
    7:  (196, 20, 4),   # 116 data
    8:  (242, 24, 4),   # 142 data
    9:  (292, 30, 4),   # 172 data
    10: (346, 18, 6),   # 238 data
}

_PENALTY_N1 = 3
_PENALTY_N2 = 3
_PENALTY_N3 = 40
_PENALTY_N4 = 10


def _select_version(byte_count: int) -> int:
    for ver in sorted(_VERSION_CAPACITY):
        total, ecc_per, num_blocks = _VERSION_CAPACITY[ver]
        data_cw = total - ecc_per * num_blocks
        if byte_count + 2 <= data_cw:
            return ver
    return 10


def _encode_data(data: bytes, ver: int) -> tuple[list[int], int, int, int]:
    """Return (all_codewords, data_cw_per_block, ecc_cw_per_block, num_blocks)."""
    total, ecc_per, num_blocks = _VERSION_CAPACITY[ver]
    data_total = total - ecc_per * num_blocks

    bits: list[int] = []
    bits += [0, 1, 0, 0]  # byte mode
    count_bits = 16 if ver >= 10 else 8
    n = len(data)
    for i in range(count_bits - 1, -1, -1):
        bits.append((n >> i) & 1)
    for b in data:
        for i in range(7, -1, -1):
            bits.append((b >> i) & 1)
    max_terminator = min(4, data_total * 8 - len(bits))
    bits += [0] * max_terminator
    while len(bits) % 8:
        bits.append(0)
    cw = []
    for i in range(0, len(bits), 8):
        val = 0
        for j in range(8):
            if i + j < len(bits):
                val = (val << 1) | bits[i + j]
        cw.append(val)
    pad = [0xEC, 0x11]
    pi = 0
    while len(cw) < data_total:
        cw.append(pad[pi % 2])
        pi += 1

    data_per_block = data_total // num_blocks
    blocks = [cw[i * data_per_block:(i + 1) * data_per_block] for i in range(num_blocks)]
    ecc_blocks = [_rs_encode(b, ecc_per) for b in blocks]

    result = []
    for i in range(data_per_block):
        for b in blocks:
            if i < len(b):
                result.append(b[i])
    remainder = data_total - data_per_block * num_blocks
    if remainder:
        for b in blocks:
            if len(b) > data_per_block:
                result.append(b[data_per_block])
    for i in range(ecc_per):
        for eb in ecc_blocks:
            result.append(eb[i])
    return result, data_per_block, ecc_per, num_blocks


# ── Matrix builder ───────────────────────────────────────────────────────

def _build_matrix(ver: int) -> tuple[list[list[int]], list[list[bool]]]:
    """Return (pattern_matrix, reserved_mask).
    pattern_matrix[r][c] holds 0/1 for pattern cells; data cells are 0.
    reserved_mask[r][c] is True for cells NOT available for data.
    """
    size = 17 + ver * 4
    mat = [[0] * size for _ in range(size)]
    reserved = [[False] * size for _ in range(size)]

    # Finder patterns (3 corners)
    for r, c in [(0, 0), (0, size - 7), (size - 7, 0)]:
        for i in range(7):
            for j in range(7):
                reserved[r + i][c + j] = True
                mat[r + i][c + j] = 1 if (i in (0, 6) or j in (0, 6) or (2 <= i <= 4 and 2 <= j <= 4)) else 0

    # Separators: 1-module white border adjacent to each finder (two inward sides)
    for r0, c0, sides in [
        (0, 0, [('bottom', 7), ('right', 7)]),
        (0, size - 7, [('bottom', 7), ('left', size - 8)]),
        (size - 7, 0, [('top', size - 8), ('right', 7)]),
    ]:
        for direction, coord in sides:
            if direction in ('top', 'bottom'):
                rr = coord
                for j in range(8):
                    cc = c0 + j
                    if 0 <= rr < size and 0 <= cc < size and not reserved[rr][cc]:
                        reserved[rr][cc] = True
                        mat[rr][cc] = 0
            else:
                cc = coord
                for i in range(8):
                    rr = r0 + i
                    if 0 <= rr < size and 0 <= cc < size and not reserved[rr][cc]:
                        reserved[rr][cc] = True
                        mat[rr][cc] = 0

    # Timing patterns
    for i in range(size):
        reserved[i][6] = True
        reserved[6][i] = True
        if 8 <= i < size - 8:
            mat[i][6] = i % 2
            mat[6][i] = i % 2

    # Alignment patterns (version >= 2)
    if ver >= 2:
        positions = _alignment_positions(ver)
        for r in positions:
            for c in positions:
                if r == 6 and c == 6:
                    continue  # overlaps with timing, already marked
                if r == 6 and c == size - 7:
                    continue  # overlaps finder separator
                if r == size - 7 and c == 6:
                    continue
                if r <= 8 and c <= 8:
                    continue  # overlaps top-left finder
                if r <= 8 and c >= size - 9:
                    continue  # overlaps top-right finder
                if r >= size - 9 and c <= 8:
                    continue  # overlaps bottom-left finder
                for i in range(-2, 3):
                    for j in range(-2, 3):
                        rr, cc = r + i, c + j
                        if 0 <= rr < size and 0 <= cc < size:
                            reserved[rr][cc] = True
                            mat[rr][cc] = 1 if (abs(i) == 2 or abs(j) == 2 or (i == 0 and j == 0)) else 0

    # Format info areas (around finders + dark module)
    for i in range(9):
        reserved[i][8] = True       # col 8, rows 0-8 (below top-left finder)
        if i < 8:
            reserved[8][i] = True   # row 8, cols 0-7 (right of bottom-left finder, bit 14-8)
            reserved[8][size - 1 - i] = True  # row 8, cols size-8..size-1 (below top-right)
            reserved[size - 1 - i][8] = True  # col 8, rows size-8..size-1 (above bottom-left)
    # Dark module
    reserved[size - 8][8] = True

    # Version info areas (ver >= 7) — reserved but we don't place it
    if ver >= 7:
        for i in range(6):
            for j in range(3):
                reserved[size - 11 + i][j] = True
                reserved[j][size - 11 + i] = True

    # Dark module (also within format info area)
    mat[size - 8][8] = 1

    return mat, reserved


def _alignment_positions(ver: int) -> list[int]:
    if ver == 1:
        return []
    num = ver // 7 + 2
    positions = [6]
    step = (ver * 4 + 4) / (num - 1) if num > 1 else 1
    while len(positions) < num:
        last = positions[-1]
        nxt = round(last + step)
        if nxt >= ver * 4 + 10 - 1:
            break
        if nxt not in positions:
            positions.append(nxt)
    return sorted(positions)


# ── Mask patterns ─────────────────────────────────────────────────────────

def _mask_condition(mask: int, row: int, col: int) -> bool:
    if mask == 0: return (row + col) % 2 == 0
    if mask == 1: return row % 2 == 0
    if mask == 2: return col % 3 == 0
    if mask == 3: return (row + col) % 3 == 0
    if mask == 4: return (row // 2 + col // 3) % 2 == 0
    if mask == 5: return (row * col) % 2 + (row * col) % 3 == 0
    if mask == 6: return ((row * col) % 2 + (row * col) % 3) % 2 == 0
    if mask == 7: return ((row + col) % 2 + (row * col) % 3) % 2 == 0
    return False


def _is_data_module(reserved: list[list[bool]], r: int, c: int) -> bool:
    return not reserved[r][c]


def _evaluate_mask(reserved: list[list[bool]], module_vals: list[list[int]]) -> int:
    size = len(reserved)
    score = 0

    for r in range(size):
        run = 0
        last = -1
        for c in range(size):
            if reserved[r][c]:
                continue
            val = module_vals[r][c]
            if val == last:
                run += 1
            else:
                if run >= 5:
                    score += _PENALTY_N1 + run - 5
                run = 1
                last = val
        if run >= 5:
            score += _PENALTY_N1 + run - 5

    for c in range(size):
        run = 0
        last = -1
        for r in range(size):
            if reserved[r][c]:
                continue
            val = module_vals[r][c]
            if val == last:
                run += 1
            else:
                if run >= 5:
                    score += _PENALTY_N1 + run - 5
                run = 1
                last = val
        if run >= 5:
            score += _PENALTY_N1 + run - 5

    for r in range(size - 1):
        for c in range(size - 1):
            if not any(reserved[r + dr][c + dc] for dr in (0, 1) for dc in (0, 1)):
                if module_vals[r][c] == module_vals[r + 1][c] == module_vals[r][c + 1] == module_vals[r + 1][c + 1]:
                    score += _PENALTY_N2

    for r in range(size):
        for c in range(size - 6):
            if not any(reserved[r][c + i] for i in range(7)):
                if [module_vals[r][c + i] for i in range(7)] == [1, 0, 1, 1, 1, 0, 1]:
                    score += _PENALTY_N3
    for c in range(size):
        for r in range(size - 6):
            if not any(reserved[r + i][c] for i in range(7)):
                if [module_vals[r + i][c] for i in range(7)] == [1, 0, 1, 1, 1, 0, 1]:
                    score += _PENALTY_N3

    dark = sum(1 for r in range(size) for c in range(size)
               if not reserved[r][c] and module_vals[r][c])
    total = sum(1 for r in range(size) for c in range(size) if not reserved[r][c])
    if total:
        pct = dark * 100 // total
        score += abs(pct // 5 - 10) * _PENALTY_N4

    return score


# ── Format information ────────────────────────────────────────────────────

def _format_info(ecl_idx: int, mask: int) -> int:
    data = (ecl_idx << 3) | mask  # 5 bits
    bch = data << 10
    gen = 0b10100110111
    for i in range(4, -1, -1):
        if bch & (1 << (i + 10)):
            bch ^= gen << i
    return ((data << 10) | (bch & 0x3FF)) ^ 0x5412


# ── Main generator ────────────────────────────────────────────────────────

def generate_qr_svg(data: str, border: int = 3, module_size: int = 5) -> str:
    raw = data.encode("utf-8")
    ver = _select_version(len(raw))
    size = 17 + ver * 4

    codewords, data_per_block, ecc_per, num_blocks = _encode_data(raw, ver)
    total_cw = len(codewords)

    pattern, reserved = _build_matrix(ver)

    best_mask = 0
    best_score = float("inf")
    best_placed: list[list[int]] | None = None

    for mask in range(8):
        placed = [row[:] for row in pattern]
        col = size - 1
        up = True
        bit_idx = 0
        while col > 0:
            if col == 6:
                col -= 1
            cols = [col, col - 1]
            rows = range(size - 1, -1, -1) if up else range(size)
            for r in rows:
                for c in cols:
                    if not reserved[r][c] and bit_idx < total_cw * 8:
                        cw_idx = bit_idx // 8
                        bit_pos = 7 - (bit_idx % 8)
                        val = (codewords[cw_idx] >> bit_pos) & 1
                        if _mask_condition(mask, r, c):
                            val ^= 1
                        placed[r][c] = val
                        bit_idx += 1
            col -= 2
            up = not up

        score = _evaluate_mask(reserved, placed)
        if score < best_score:
            best_score = score
            best_mask = mask
            best_placed = placed

    # Apply format info
    fmt = _format_info(0, best_mask)
    for i in range(8):
        if i < 6:
            best_placed[i][8] = (fmt >> i) & 1
        best_placed[8][size - 1 - i] = (fmt >> i) & 1
    for i in range(8):
        best_placed[size - 8 + i][8] = (fmt >> (14 - i)) & 1
        if i >= 1:
            best_placed[8][6 - i] = (fmt >> (14 - i)) & 1
        else:
            best_placed[8][7] = (fmt >> 13) & 1
    best_placed[size - 8][8] = 1

    # Fix timing patterns (ensure alternating, not overwritten by format)
    for i in range(8, size - 8):
        best_placed[i][6] = i % 2
        best_placed[6][i] = i % 2

    # Render SVG
    svg_size = (size + 2 * border) * module_size
    lines = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {svg_size} {svg_size}" width="{svg_size}" height="{svg_size}">']
    lines.append(f'<rect width="{svg_size}" height="{svg_size}" fill="#fff"/>')
    for r in range(size):
        for c in range(size):
            if best_placed[r][c]:
                x = (c + border) * module_size
                y = (r + border) * module_size
                lines.append(f'<rect x="{x}" y="{y}" width="{module_size}" height="{module_size}" fill="#000"/>')
    lines.append("</svg>")
    return "\n".join(lines)
