#!/usr/bin/env python3
"""TLS probes (v2.38): LAN mode serves HTTPS with the
persistent self-signed host cert, loopback stays plain
HTTP, and the fingerprint identity flow holds.

The fixture binds GHOST_IDE_HOST to 127.0.1.1 - a real
second local address the pair gate treats as a network
caller (client_address is not 127.0.0.1). All HTTP goes
through a proxy-free opener: the sandbox exports an
egress proxy whose no_proxy covers 127.0.0.1 but not
127.0.1.1, and urllib would otherwise route the LAN
checks through it and stall.
"""
import base64
import hashlib
import http.client
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPO = os.path.expanduser("~/workspace/ghost-ide")
LAN_IP = "127.0.1.1"
passed = 0
failed = 0


def ck(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print("PASS " + name)
    else:
        failed += 1
        print("FAIL " + name)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def opener(ctx=None):
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ctx))


def get(op, url, headers=None, timeout=8):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def post_json(op, url, obj, headers=None, timeout=8):
    data = json.dumps(obj).encode()
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def lan_https(ctx, port, method, path, headers=None, body=None):
    """One request from a LAN source address: binding
    the source to LAN_IP is what makes the server see
    a network caller (a loopback destination otherwise
    picks 127.0.0.1 as source and looks like the host)."""
    conn = http.client.HTTPSConnection(
        LAN_IP, port, context=ctx, timeout=8,
        source_address=(LAN_IP, 0))
    try:
        conn.request(method, path, body=body,
                     headers=headers or {})
        r = conn.getresponse()
        return r.status, r.read().decode("utf-8", "replace")
    finally:
        conn.close()


