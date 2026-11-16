from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import os


WEB_ROOT = Path(__file__).resolve().parents[2] / "web"


class LocalhostOnlyServer(ThreadingHTTPServer):
    allow_reuse_address = True


def main():
    parser = argparse.ArgumentParser(description="Serve the local WebSerial maintenance panel")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    os.chdir(WEB_ROOT)
    server = LocalhostOnlyServer(("127.0.0.1", args.port), SimpleHTTPRequestHandler)
    print(f"USB panel ready: http://127.0.0.1:{args.port}/")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
