#!/usr/bin/env python3
"""Pure-Python Ed25519 (Roadmap G37) - signing and verifying
GhostIDE registry packs with the stdlib only, matching the
compact BigInt verifier in the IDE's frontend. This is the
classic reference formulation: correct over fast. Signing a
small pack takes well under a second.

Keys: the private key is a 32-byte seed (hex). The public
key is 32 bytes (hex). Signatures are 64 bytes (hex).
"""
import hashlib

_B = 256
_Q = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493


def _h(m):
    return hashlib.sha512(m).digest()


def _inv(x):
    return pow(x, _Q - 2, _Q)


_D = (-121665 * _inv(121666)) % _Q
_I = pow(2, (_Q - 1) // 4, _Q)


def _xrecover(y):
    xx = (y * y - 1) * _inv(_D * y * y + 1) % _Q
    x = pow(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q != 0:
        x = (x * _I) % _Q
    if x % 2 != 0:
        x = _Q - x
    return x


_BY = (4 * _inv(5)) % _Q
_BX = _xrecover(_BY)
_BASE = [_BX % _Q, _BY % _Q]


def _edwards(p, q):
    x1, y1 = p
    x2, y2 = q
    t = _D * x1 * x2 * y1 * y2 % _Q
    x3 = (x1 * y2 + x2 * y1) * _inv(1 + t) % _Q
    y3 = (y1 * y2 + x1 * x2) * _inv(1 - t) % _Q
    return [x3, y3]


def _scalarmult(p, e):
    if e == 0:
        return [0, 1]
    q = _scalarmult(p, e // 2)
    q = _edwards(q, q)
    if e & 1:
        q = _edwards(q, p)
    return q


def _encodeint(y):
    return y.to_bytes(32, "little")


def _encodepoint(p):
    x, y = p
    bits = y | ((x & 1) << 255)
    return bits.to_bytes(32, "little")


def _bit(h, i):
    return (h[i // 8] >> (i % 8)) & 1


def _decodeint(s):
    return int.from_bytes(s, "little")


def _decodepoint(s):
    y = int.from_bytes(s, "little") & ((1 << 255) - 1)
    sign = (int.from_bytes(s, "little") >> 255) & 1
    x = _xrecover(y)
    if x & 1 != sign:
        x = _Q - x
    return [x, y]


def _hint(m):
    return int.from_bytes(_h(m), "little")


def _clamp(h):
    a = 2 ** (_B - 2)
    for i in range(3, _B - 2):
        a += 2 ** i * _bit(h, i)
    return a


def publickey(seed32):
    h = _h(seed32)
    a = _clamp(h)
    return _encodepoint(_scalarmult(_BASE, a))


def sign(msg, seed32, pub32):
    h = _h(seed32)
    a = _clamp(h)
    r = _hint(h[_B // 8:_B // 4] + msg)
    rr = _scalarmult(_BASE, r)
    enc_r = _encodepoint(rr)
    s = (r + _hint(enc_r + pub32 + msg) * a) % _L
    return enc_r + _encodeint(s)


def verify(sig64, msg, pub32):
    if len(sig64) != 64 or len(pub32) != 32:
        return False
    r = _decodepoint(sig64[:32])
    a = _decodepoint(pub32)
    s = _decodeint(sig64[32:])
    if s >= _L:
        return False
    h = _hint(sig64[:32] + pub32 + msg)
    return _scalarmult(_BASE, s) == _edwards(
        r, _scalarmult(a, h))
