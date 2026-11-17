"""Run comfy-api-proxy with one addition: a job may carry ``extra_data.preview_method``.

The proxy accepts only ``api_key_comfy_org`` in a job's ``extra_data``. ComfyUI itself reads
``extra_data.preview_method`` ("latent2rgb", "taesd", ...) to turn live previews on for that one
prompt, and the proxy already relays ComfyUI's preview images to the studio. So this launcher takes
``preview_method`` out before the proxy checks the body and adds it back to the request the proxy
sends to ComfyUI's /prompt. Everything else is the proxy as installed. If the proxy changes so the
patch no longer fits, it runs unpatched (live previews just stay off).

    python -m app.proxy_launch run --comfyui ... --port ...   (same arguments as comfy-api-proxy)
"""
from __future__ import annotations

import contextvars
import logging
import sys

log = logging.getLogger("bob.proxy")
PREVIEW_METHODS = {"latent2rgb", "taesd", "auto", "none"}
_preview: contextvars.ContextVar[str | None] = contextvars.ContextVar("bob_preview_method", default=None)


class _Body:
    """The incoming request with its JSON body swapped for the cleaned one."""

    def __init__(self, request, body):
        self._request, self._body = request, body

    async def json(self, *args, **kwargs):
        return self._body

    def __getattr__(self, name):
        return getattr(self._request, name)


def patch() -> bool:
    try:
        import aiohttp
        from comfy_api_proxy import app as proxy_app
        proxy = proxy_app.Proxy
        orig_submit = proxy.submit
    except (ImportError, AttributeError) as exc:
        log.warning("live previews unavailable: %s", exc)
        return False

    async def submit(self, request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - let the proxy answer bad bodies as it always does
            return await orig_submit(self, request)
        extra = body.get("extra_data") if isinstance(body, dict) else None
        method = extra.pop("preview_method", None) if isinstance(extra, dict) else None
        if method is None:
            return await orig_submit(self, request)
        if not extra:
            body.pop("extra_data", None)
        token = _preview.set(method if method in PREVIEW_METHODS else None)
        try:
            return await orig_submit(self, _Body(request, body))
        finally:
            _preview.reset(token)

    orig_post = aiohttp.ClientSession.post

    def post(self, url, *args, **kwargs):
        method = _preview.get()
        payload = kwargs.get("json")
        if method and isinstance(payload, dict) and str(url).rstrip("/").endswith("/prompt") and "prompt" in payload:
            kwargs["json"] = {**payload, "extra_data": {**(payload.get("extra_data") or {}), "preview_method": method}}
        return orig_post(self, url, *args, **kwargs)

    proxy.submit = submit
    aiohttp.ClientSession.post = post
    return True


def main() -> int:
    patch()
    from comfy_api_proxy import cli
    return cli.main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
