"""Diagnóstico MCP autenticado y asociado al proyecto de prime-board.

Este módulo delega las operaciones de Issues al servidor MCP. No contiene un
segundo catálogo de mutaciones GraphQL.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

_STREAMABLE_HTTP_LEGACY = False
try:
    try:
        import httpx2 as httpx_client
    except ImportError:
        import httpx as httpx_client
    from mcp import ClientSession
    try:
        from mcp.client.streamable_http import streamable_http_client
    except ImportError:
        from mcp.client.streamable_http import streamablehttp_client as streamable_http_client

        _STREAMABLE_HTTP_LEGACY = True
except ImportError as exc:  # pragma: no cover - ruta de skill deshabilitada sin dependencias
    httpx_client = None
    ClientSession = None
    streamable_http_client = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


class PrimeBoardError(RuntimeError):
    """Error seguro para el usuario que nunca contiene un token Bearer."""


def project_root(cwd: str | None = None) -> Path | None:
    """Resuelve la raíz Git usada para seleccionar la credencial del proyecto."""
    location = Path(cwd or os.getcwd()).resolve()
    try:
        result = subprocess.run(
            ["git", "-C", str(location), "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = result.stdout.strip()
    return Path(value).resolve() if value else None


def credential_path(root: Path, home: str | None = None) -> Path:
    """Devuelve la ruta 0600 fuera de settings y de ``.prime-board``."""
    digest = hashlib.sha256(str(root).encode()).hexdigest()[:16]
    return Path(home or Path.home()) / ".prime-board" / "credentials" / f"{digest}.json"


def _credential(root: Path, url: str | None) -> tuple[str | None, str]:
    """Resuelve la URL y prioriza la API key del entorno sobre el archivo."""
    environment_key = os.environ.get("PRIME_BOARD_API_KEY", "").strip()
    environment_url = url or os.environ.get("PRIME_BOARD_URL")
    path = credential_path(root)
    try:
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        return environment_url, environment_key
    if mode != 0o600:
        raise PrimeBoardError(f"Credential file must have mode 0600: {path}")
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise PrimeBoardError(f"Cannot read the project credential: {path}") from exc
    if not isinstance(value, dict):
        raise PrimeBoardError(f"The project credential must be a JSON object: {path}")
    file_key = value.get("apiKey")
    if not isinstance(file_key, str) or not file_key.strip():
        return environment_url, environment_key
    key = environment_key or file_key.strip()
    # La URL explícita domina. Después usa la URL del entorno y, por último, la del proyecto.
    endpoint = url or os.environ.get("PRIME_BOARD_URL") or value.get("url")
    return endpoint if isinstance(endpoint, str) else None, key


def _endpoint(root: Path, url: str | None) -> str | None:
    """Resuelve el endpoint MCP con prioridad explícita por proyecto."""
    environment_endpoint = os.environ.get("PRIME_BOARD_MCP_URL")
    if environment_endpoint:
        return environment_endpoint
    if url is None:
        try:
            value = json.loads(credential_path(root).read_text())
        except (FileNotFoundError, OSError, ValueError):
            value = {}
        if isinstance(value, dict) and isinstance(value.get("mcpUrl"), str) and value["mcpUrl"]:
            return value["mcpUrl"]
    return None


def _safe_error(error: BaseException, key: str | None = None) -> str:
    """Redacta API keys y tokens Bearer de errores de transporte."""
    message = str(error)
    key = key or os.environ.get("PRIME_BOARD_API_KEY")
    if key:
        message = message.replace(key, "[redacted-api-key]")
    message = re.sub(
        r"(\b(?:prime[_ -]?board[_ -]?api[_ -]?key|api[_ -]?key|access[_ -]?token|secret)\b\s*[:=]\s*)[^\s,;]+",
        r"\1[redacted-api-key]",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(
        r"(\bauthorization\b\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+",
        r"\1[redacted-bearer]",
        message,
        flags=re.IGNORECASE,
    )
    return re.sub(r"(\bbearer\s+)[^\s,;]+", r"\1[redacted-bearer]", message, flags=re.IGNORECASE)


def _json(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True)
    if isinstance(value, list):
        return [_json(item) for item in value]
    if isinstance(value, dict):
        return {key: _json(item) for key, item in value.items()}
    return value


async def _mcp(operation: str, root: Path, url: str | None, tool: str | None, arguments: dict[str, Any] | None) -> dict[str, Any]:
    if _IMPORT_ERROR is not None:
        raise PrimeBoardError(f"Prime Agent MCP dependencies are unavailable: {_IMPORT_ERROR}")
    endpoint, key = _credential(root, url)
    if not key:
        return {
            "state": "unauthenticated",
            "detail": "Set PRIME_BOARD_API_KEY or run /prime-board auth for this project.",
            "projectRoot": str(root),
            "endpoint": _endpoint(root, url),
        }
    endpoint = _endpoint(root, url)
    if not endpoint:
        return {
            "state": "unconfigured",
            "detail": "Set PRIME_BOARD_MCP_URL or save mcpUrl with /prime-board auth.",
            "projectRoot": str(root),
        }
    headers = {"authorization": f"Bearer {key}"}
    last_error: str | None = None

    async def operate(read: Any, write: Any) -> dict[str, Any]:
        async with ClientSession(read, write) as session:
            await session.initialize()
            if operation == "list_tools":
                result = await session.list_tools()
                return {
                    "state": "healthy",
                    "projectRoot": str(root),
                    "endpoint": endpoint,
                    "tools": [_json(item) for item in result.tools],
                }
            if operation == "call_tool":
                if not tool:
                    raise PrimeBoardError("tool is required for call_tool")
                result = await session.call_tool(tool, arguments or {})
                return {
                    "state": "healthy",
                    "projectRoot": str(root),
                    "endpoint": endpoint,
                    "tool": tool,
                    "result": _json(result),
                }
            raise PrimeBoardError(f"Unsupported MCP operation: {operation}")

    for attempt in range(2):
        try:
            if _STREAMABLE_HTTP_LEGACY:
                async with streamable_http_client(endpoint, headers=headers) as streams:
                    return await operate(streams[0], streams[1])
            async with httpx_client.AsyncClient(headers=headers, timeout=10) as client:
                async with streamable_http_client(endpoint, http_client=client) as (read, write):
                    return await operate(read, write)
        except PrimeBoardError:
            raise
        except Exception as error:  # El SDK MCP cambia los errores entre transportes.
            last_error = _safe_error(error, key)
            if attempt == 0:
                await asyncio.sleep(0)
    return {
        "state": "error",
        "projectRoot": str(root),
        "endpoint": endpoint,
        "detail": f"MCP connection failed after one reconnect attempt: {last_error}",
    }


async def diagnose(cwd: str | None = None, url: str | None = None) -> dict[str, Any]:
    """Comprueba identidad, salud y autenticación Bearer sin exponer secretos."""
    root = project_root(cwd)
    if root is None:
        return {"state": "error", "detail": "The current directory is not inside a Git project."}
    endpoint, key = _credential(root, url)
    base = (endpoint or os.environ.get("PRIME_BOARD_URL") or "http://127.0.0.1:3333").rstrip("/")
    result: dict[str, Any] = {"projectRoot": str(root), "url": base}
    try:
        if _IMPORT_ERROR is not None:
            raise PrimeBoardError(f"Prime Agent HTTP dependencies are unavailable: {_IMPORT_ERROR}")
        async with httpx_client.AsyncClient(timeout=5) as client:
            response = await client.get(f"{base}/health")
        result["health"] = "healthy" if response.is_success else f"http_{response.status_code}"
    except Exception as error:
        result["health"] = "unreachable"
        result["detail"] = _safe_error(error, key)
        return result
    if not key:
        result["state"] = "unauthenticated"
        result["detail"] = "Set PRIME_BOARD_API_KEY or run /prime-board auth for this project."
        return result
    try:
        async with httpx_client.AsyncClient(
            headers={"authorization": f"Bearer {key}"}, timeout=5
        ) as client:
            response = await client.post(
                f"{base}/graphql",
                json={"query": "{ viewer { id name type } workspace { id name urlKey } }"},
            )
        if response.status_code in (401, 403):
            result["state"] = "unauthorized"
            result["detail"] = "The project API key is invalid or inactive."
        elif response.is_success:
            result["state"] = "healthy"
            mcp_result = await _mcp("list_tools", root, url, None, None)
            result["mcp"] = mcp_result.get("state", "error")
            if mcp_result.get("state") not in {"healthy", "unauthenticated"}:
                result["mcpDetail"] = mcp_result.get("detail", "MCP connection failed")
        else:
            result["state"] = "error"
            result["detail"] = f"GraphQL returned HTTP {response.status_code}."
    except Exception as error:
        result["state"] = "error"
        result["detail"] = _safe_error(error, key)
    return result


async def list_tools(cwd: str | None = None, url: str | None = None) -> dict[str, Any]:
    """Descubre el catálogo MCP autenticado del proyecto actual."""
    root = project_root(cwd)
    if root is None:
        return {"state": "error", "detail": "The current directory is not inside a Git project."}
    return await _mcp("list_tools", root, url, None, None)


async def call_tool(
    tool: str,
    arguments: dict[str, Any] | None = None,
    cwd: str | None = None,
    url: str | None = None,
) -> dict[str, Any]:
    """Llama una tool MCP; las escrituras siguen bajo el catálogo GraphQL."""
    root = project_root(cwd)
    if root is None:
        return {"state": "error", "detail": "The current directory is not inside a Git project."}
    return await _mcp("call_tool", root, url, tool, arguments)


async def run(
    operation: str = "diagnose",
    cwd: str | None = None,
    url: str | None = None,
    tool: str | None = None,
    arguments: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Ejecuta ``diagnose``, ``list_tools`` o ``call_tool`` para el proyecto actual."""
    if operation == "diagnose":
        return await diagnose(cwd, url)
    if operation == "list_tools":
        return await list_tools(cwd, url)
    if operation == "call_tool":
        if not tool:
            raise PrimeBoardError("tool is required when operation is call_tool")
        return await call_tool(tool, arguments, cwd, url)
    raise PrimeBoardError("operation must be diagnose, list_tools, or call_tool")
