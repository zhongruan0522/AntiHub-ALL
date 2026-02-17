# -*- coding: utf-8 -*-

"""
AWS Event Stream decoder (Kiro/Amazon Q upstream).

Ported conceptually from the reference implementation in `2-参考项目/kiro.rs`:
- Frame format: TotalLen(4) + HeaderLen(4) + PreludeCRC(4) + Headers + Payload + MsgCRC(4)
- CRC32: ISO-HDLC (same as zlib.crc32 / IEEE)
- Streaming decoder: state machine with error recovery (skip byte / skip frame)

This module is intentionally self-contained (no third-party deps).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Iterator, Optional, Tuple
import logging
import zlib

logger = logging.getLogger(__name__)


DEFAULT_MAX_BUFFER_SIZE = 16 * 1024 * 1024  # 16 MB
DEFAULT_MAX_ERRORS = 5
DEFAULT_BUFFER_CAPACITY = 8192

PRELUDE_SIZE = 12
MIN_MESSAGE_SIZE = PRELUDE_SIZE + 4
MAX_MESSAGE_SIZE = 16 * 1024 * 1024  # 16 MB


def crc32(data: bytes) -> int:
    return int(zlib.crc32(data) & 0xFFFFFFFF)


class AwsEventStreamParseError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class DecoderState(str, Enum):
    READY = "ready"
    PARSING = "parsing"
    RECOVERING = "recovering"
    STOPPED = "stopped"


@dataclass(frozen=True)
class AwsEventStreamFrame:
    headers: Dict[str, Any]
    payload: bytes

    def header_string(self, name: str) -> Optional[str]:
        v = self.headers.get(name)
        return v if isinstance(v, str) else None

    @property
    def message_type(self) -> Optional[str]:
        return self.header_string(":message-type")

    @property
    def event_type(self) -> Optional[str]:
        return self.header_string(":event-type")

    @property
    def exception_type(self) -> Optional[str]:
        return self.header_string(":exception-type")

    @property
    def error_code(self) -> Optional[str]:
        return self.header_string(":error-code")


def _ensure_bytes(data: bytes, needed: int, *, code: str = "incomplete") -> None:
    if len(data) < needed:
        raise AwsEventStreamParseError(code, f"need {needed} bytes, got {len(data)}")


def parse_headers(data: bytes, header_length: int) -> Dict[str, Any]:
    if len(data) < header_length:
        raise AwsEventStreamParseError("incomplete", f"need {header_length} header bytes, got {len(data)}")

    headers: Dict[str, Any] = {}
    offset = 0

    while offset < header_length:
        if offset >= len(data):
            break

        name_len = int(data[offset])
        offset += 1
        if name_len <= 0:
            raise AwsEventStreamParseError("header_parse_failed", "header name length cannot be 0")

        _ensure_bytes(data[offset:], name_len)
        name = bytes(data[offset : offset + name_len]).decode("utf-8", errors="replace")
        offset += name_len

        _ensure_bytes(data[offset:], 1)
        value_type = int(data[offset])
        offset += 1

        # Value types follow AWS Event Stream spec (0-9).
        if value_type == 0:
            headers[name] = True
            continue
        if value_type == 1:
            headers[name] = False
            continue
        if value_type == 2:
            _ensure_bytes(data[offset:], 1)
            headers[name] = int.from_bytes(data[offset : offset + 1], "big", signed=True)
            offset += 1
            continue
        if value_type == 3:
            _ensure_bytes(data[offset:], 2)
            headers[name] = int.from_bytes(data[offset : offset + 2], "big", signed=True)
            offset += 2
            continue
        if value_type == 4:
            _ensure_bytes(data[offset:], 4)
            headers[name] = int.from_bytes(data[offset : offset + 4], "big", signed=True)
            offset += 4
            continue
        if value_type == 5:
            _ensure_bytes(data[offset:], 8)
            headers[name] = int.from_bytes(data[offset : offset + 8], "big", signed=True)
            offset += 8
            continue
        if value_type == 6:
            _ensure_bytes(data[offset:], 2)
            arr_len = int.from_bytes(data[offset : offset + 2], "big", signed=False)
            offset += 2
            _ensure_bytes(data[offset:], arr_len)
            headers[name] = bytes(data[offset : offset + arr_len])
            offset += arr_len
            continue
        if value_type == 7:
            _ensure_bytes(data[offset:], 2)
            s_len = int.from_bytes(data[offset : offset + 2], "big", signed=False)
            offset += 2
            _ensure_bytes(data[offset:], s_len)
            headers[name] = bytes(data[offset : offset + s_len]).decode("utf-8", errors="replace")
            offset += s_len
            continue
        if value_type == 8:
            _ensure_bytes(data[offset:], 8)
            headers[name] = int.from_bytes(data[offset : offset + 8], "big", signed=True)
            offset += 8
            continue
        if value_type == 9:
            _ensure_bytes(data[offset:], 16)
            headers[name] = bytes(data[offset : offset + 16])
            offset += 16
            continue

        raise AwsEventStreamParseError("invalid_header_type", f"type={value_type}")

    return headers


def parse_frame(buffer: bytes) -> Optional[Tuple[AwsEventStreamFrame, int]]:
    if len(buffer) < PRELUDE_SIZE:
        return None

    total_length = int.from_bytes(buffer[0:4], "big", signed=False)
    header_length = int.from_bytes(buffer[4:8], "big", signed=False)
    prelude_crc = int.from_bytes(buffer[8:12], "big", signed=False)

    if total_length < MIN_MESSAGE_SIZE:
        raise AwsEventStreamParseError(
            "message_too_small",
            f"total_length={total_length}, min={MIN_MESSAGE_SIZE}",
        )
    if total_length > MAX_MESSAGE_SIZE:
        raise AwsEventStreamParseError(
            "message_too_large",
            f"total_length={total_length}, max={MAX_MESSAGE_SIZE}",
        )

    if len(buffer) < total_length:
        return None

    actual_prelude_crc = crc32(buffer[0:8])
    if actual_prelude_crc != prelude_crc:
        raise AwsEventStreamParseError(
            "prelude_crc_mismatch",
            f"expected=0x{prelude_crc:08x}, actual=0x{actual_prelude_crc:08x}",
        )

    message_crc = int.from_bytes(buffer[total_length - 4 : total_length], "big", signed=False)
    actual_message_crc = crc32(buffer[0 : total_length - 4])
    if actual_message_crc != message_crc:
        raise AwsEventStreamParseError(
            "message_crc_mismatch",
            f"expected=0x{message_crc:08x}, actual=0x{actual_message_crc:08x}",
        )

    headers_start = PRELUDE_SIZE
    headers_end = headers_start + int(header_length)
    if headers_end > total_length - 4:
        raise AwsEventStreamParseError("header_parse_failed", "header length exceeds message boundary")

    headers = parse_headers(buffer[headers_start:headers_end], int(header_length))
    payload = bytes(buffer[headers_end : total_length - 4])
    return AwsEventStreamFrame(headers=headers, payload=payload), int(total_length)


class AwsEventStreamDecoder:
    def __init__(
        self,
        *,
        capacity: int = DEFAULT_BUFFER_CAPACITY,
        max_errors: int = DEFAULT_MAX_ERRORS,
        max_buffer_size: int = DEFAULT_MAX_BUFFER_SIZE,
    ) -> None:
        self._buffer = bytearray()
        if capacity > 0:
            self._buffer = bytearray(capacity)
            self._buffer.clear()

        self._state = DecoderState.READY
        self._frames_decoded = 0
        self._error_count = 0
        self._max_errors = int(max_errors)
        self._max_buffer_size = int(max_buffer_size)
        self._bytes_skipped = 0

    @property
    def state(self) -> DecoderState:
        return self._state

    @property
    def frames_decoded(self) -> int:
        return int(self._frames_decoded)

    @property
    def error_count(self) -> int:
        return int(self._error_count)

    @property
    def bytes_skipped(self) -> int:
        return int(self._bytes_skipped)

    @property
    def buffer_len(self) -> int:
        return int(len(self._buffer))

    def reset(self) -> None:
        self._buffer.clear()
        self._state = DecoderState.READY
        self._frames_decoded = 0
        self._error_count = 0
        self._bytes_skipped = 0

    def feed(self, data: bytes) -> None:
        if self._state == DecoderState.STOPPED:
            raise AwsEventStreamParseError("too_many_errors", "decoder is stopped")

        if not data:
            return

        new_size = len(self._buffer) + len(data)
        if new_size > self._max_buffer_size:
            raise AwsEventStreamParseError("buffer_overflow", f"size={new_size}, max={self._max_buffer_size}")

        self._buffer.extend(data)

        if self._state == DecoderState.RECOVERING:
            self._state = DecoderState.READY

    def decode(self) -> Optional[AwsEventStreamFrame]:
        if self._state == DecoderState.STOPPED:
            raise AwsEventStreamParseError("too_many_errors", "decoder is stopped")

        if not self._buffer:
            self._state = DecoderState.READY
            return None

        self._state = DecoderState.PARSING

        try:
            parsed = parse_frame(self._buffer)
            if parsed is None:
                self._state = DecoderState.READY
                return None
            frame, consumed = parsed
            del self._buffer[:consumed]
            self._state = DecoderState.READY
            self._frames_decoded += 1
            self._error_count = 0
            return frame
        except AwsEventStreamParseError as e:
            self._error_count += 1
            if self._error_count >= self._max_errors:
                self._state = DecoderState.STOPPED
                raise AwsEventStreamParseError("too_many_errors", f"count={self._error_count}, last={e}") from e

            self._try_recover(e)
            self._state = DecoderState.RECOVERING
            raise

    def decode_iter(self) -> Iterator[AwsEventStreamFrame]:
        while True:
            try:
                frame = self.decode()
            except AwsEventStreamParseError:
                # One error per decode attempt; caller decides whether to continue feeding.
                return
            if frame is None:
                return
            yield frame

    def _try_recover(self, error: AwsEventStreamParseError) -> None:
        if not self._buffer:
            return

        code = getattr(error, "code", "")

        # Prelude stage errors: likely misaligned boundary -> skip 1 byte.
        if code in ("prelude_crc_mismatch", "message_too_small", "message_too_large"):
            skipped = self._buffer[0]
            del self._buffer[0:1]
            self._bytes_skipped += 1
            logger.debug("aws-eventstream recover(prelude): skipped 0x%02x (%d total)", skipped, self._bytes_skipped)
            return

        # Data stage errors: try skip the whole frame using total_length.
        if code in ("message_crc_mismatch", "header_parse_failed"):
            if len(self._buffer) >= 4:
                total_length = int.from_bytes(self._buffer[0:4], "big", signed=False)
                if MIN_MESSAGE_SIZE <= total_length <= len(self._buffer):
                    del self._buffer[:total_length]
                    self._bytes_skipped += total_length
                    logger.debug(
                        "aws-eventstream recover(data): skipped frame %d bytes (%d total)",
                        total_length,
                        self._bytes_skipped,
                    )
                    return

            skipped = self._buffer[0]
            del self._buffer[0:1]
            self._bytes_skipped += 1
            logger.debug("aws-eventstream recover(data-fallback): skipped 0x%02x", skipped)
            return

        # Generic fallback: skip 1 byte.
        skipped = self._buffer[0]
        del self._buffer[0:1]
        self._bytes_skipped += 1
        logger.debug("aws-eventstream recover(generic): skipped 0x%02x", skipped)

