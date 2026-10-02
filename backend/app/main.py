import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import mcp
from app.config import get_settings
from app.routers import admin, agent_ws, ai, audit, auth, data, invoices

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def create_app() -> FastAPI:
    app = FastAPI(title="1C Integration API", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_settings().cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for module in (auth, admin, data, audit, invoices, ai, agent_ws, mcp):
        app.include_router(module.router)

    @app.get("/api/health")
    def health():
        return {"ok": True}

    return app


app = create_app()
