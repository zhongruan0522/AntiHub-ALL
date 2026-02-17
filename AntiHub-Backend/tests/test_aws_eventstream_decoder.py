import json
import unittest

from app.utils.aws_eventstream import AwsEventStreamDecoder, crc32


def _build_header_string(name: str, value: str) -> bytes:
    name_bytes = name.encode("utf-8")
    value_bytes = value.encode("utf-8")
    if len(name_bytes) > 255:
        raise ValueError("header name too long")
    if len(value_bytes) > 65535:
        raise ValueError("header value too long")
    return (
        bytes([len(name_bytes)])
        + name_bytes
        + bytes([7])  # String
        + len(value_bytes).to_bytes(2, "big")
        + value_bytes
    )


def _build_frame(headers: bytes, payload: bytes) -> bytes:
    header_length = len(headers)
    total_length = 12 + header_length + len(payload) + 4
    prelude = total_length.to_bytes(4, "big") + header_length.to_bytes(4, "big")
    prelude_crc = crc32(prelude).to_bytes(4, "big")
    without_msg_crc = prelude + prelude_crc + headers + payload
    msg_crc = crc32(without_msg_crc).to_bytes(4, "big")
    return without_msg_crc + msg_crc


class TestAwsEventStreamDecoder(unittest.TestCase):
    def test_decode_single_frame(self) -> None:
        headers = b"".join(
            [
                _build_header_string(":message-type", "event"),
                _build_header_string(":event-type", "assistantResponseEvent"),
            ]
        )
        payload = json.dumps({"content": "Hello"}).encode("utf-8")
        frame_bytes = _build_frame(headers, payload)

        dec = AwsEventStreamDecoder()
        dec.feed(frame_bytes)
        frames = list(dec.decode_iter())

        self.assertEqual(len(frames), 1)
        frame = frames[0]
        self.assertEqual(frame.message_type, "event")
        self.assertEqual(frame.event_type, "assistantResponseEvent")
        self.assertEqual(json.loads(frame.payload)["content"], "Hello")


if __name__ == "__main__":
    unittest.main()

