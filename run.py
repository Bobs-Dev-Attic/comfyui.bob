"""Start the studio: `python run.py` (then open http://127.0.0.1:8700)."""
import uvicorn

from app import config

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, log_level="info")
