import json
import unittest

from app.utils.gemini_openai_chat_compat import (
    ChatCompletionsSSEToGeminiSSETranslator,
    gemini_generate_content_request_to_openai_chat_request,
    openai_chat_response_to_gemini_response,
)


def _parse_sse_data_line(raw: bytes) -> dict:
    s = raw.decode("utf-8", errors="replace").strip()
    assert s.startswith("data:")
    payload = s[len("data:") :].strip()
    return json.loads(payload)


class TestGeminiOpenAIChatCompat(unittest.TestCase):
    def test_request_text_to_openai_chat(self) -> None:
        req = {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}
        out = gemini_generate_content_request_to_openai_chat_request(
            model="gemini-2.5-pro",
            request_data=req,
            stream=False,
        )
        self.assertEqual(out["model"], "gemini-2.5-pro")
        self.assertEqual(out["stream"], False)
        self.assertEqual(out["messages"][0]["role"], "user")
        self.assertEqual(out["messages"][0]["content"], "hi")

    def test_request_inline_data_to_openai_chat(self) -> None:
        req = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": "hi"},
                        {"inlineData": {"mimeType": "image/png", "data": "AAA"}},
                    ],
                }
            ]
        }
        out = gemini_generate_content_request_to_openai_chat_request(
            model="gemini-2.5-pro",
            request_data=req,
            stream=False,
        )
        content = out["messages"][0]["content"]
        self.assertIsInstance(content, list)
        self.assertEqual(content[0]["type"], "text")
        self.assertEqual(content[0]["text"], "hi")
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_response_openai_chat_to_gemini(self) -> None:
        openai_resp = {
            "id": "chatcmpl_test",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "hello"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
        }
        out = openai_chat_response_to_gemini_response(openai_resp)
        self.assertEqual(out["candidates"][0]["content"]["role"], "model")
        self.assertEqual(out["candidates"][0]["content"]["parts"][0]["text"], "hello")
        self.assertEqual(out["candidates"][0]["finishReason"], "STOP")
        self.assertEqual(out["usageMetadata"]["promptTokenCount"], 1)
        self.assertEqual(out["usageMetadata"]["candidatesTokenCount"], 2)
        self.assertEqual(out["usageMetadata"]["totalTokenCount"], 3)

    def test_stream_chat_sse_to_gemini_sse(self) -> None:
        tr = ChatCompletionsSSEToGeminiSSETranslator()

        p1 = {"choices": [{"delta": {"content": "hel"}}]}
        out1, done1 = tr.feed(f"data: {json.dumps(p1)}\n\n".encode("utf-8"))
        self.assertFalse(done1)
        self.assertEqual(len(out1), 1)
        ev1 = _parse_sse_data_line(out1[0])
        self.assertEqual(ev1["candidates"][0]["content"]["parts"][0]["text"], "hel")

        p2 = {
            "choices": [{"delta": {"content": "lo"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        out2, done2 = tr.feed(f"data: {json.dumps(p2)}\n\n".encode("utf-8"))
        self.assertFalse(done2)
        self.assertEqual(len(out2), 1)
        ev2 = _parse_sse_data_line(out2[0])
        self.assertEqual(ev2["candidates"][0]["content"]["parts"][0]["text"], "lo")
        self.assertEqual(ev2["candidates"][0]["finishReason"], "STOP")
        self.assertEqual(ev2["usageMetadata"]["totalTokenCount"], 2)

        out3, done3 = tr.feed(b"data: [DONE]\n\n")
        self.assertTrue(done3)
        self.assertEqual(out3, [])


if __name__ == "__main__":
    unittest.main()

