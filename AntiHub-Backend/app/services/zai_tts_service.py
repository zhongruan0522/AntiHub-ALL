"""
ZAI TTS 服务
"""

from __future__ import annotations

import io
import json
import logging
import os
import time
import uuid
import wave
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Dict, Optional, Tuple
from base64 import b64decode

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.repositories.zai_tts_account_repository import ZaiTTSAccountRepository
from app.utils.encryption import encrypt_api_key as encrypt_secret
from app.utils.encryption import decrypt_api_key as decrypt_secret

logger = logging.getLogger(__name__)

DEFAULT_VOICE_ID = "system_001"
VOICE_NAME_MAP = {
    "system_001": "活力女声",
    "system_002": "温柔女声",
    "system_003": "通用男声",
}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize_speed(value: Any) -> float:
    try:
        speed = float(value)
    except Exception:
        speed = 1.0
    if speed <= 0:
        speed = 1.0
    return round(speed, 1)


def _normalize_volume(value: Any) -> int:
    try:
        volume = int(float(value))
    except Exception:
        volume = 1
    if volume <= 0:
        volume = 1
    return volume


class ZaiTTSService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ZaiTTSAccountRepository(db)
        self.settings = get_settings()

    @property
    def base_url(self) -> str:
        return (self.settings.zai_tts_base_url or "https://audio.z.ai").rstrip("/")

    @property
    def user_agent(self) -> str:
        return self.settings.zai_tts_user_agent or "Mozilla/5.0 AppleWebKit/537.36 Chrome/143 Safari/537"

    @property
    def keep_count(self) -> int:
        return max(int(self.settings.zai_tts_file_keep_count or 10), 0)

    def _storage_dir(self) -> str:
        return os.path.join(os.getcwd(), "storage", "tts")

    def ensure_storage_dir(self) -> str:
        path = self._storage_dir()
        os.makedirs(path, exist_ok=True)
        return path

    def cleanup_storage_on_startup(self) -> None:
        path = self._storage_dir()
        if not os.path.isdir(path):
            return
        for name in os.listdir(path):
            full = os.path.join(path, name)
            if os.path.isfile(full):
                try:
                    os.remove(full)
                except Exception as e:
                    logger.warning("cleanup tts file failed: %s", e)

    def _enforce_keep_count(self) -> None:
        keep = self.keep_count
        if keep <= 0:
            return
        path = self._storage_dir()
        if not os.path.isdir(path):
            return
        files = [
            os.path.join(path, f)
            for f in os.listdir(path)
            if os.path.isfile(os.path.join(path, f))
        ]
        files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for stale in files[keep:]:
            try:
                os.remove(stale)
            except Exception as e:
                logger.warning("remove stale tts file failed: %s", e)

    async def list_accounts(self, user_id: int):
        return await self.repo.list_by_user_id(user_id)

    async def create_account(
        self,
        user_id: int,
        *,
        account_name: str,
        zai_user_id: str,
        token: str,
        voice_id: str,
    ):
        payload = {
            "token": _safe_str(token),
        }
        encrypted = encrypt_secret(json.dumps(payload, ensure_ascii=False))
        return await self.repo.create(
            user_id=user_id,
            account_name=_safe_str(account_name) or "ZAI TTS Account",
            zai_user_id=_safe_str(zai_user_id),
            voice_id=_safe_str(voice_id) or DEFAULT_VOICE_ID,
            credentials=encrypted,
        )

    async def update_status(self, user_id: int, account_id: int, status: int):
        return await self.repo.update_status(account_id, user_id, status)

    async def update_name(self, user_id: int, account_id: int, account_name: str):
        return await self.repo.update_name(account_id, user_id, account_name)

    async def update_credentials(
        self,
        user_id: int,
        account_id: int,
        *,
        zai_user_id: Optional[str],
        token: Optional[str],
        voice_id: Optional[str],
    ):
        credentials = None
        if token is not None:
            payload = {"token": _safe_str(token)}
            credentials = encrypt_secret(json.dumps(payload, ensure_ascii=False))
        return await self.repo.update_credentials(
            account_id,
            user_id,
            zai_user_id=_safe_str(zai_user_id) if zai_user_id is not None else None,
            voice_id=_safe_str(voice_id) if voice_id is not None else None,
            credentials=credentials,
        )

    async def delete_account(self, user_id: int, account_id: int) -> bool:
        return await self.repo.delete(account_id, user_id)

    async def select_active_account(self, user_id: int, *, voice_id: Optional[str] = None):
        enabled = await self.repo.list_enabled_by_user_id(user_id)
        if not enabled:
            raise ValueError("没有可用的 ZAI TTS 账号，请先添加账号")

        wanted = _safe_str(voice_id)
        if not wanted:
            return enabled[0]

        for account in enabled:
            if _safe_str(getattr(account, "voice_id", None)) == wanted:
                return account

        allowed = sorted(
            {
                _safe_str(getattr(a, "voice_id", None))
                for a in enabled
                if _safe_str(getattr(a, "voice_id", None))
            }
        )
        allowed_text = ", ".join(allowed) if allowed else "-"
        raise PermissionError(f"音色ID无权限或不存在：{wanted}（允许：{allowed_text}）")

    def _load_token(self, account) -> str:
        raw = decrypt_secret(account.credentials)
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {}
        return _safe_str(payload.get("token"))

    async def _open_upstream_stream(
        self,
        *,
        account,
        input_text: str,
        voice_id: str,
        speed: float,
        volume: int,
    ) -> Tuple[httpx.AsyncClient, httpx.Response]:
        token = self._load_token(account)
        if not token:
            raise ValueError("账号缺少有效的 ZAI Token")

        url = f"{self.base_url}/api/v1/z-audio/tts/create"
        headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": self.user_agent,
            "Referer": f"{self.base_url}/",
            "Origin": self.base_url,
            "Accept": "text/event-stream",
        }
        payload = {
            "voice_name": VOICE_NAME_MAP.get(voice_id, ""),
            "voice_id": voice_id,
            "user_id": account.zai_user_id,
            "input_text": input_text,
            "speed": speed,
            "volume": volume,
        }

        timeout = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=10.0)
        client = httpx.AsyncClient(timeout=timeout)
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code < 200 or resp.status_code >= 300:
            text = await resp.aread()
            await resp.aclose()
            await client.aclose()
            raise httpx.HTTPStatusError(
                f"ZAI upstream error: HTTP {resp.status_code}",
                request=None,
                response=type("R", (), {"status_code": resp.status_code, "text": text.decode(errors="replace")})(),
            )
        return client, resp

    async def _iter_sse_lines(self, resp: httpx.Response) -> AsyncGenerator[str, None]:
        buffer = ""
        async for chunk in resp.aiter_text():
            buffer += chunk
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if line:
                    yield line
        if buffer.strip():
            yield buffer.strip()

    async def stream_audio(
        self,
        *,
        account,
        input_text: str,
        voice_id: str,
        speed: float,
        volume: int,
    ) -> Tuple[AsyncGenerator[bytes, None], httpx.AsyncClient, httpx.Response]:
        client, resp = await self._open_upstream_stream(
            account=account,
            input_text=input_text,
            voice_id=voice_id,
            speed=speed,
            volume=volume,
        )

        async def generator() -> AsyncGenerator[bytes, None]:
            wav_header_sent = False
            try:
                async for line in self._iter_sse_lines(resp):
                    if not line.startswith("data:"):
                        continue
                    text = line[5:].strip()
                    if text == "[DONE]":
                        break
                    try:
                        data = json.loads(text)
                    except json.JSONDecodeError:
                        continue
                    b64audio = data.get("audio")
                    if not b64audio:
                        continue
                    audio_bytes = b64decode(b64audio)
                    if audio_bytes.startswith(b"RIFF"):
                        with io.BytesIO(audio_bytes) as f, wave.open(f, "rb") as w:
                            frames = w.readframes(w.getnframes())
                            if not wav_header_sent:
                                header_buf = io.BytesIO()
                                with wave.open(header_buf, "wb") as out_w:
                                    out_w.setparams(w.getparams())
                                    out_w.setnframes(0)
                                header = bytearray(header_buf.getvalue())
                                header[4:8] = b"\xff\xff\xff\xff"
                                header[40:44] = b"\xff\xff\xff\xff"
                                yield bytes(header)
                                wav_header_sent = True
                            yield frames
                    else:
                        yield audio_bytes
            finally:
                await resp.aclose()
                await client.aclose()

        return generator(), client, resp

    async def generate_file(
        self,
        *,
        account,
        input_text: str,
        voice_id: str,
        speed: float,
        volume: int,
    ) -> str:
        client, resp = await self._open_upstream_stream(
            account=account,
            input_text=input_text,
            voice_id=voice_id,
            speed=speed,
            volume=volume,
        )

        pcm_chunks: list[bytes] = []
        raw_chunks: list[bytes] = []
        wav_params: Optional[wave._wave_params] = None

        try:
            async for line in self._iter_sse_lines(resp):
                if not line.startswith("data:"):
                    continue
                text = line[5:].strip()
                if text == "[DONE]":
                    break
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    continue
                b64audio = data.get("audio")
                if not b64audio:
                    continue
                audio_bytes = b64decode(b64audio)
                if audio_bytes.startswith(b"RIFF"):
                    with io.BytesIO(audio_bytes) as f, wave.open(f, "rb") as w:
                        frames = w.readframes(w.getnframes())
                        if wav_params is None:
                            wav_params = w.getparams()
                        pcm_chunks.append(frames)
                else:
                    raw_chunks.append(audio_bytes)
        finally:
            await resp.aclose()
            await client.aclose()

        storage_dir = self.ensure_storage_dir()
        filename = f"zai-tts-{int(time.time())}-{uuid.uuid4().hex[:8]}.wav"
        filepath = os.path.join(storage_dir, filename)

        if wav_params and pcm_chunks:
            with wave.open(filepath, "wb") as out_w:
                out_w.setparams(wav_params)
                for chunk in pcm_chunks:
                    out_w.writeframes(chunk)
        else:
            with open(filepath, "wb") as f:
                for chunk in raw_chunks:
                    f.write(chunk)

        self._enforce_keep_count()
        return filepath
