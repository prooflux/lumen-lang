#!/usr/bin/env python3
# Scripting-language baseline for the HTTP/1.1 server hot path, mirroring examples/http/http_serve.lm
# byte-for-byte: parse the request line, linear-scan a route table for a method+path match, and build
# the exact same response bytes. Same algorithm as the Lumen kernel, so native/http_serve_bench.mjs
# can compare the compiled-native artifact against interpreted scripting on identical work.
#
# Usage: python3 http_serve_bench.py <iterations>   -> prints a checksum (sum of response lengths).
import sys

REQUEST = b"GET /home HTTP/1.1\r\nHost: x\r\n\r\n"

# (method, path, status, reason, content-type, body). /home is placed last so the linear scan does
# the same amount of work the Lumen kernel does for the same request.
ROUTES = [
    (b"GET", b"/", 200, b"OK", b"text/plain", b"hi"),
    (b"GET", b"/health", 200, b"OK", b"text/plain", b"ok"),
    (b"POST", b"/api", 200, b"OK", b"application/json", b"{}"),
    (b"GET", b"/home", 200, b"OK", b"text/html; charset=utf-8", b"<h1>Home</h1>"),
]

NOT_FOUND = (404, b"Not Found", b"text/plain", b"Not Found")


def serve_one(req):
    sp1 = req.find(b" ")
    method = req[:sp1]
    sp2 = req.find(b" ", sp1 + 1)
    path = req[sp1 + 1 : sp2]
    status, reason, ctype, body = NOT_FOUND
    for m, p, st, rs, ct, bd in ROUTES:
        if m == method and p == path:
            status, reason, ctype, body = st, rs, ct, bd
            break
    resp = (
        b"HTTP/1.1 "
        + str(status).encode()
        + b" "
        + reason
        + b"\r\nContent-Type: "
        + ctype
        + b"\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\nConnection: close\r\n\r\n"
        + body
    )
    return len(resp)


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1000000
    acc = 0
    req = REQUEST
    for _ in range(n):
        acc += serve_one(req)
    print(acc)


if __name__ == "__main__":
    main()
