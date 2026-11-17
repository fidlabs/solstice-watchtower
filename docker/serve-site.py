"""Serve the static dashboard with runtime configuration for its signup form."""
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import tempfile
from urllib.parse import urlparse


def prepare_site(source, destination, alerts_url):
    if alerts_url:
        parsed = urlparse(alerts_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("ALERTS_URL must be an absolute HTTP(S) URL")
    shutil.copytree(source, destination, dirs_exist_ok=True)
    index = destination / "index.html"
    html = index.read_text()
    marker = "const ALERTS_URL = ''"
    if html.count(marker) != 1:
        raise ValueError("Expected exactly one upstream ALERTS_URL placeholder")
    # Escape '<' too: JSON quoting alone doesn't prevent </script> in HTML.
    value = json.dumps(alerts_url).replace("<", "\\u003c")
    index.write_text(html.replace(marker, "const ALERTS_URL = " + value))


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="watchtower-site-") as directory:
        destination = Path(directory)
        prepare_site(Path(__file__).resolve().parent / "site", destination,
                     os.environ.get("ALERTS_URL", ""))
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(destination))
        http.server.ThreadingHTTPServer(("0.0.0.0", 8000), handler).serve_forever()
