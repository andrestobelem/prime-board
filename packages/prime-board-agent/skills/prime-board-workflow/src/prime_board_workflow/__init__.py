"""Authenticated, project-scoped prime-board MCP diagnostics.

This module deliberately delegates issue operations to the MCP server. It does
not contain a second GraphQL mutation catalog.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

try:
    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
except ImportError as exc:  # pragma: no cover - exercised by Prime Agent's disabled-skill path
    httpx2 = None  # type: ignore[assignment]
    ClientSession = None  # type: ignore[assignment,misc]
    streamable_http_client = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


class PrimeBoardError(RuntimeError):
    """A safe, user-facing error that never contains a bearer token."""


def project_root(cwd: str | None = None) -> Path | None:
    """Resolve the Git root used to select the project credential file."""
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
    """Return the 0600 credential path outside settings and ``.prime-board``."""
    digest = hashlib.sha256(str(root).encode()).hexdigest()[:16]
    return Path(home or Path.home()) / ".prime-board" / "credentials" / f"{digest}.json"


def _credential(root: Path, url: str | None) -> tuple[str | None, str]:
    environment_key = os.environ.get("PRIME_BOARD_API_KEY")
    environment_url = url or os.environ.get("PRIME_BOARD_URL")
    path = credential_path(root)
    try:
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        return environment_url, environment_key or ""
    if mode != 0o600:
        raise PrimeBoardError(f"Credential file must have mode 0600: {path}")
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise PrimeBoardError(f"Cannot read the project credential: {path}") from exc
    key = value.get("apiKey")
    if not isinstance(key, str) or not key.strip():
        return environment_url, environment_key or ""
    # A project file owns its endpoint. An explicit URL is the only override,
    # which keeps two concurrent projects isolated even with one process env.
    return url or value.get("url") or environment_url, key


def _endpoint(root: Path, url: str | None) -> str | None:
    if url is None:
        try:
            value = json.loads(credential_path(root).read_text())
        except (FileNotFoundError, OSError, ValueError):
            value = {}
        if isinstance(value.get("mcpUrl"), str) and value["mcpUrl"]:
            return value["mcpUrl"]
    return os.environ.get("PRIME_BOARD_MCP_URL")


def _safe_error(error: BaseException, key: str | None = None) -> str:
    message = str(error)
    key = key or os.environ.get("PRIME_BOARD_API_KEY")
    if key:
        message = message.replace(key, "[redacted-api-key]")
    return message.replace("Bearer ", "Bearer [redacted] ")


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
    for attempt in range(2):
        try:
            async with httpx2.AsyncClient(headers=headers, timeout=10) as client:
                async with streamable_http_client(endpoint, http_client=client) as (read, write):
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
        except PrimeBoardError:
            raise
        except Exception as error:  # MCP SDK errors vary by transport version.
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
    """Check project identity, health, and bearer authentication without exposing secrets."""
    root = project_root(cwd)
    if root is None:
        return {"state": "error", "detail": "The current directory is not inside a Git project."}
    endpoint, key = _credential(root, url)
    base = (endpoint or os.environ.get("PRIME_BOARD_URL") or "http://127.0.0.1:3333").rstrip("/")
    result: dict[str, Any] = {"projectRoot": str(root), "url": base}
    try:
        if _IMPORT_ERROR is not None:
            raise PrimeBoardError(f"Prime Agent HTTP dependencies are unavailable: {_IMPORT_ERROR}")
        async with httpx2.AsyncClient(timeout=5) as client:
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
        async with httpx2.AsyncClient(
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
    """Discover the authenticated MCP tool catalog for the current project."""
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
    """Call one tool exposed by MCP; writes stay owned by the MCP GraphQL catalog."""
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
    """Run ``diagnose``, ``list_tools``, or ``call_tool`` for the current project."""
    if operation == "diagnose":
        return await diagnose(cwd, url)
    if operation == "list_tools":
        return await list_tools(cwd, url)
    if operation == "call_tool":
        if not tool:
            raise PrimeBoardError("tool is required when operation is call_tool")
        return await call_tool(tool, arguments, cwd, url)
    raise PrimeBoardError("operation must be diagnose, list_tools, or call_tool")
