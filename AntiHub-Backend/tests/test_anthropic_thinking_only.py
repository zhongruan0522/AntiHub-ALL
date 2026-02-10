import asyncio
import json
import unittest
from typing import AsyncGenerator, List

from app.services.anthropic_adapter import AnthropicAdapter


async def _gen_openai_sse(lines: List[dict]) -> AsyncGenerator[bytes, None]:
    for payload in lines:
        yield (f"data: {json.dumps(payload, ensure_ascii=False)}\n\n").encode("utf-8")


def _extract_event_payloads(events: List[str], event_name: str) -> List[dict]:
    out: List[dict] = []
    for raw in events:
        if not raw.startswith(f"event: {event_name}\n"):
            continue
        data_line = next((line for line in raw.splitlines() if line.startswith("data: ")), "")
        if not data_line:
            continue
        out.append(json.loads(data_line[6:]))
    return out


class TestAnthropicThinkingOnly(unittest.TestCase):
    def test_openai_to_anthropic_response_thinking_only_sets_max_tokens_and_text(self) -> None:
        openai_response = {
            "id": "resp_1",
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "reasoning_content": "abc",
                        "content": "",
                    },
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2},
        }

        out = AnthropicAdapter.openai_to_anthropic_response(openai_response, model="test-model")
        self.assertEqual(out.stop_reason, "max_tokens")
        self.assertTrue(any(getattr(b, "type", None) == "thinking" for b in out.content))
        self.assertTrue(any(getattr(b, "type", None) == "text" for b in out.content))
        self.assertTrue(any(getattr(b, "type", None) == "text" and b.text == " " for b in out.content))

    def test_openai_to_anthropic_response_thinking_with_text_keeps_end_turn(self) -> None:
        openai_response = {
            "id": "resp_2",
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "reasoning_content": "abc",
                        "content": "Hello",
                    },
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2},
        }

        out = AnthropicAdapter.openai_to_anthropic_response(openai_response, model="test-model")
        self.assertEqual(out.stop_reason, "end_turn")
        texts = [b.text for b in out.content if getattr(b, "type", None) == "text"]
        self.assertEqual(texts, ["Hello"])

    def test_stream_thinking_only_emits_space_text_delta_and_max_tokens_stop_reason(self) -> None:
        async def _collect() -> List[str]:
            stream = _gen_openai_sse(
                [
                    {"choices": [{"delta": {"reasoning_content": "abc"}}]},
                    {
                        "usage": {"prompt_tokens": 5, "completion_tokens": 7},
                        "choices": [{"delta": {}, "finish_reason": "stop"}],
                    },
                ]
            )

            out_events: List[str] = []
            async for ev in AnthropicAdapter.convert_openai_stream_to_anthropic(
                openai_stream=stream,
                model="test-model",
                request_id="req_1",
                thinking_enabled=False,
            ):
                out_events.append(ev)
            return out_events

        events = asyncio.run(_collect())

        deltas = _extract_event_payloads(events, "message_delta")
        self.assertTrue(deltas, "should emit message_delta")
        self.assertEqual(deltas[-1]["delta"]["stop_reason"], "max_tokens")

        block_deltas = _extract_event_payloads(events, "content_block_delta")
        self.assertTrue(
            any(
                d.get("delta", {}).get("type") == "text_delta"
                and d.get("delta", {}).get("text") == " "
                for d in block_deltas
            ),
            "should emit a space text_delta when only thinking is produced",
        )


if __name__ == "__main__":
    unittest.main()

