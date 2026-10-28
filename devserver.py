"""Local preview entrypoint compatible with managed preview's Vite-style flags."""
import argparse
import uvicorn

parser = argparse.ArgumentParser()
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", default=3000, type=int)
parser.add_argument("--strictPort", action="store_true")
args = parser.parse_args()
uvicorn.run("app:app", host=args.host, port=args.port, access_log=False)
