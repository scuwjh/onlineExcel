"""FastAPI 应用入口。"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import init_db
from . import sheets, ws

app = FastAPI(title="Online Excel API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


app.include_router(sheets.router)
app.include_router(ws.router)