def lan_http(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection(
        LAN_IP, port, timeout=8,
        source_address=(LAN_IP, 0))
    try:
        conn.request(method, path, body=body,
                     headers=headers or {})
        r = conn.getresponse()
        return r.status, r.read().decode("utf-8", "replace")
    finally:
        conn.close()


def cert_fp(pem_bytes):
    body = b"".join(
        ln.strip() for ln in pem_bytes.splitlines()
        if ln and b"---" not in ln)
    h = hashlib.sha256(base64.b64decode(body)).hexdigest().upper()
    return ":".join(h[i:i + 2] for i in range(0, len(h), 2))


def start_server(port, tls_dir, ws, extra_env=None):
    env = dict(os.environ)
    env.update({
        "GHOST_IDE_HOST": LAN_IP,
        "GHOST_IDE_PORT": str(port),
        "GHOST_IDE_WORKSPACE": ws,
        "GHOST_IDE_TLS_DIR": tls_dir,
    })
    if extra_env:
        env.update(extra_env)
    log = open(os.path.join(ws, "boot.log"), "wb")
    proc = subprocess.Popen(
        [sys.executable, "-u", os.path.join(REPO, "server.py")],
        cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
    plain = opener()
    deadline = time.time() + 25
    while time.time() < deadline:
        try:
            st, _ = get(plain, f"http://127.0.0.1:{port}/api/health",
                        timeout=3)
            if st == 200:
                return proc, log
        except Exception:
            pass
        if proc.poll() is not None:
            break
        time.sleep(0.4)
    return proc, log


def boot_text(ws):
    try:
        with open(os.path.join(ws, "boot.log"), "rb") as f:
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def main():
    tmp = tempfile.mkdtemp(prefix="tlsprobe-")
    ws = os.path.join(tmp, "ws")
    tls_dir = os.path.join(tmp, "tls")
    os.makedirs(ws)
    port = free_port()
    proc, log = start_server(port, tls_dir, ws)
    try:
        cert_path = os.path.join(tls_dir, "host-cert.pem")
        key_path = os.path.join(tls_dir, "host-key.pem")
        meta_path = os.path.join(tls_dir, "host-cert.json")
        ck("cert, key and meta are generated in LAN mode",
           os.path.exists(cert_path) and os.path.exists(key_path)
           and os.path.exists(meta_path))
        ck("the key file is owner-only (0600)",
           (os.stat(key_path).st_mode & 0o777) == 0o600)
        with open(cert_path, "rb") as f:
            pem = f.read()
        real_fp = cert_fp(pem)
        meta = json.loads(open(meta_path).read())
        ck("meta fingerprint matches the cert's SHA-256",
           meta.get("fingerprint") == real_fp)
        ck("the cert SANs cover loopback and the LAN address",
           "127.0.0.1" in meta.get("sans", [])
           and LAN_IP in meta.get("sans", []))

        ctx = ssl.create_default_context(cafile=cert_path)
        secure = opener(ctx)
        st, body = get(secure, f"https://{LAN_IP}:{port}/api/health")
        ck("HTTPS health answers with the host cert", st == 200
           and '"version"' in body)

        plain = opener()
        stc, _ = get(plain, f"http://127.0.0.1:{port}/api/pair/certfp")
        fp_body = json.loads(_)
        ck("loopback certfp reports TLS on + the fingerprint",
           stc == 200 and fp_body.get("tls") is True
           and fp_body.get("fingerprint") == real_fp)

        stc, _ = lan_https(ctx, port, "GET", "/api/pair/certfp")
        ck("certfp from the LAN without a token is gated (401)",
           stc == 401)

        _, code_body = get(plain, f"http://127.0.0.1:{port}/api/pair/code")
        code = json.loads(code_body)["code"]
        stc, join_body = lan_https(
            ctx, port, "POST", "/api/pair/join",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"code": code, "id": "tlsprobe",
                             "name": "tlsprobe"}))
        token = json.loads(join_body).get("token", "")
        ck("a guest joins over HTTPS with the code",
           stc == 200 and bool(token))
        stc, _ = lan_https(ctx, port, "GET", "/api/pair/certfp",
                           headers={"X-Pair-Token": token})
        ck("certfp with a guest token stays host-only (403)",
           stc == 403)
        stc, _ = lan_https(ctx, port, "GET", "/api/files",
                           headers={"X-Pair-Token": token})
        ck("API calls ride the encrypted listener", stc == 200)

        decoy = os.path.join(tmp, "decoy.pem")
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048",
             "-keyout", os.path.join(tmp, "decoy-key.pem"),
             "-out", decoy, "-days", "30", "-nodes",
             "-subj", "/CN=decoy"],
            capture_output=True, timeout=60)
        bad_ctx = ssl.create_default_context(cafile=decoy)
        refused = False
        try:
            get(opener(bad_ctx), f"https://{LAN_IP}:{port}/api/health")
        except Exception:
            refused = True
        ck("a client trusting a different cert is refused", refused)

        plain_fail = False
        try:
            stc, _ = get(plain, f"http://{LAN_IP}:{port}/api/health",
                         timeout=5)
            plain_fail = stc != 200
        except Exception:
            plain_fail = True
        ck("plain HTTP to the LAN port gets no service", plain_fail)

        txt = boot_text(ws)
        ck("the console announces encrypted LAN mode + fingerprint",
           "LAN mode (encrypted)" in txt and real_fp in txt)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()

    # Second boot, same TLS dir: the fingerprint must not move.
    port2 = free_port()
    proc, log = start_server(port2, tls_dir, ws)
    try:
        plain = opener()
        _, body = get(plain, f"http://127.0.0.1:{port2}/api/pair/certfp")
        ck("the cert persists across restarts (same fingerprint)",
           json.loads(body).get("fingerprint") == real_fp)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()

    # Fallback: no cryptography module and no openssl on PATH.
    try:
        import cryptography  # noqa: F401
        have_crypto = True
    except ImportError:
        have_crypto = False
    if have_crypto:
        print("SKIP fallback checks (cryptography importable here)")
    else:
        empty_bin = os.path.join(tmp, "emptybin")
        os.makedirs(empty_bin)
        ws3 = os.path.join(tmp, "ws3")
        os.makedirs(ws3)
        port3 = free_port()
        proc, log = start_server(
            port3, os.path.join(tmp, "tls3"), ws3,
            extra_env={"PATH": empty_bin})
        try:
            stc, _ = lan_http(port3, "GET", "/api/health")
            ck("fallback serves plain HTTP on the LAN (gated 401)",
               stc == 401)
            txt = boot_text(ws3)
            ck("fallback prints the loud plain-HTTP warning",
               "serving PLAIN HTTP" in txt)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            log.close()

    print(f"TLS PROBES: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
