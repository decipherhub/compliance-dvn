"""Static file server for the demo dashboard, with caching turned off.

    python serve.py [port]     # default 8080

`python -m http.server` sends Last-Modified and answers conditional requests with 304, so an
edited page keeps serving the old bytes until a hard reload. During a demo that reads as "the
change did not work". Everything here is local and tiny, so no-store costs nothing.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONDITIONAL_HEADERS = ("If-Modified-Since", "If-None-Match", "If-Range")


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Answers every request in full.

    The conditional request headers are dropped before the base class sees them, so it never
    decides to reply 304. Rewriting a 304 into a 200 afterwards would NOT work: the base class
    sends no body with a 304, so the client would receive an empty file and a script would load
    as zero bytes — which is worse than a stale cache, because nothing in the page reports it.
    """

    def _drop_conditionals(self) -> None:
        for header in CONDITIONAL_HEADERS:
            while header in self.headers:
                del self.headers[header]

    def do_GET(self):  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        self._drop_conditionals()
        super().do_GET()

    def do_HEAD(self):  # noqa: N802
        self._drop_conditionals()
        super().do_HEAD()

    def send_header(self, keyword, value):
        # Without a validator the browser has nothing to revalidate against next time.
        if keyword.lower() == "last-modified":
            return
        super().send_header(keyword, value)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = partial(NoCacheHandler, directory=str(Path(__file__).parent))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"dashboard on http://localhost:{port} (no-store)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
