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
    """Build generator polynomial g(x) of degree nsym over GF(256)."""
    g = [1]
    for i in range(nsym):
        g = [_gf_mul(x, y) for x, y in zip(g + [0], [0] + g)]
        g[0] ^= _EXP[i]  # multiply by (x - α^i)
    return g


def _rs_encode(msg: list[int], nsym: int) -> list[int]:
    """Return ECC codewords for msg (length n) with nsym ECC symbols."""
    gen = _rs_generator_poly(nsym)
    result = msg + [0] * nsym
    for i in range(len(msg)):
        coef = result[i]
        if coef:
            for j in range(len(gen)):
                result[i + j] ^= _gf_mul(gen[j], coef)
    return result[-nsym:]


# ── Version capacity table (ECC level M) ─────────────────────────────────
# (total codewords, ECC codewords per block, number of blocks, data codewords)

_VERSION_CAPACITY = {
    # ver: (total_cw, ecc_per_block, num_blocks) → data_cw = total_cw - ecc_per_block * num_blocks
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
    """Select smallest version that can hold byte_count bytes (byte mode, M ECC)."""
    # Overhead: mode(4) + count(8) + terminator(4) → 2 bytes, pad to codeword boundary
    for ver in sorted(_VERSION_CAPACITY):
        total, ecc_per, num_blocks = _VERSION_CAPACITY[ver]
        data_cw = total - ecc_per * num_blocks
        if byte_count + 2 <= data_cw:
            return ver
    return 10  # fallback


def _encode_data(data: bytes, ver: int) -> tuple[list[int], int, int, int]:
    """Return (all_codewords, data_cw_per_block, ecc_cw_per_block, num_blocks)."""
    total, ecc_per, num_blocks = _VERSION_CAPACITY[ver]
    data_total = total - ecc_per * num_blocks

    # Byte mode: mode(4) + count(8) + data(8×n) + terminator(4)
    bits: list[int] = []
    # mode indicator: 0100
    bits += [0, 1, 0, 0]
    # character count indicator (8 bits for ver 1-9, 16 for 10+)
    count_bits = 16 if ver >= 10 else 8
    n = len(data)
    for i in range(count_bits - 1, -1, -1):
        bits.append((n >> i) & 1)
    # data bytes
    for b in data:
        for i in range(7, -1, -1):
            bits.append((b >> i) & 1)
    # terminator (up to 4 zero bits)
    max_terminator = min(4, data_total * 8 - len(bits))
    bits += [0] * max_terminator
    # pad to 8 bits
    while len(bits) % 8:
        bits.append(0)
    # to codewords
    cw = []
    for i in range(0, len(bits), 8):
        val = 0
        for j in range(8):
            if i + j < len(bits):
                val = (val << 1) | bits[i + j]
        cw.append(val)
    # pad to data_total codewords with 0xEC, 0x11 alternating
    pad = [0xEC, 0x11]
    pi = 0
    while len(cw) < data_total:
        cw.append(pad[pi % 2])
        pi += 1

    # Split into blocks and generate ECC
    data_per_block = data_total // num_blocks
    blocks = [cw[i * data_per_block:(i + 1) * data_per_block] for i in range(num_blocks)]
    ecc_blocks = [_rs_encode(b, ecc_per) for b in blocks]

    # Interleave: all data bytes from each block, then all ECC bytes
    result = []
    for i in range(data_per_block):
        for b in blocks:
            if i < len(b):
                result.append(b[i])
    # Handle remainder if data_total not evenly divided
    remainder = data_total - data_per_block * num_blocks
    if remainder:
        for b in blocks:
            if len(b) > data_per_block:
                result.append(b[data_per_block])
    for i in range(ecc_per):
        for eb in ecc_blocks:
            result.append(eb[i])
    return result, data_per_block, ecc_per, num_blocks


# ── Module placement ─────────────────────────────────────────────────────

def _build_matrix(ver: int) -> list[list[int]]:
    """Build empty QR matrix with finder/timing/alignment patterns placed."""
    size = 17 + ver * 4
    mat = [[0] * size for _ in range(size)]

    # Finder patterns (3 corners)
    for r, c in [(0, 0), (0, size - 7), (size - 7, 0)]:
        for i in range(7):
            for j in range(7):
                mat[r + i][c + j] = 1 if (i in (0, 6) or j in (0, 6) or (2 <= i <= 4 and 2 <= j <= 4)) else 0

    # Timing patterns
    for i in range(8, size - 8):
        mat[6][i] = mat[i][6] = (i + 1) % 2

    # Alignment patterns (version >= 2)
    if ver >= 2:
        positions = _alignment_positions(ver)
        for r in positions:
            for c in positions:
                # Skip if overlapping with finder patterns
                skip = False
                for fr, fc in [(0, 0), (0, size - 7), (size - 7, 0)]:
                    if abs(r - fr) <= 3 and abs(c - fc) <= 3:
                        skip = True
                        break
                if skip:
                    continue
                for i in range(-2, 3):
                    for j in range(-2, 3):
                        mat[r + i][c + j] = 1 if (abs(i) == 2 or abs(j) == 2 or (i == 0 and j == 0)) else 0

    # Dark module
    mat[size - 8][8] = 1

    return mat


def _alignment_positions(ver: int) -> list[int]:
    """Return alignment pattern center coordinates for version."""
    if ver == 1:
        return []
    num = ver // 7 + 2  # number of alignment patterns
    step = (ver * 4 + 10) / (num - 1) if num > 1 else 0
    positions = [6]
    pos = ver * 4 + 10 - 6 - 1  # last position
    for _ in range(num - 1):
        val = round(pos)
        if val not in positions:
            positions.append(val)
        pos -= step
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


def _is_data_module(mat: list[list[int]], r: int, c: int) -> bool:
    """Check if (r, c) is free for data (not reserved)."""
    return mat[r][c] == 0


def _evaluate_mask(mat: list[list[int]], data_mask: list[list[bool]]) -> int:
    """Evaluate penalty score for a mask and return the score."""
    size = len(mat)
    score = 0

    # Condition 1: 5+ same-colour modules in a row/column
    for r in range(size):
        run = 0
        last = -1
        for c in range(size):
            if not _is_data_module(mat, r, c):
                continue
            val = 1 if data_mask[r][c] else 0
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
            if not _is_data_module(mat, r, c):
                continue
            val = 1 if data_mask[r][c] else 0
            if val == last:
                run += 1
            else:
                if run >= 5:
                    score += _PENALTY_N1 + run - 5
                run = 1
                last = val
        if run >= 5:
            score += _PENALTY_N1 + run - 5

    # Condition 2: 2×2 blocks of same colour
    for r in range(size - 1):
        for c in range(size - 1):
            if all(_is_data_module(mat, r + dr, c + dc) for dr in (0, 1) for dc in (0, 1)):
                vals = [data_mask[r + dr][c + dc] for dr in (0, 1) for dc in (0, 1)]
                if vals[0] == vals[1] == vals[2] == vals[3]:
                    score += _PENALTY_N2

    # Condition 3: finder-pattern-like sequences
    for r in range(size):
        for c in range(size - 6):
            if all(_is_data_module(mat, r, c + i) for i in range(7)):
                vals = [data_mask[r][c + i] for i in range(7)]
                if vals == [1, 0, 1, 1, 1, 0, 1]:
                    score += _PENALTY_N3
    for c in range(size):
        for r in range(size - 6):
            if all(_is_data_module(mat, r + i, c) for i in range(7)):
                vals = [data_mask[r + i][c] for i in range(7)]
                if vals == [1, 0, 1, 1, 1, 0, 1]:
                    score += _PENALTY_N3

    # Condition 4: dark/light balance
    dark = sum(1 for r in range(size) for c in range(size) if _is_data_module(mat, r, c) and data_mask[r][c])
    total_data = sum(1 for r in range(size) for c in range(size) if _is_data_module(mat, r, c))
    if total_data:
        pct = dark * 100 // total_data
        score += abs(pct // 5 - 10) * _PENALTY_N4

    return score


# ── Format information ────────────────────────────────────────────────────

def _format_info(ecl_idx: int, mask: int) -> int:
    """Generate 15-bit format information string (ECL M = ecl_idx 0)."""
    data = (ecl_idx << 3) | mask  # 5 bits
    # BCH (15,5) encoding with generator polynomial x^10 + x^8 + x^5 + x^4 + x^2 + x + 1
    bch = data << 10
    gen = 0b10100110111  # x^10 + x^8 + x^5 + x^4 + x^2 + x + 1
    for i in range(4, -1, -1):
        if bch & (1 << (i + 10)):
            bch ^= gen << i
    return ((data << 10) | (bch & 0x3FF)) ^ 0x5412  # XOR mask


# ── Main generator ────────────────────────────────────────────────────────

def generate_qr_svg(data: str, border: int = 3, module_size: int = 5) -> str:
    """Generate QR code as SVG string for the given data string."""
    raw = data.encode("utf-8")
    ver = _select_version(len(raw))
    size = 17 + ver * 4

    # Encode data
    codewords, data_per_block, ecc_per, num_blocks = _encode_data(raw, ver)
    total_cw = len(codewords)

    # Build empty matrix
    mat = _build_matrix(ver)

    # Place data bits using best mask
    best_mask = 0
    best_score = float("inf")
    best_placed: list[list[bool]] | None = None

    for mask in range(8):
        placed = [row[:] for row in mat]
        # Fill data modules in QR order (right-to-left, zigzag)
        col = size - 1
        up = True
        bit_idx = 0
        while col > 0:
            if col == 6:
                col -= 1  # skip vertical timing column
            cols = [col, col - 1] if col > 0 else [col]
            rows = range(size - 1, -1, -1) if up else range(size)
            for r in rows:
                for c in cols:
                    if _is_data_module(mat, r, c) and bit_idx < total_cw * 8:
                        cw_idx = bit_idx // 8
                        bit_pos = 7 - (bit_idx % 8)
                        val = (codewords[cw_idx] >> bit_pos) & 1
                        if _mask_condition(mask, r, c):
                            val ^= 1
                        placed[r][c] = val
                        bit_idx += 1
            col -= 2
            up = not up

        score = _evaluate_mask(mat, placed)
        if score < best_score:
            best_score = score
            best_mask = mask
            best_placed = placed

    # Format info (ECL M = 0 for byte mode QR)
    fmt = _format_info(0, best_mask)
    # Place format info around finder patterns
    for i in range(8):
        if i < 6:
            best_placed[i][8] = (fmt >> i) & 1
        best_placed[8][size - 1 - i] = (fmt >> i) & 1
    for i in range(8):
        best_placed[size - 8 + i][8] = (fmt >> (14 - i)) & 1
        if i < 7:
            best_placed[8][5 - i + (1 if i >= 5 else 0)] = (fmt >> (14 - i)) & 1
    best_placed[size - 8][8] = 1  # dark module is always dark

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
