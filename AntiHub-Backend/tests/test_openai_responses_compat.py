import json
import unittest

from app.utils.openai_responses_compat import (
    ResponsesToChatCompletionsSSETranslator,
    chat_completions_request_to_responses_request,
    responses_response_to_chat_completions_response,
)


class TestOpenAIResponsesCompat(unittest.TestCase):
    def test_chat_to_responses_request_basic(self) -> None:
        chat_req = {
            "model": "gpt-5-codex",
            "stream": False,
            "messages": [
                {"role": "system", "content": "You are helpful."},
                {"role": "user", "content": "Hello"},
                {"role": "tool", "tool_call_id": "call_1", "content": "{\"ok\":true}"},
            ],
        }

        resp_req = chat_completions_request_to_responses_request(chat_req)
        self.assertEqual(resp_req.get("model"), "gpt-5-codex")
        self.assertEqual(resp_req.get("stream"), False)
        self.assertEqual(resp_req.get("instructions"), "You are helpful.")

        input_items = resp_req.get("input")
        self.assertIsInstance(input_items, list)
        self.assertEqual(input_items[0]["type"], "message")
        self.assertEqual(input_items[0]["role"], "user")
        self.assertEqual(input_items[0]["content"][0]["type"], "input_text")
        self.assertEqual(input_items[0]["content"][0]["text"], "Hello")
        self.assertEqual(input_items[1]["type"], "function_call_output")
        self.assertEqual(input_items[1]["call_id"], "call_1")

    def test_responses_to_chat_response_basic(self) -> None:
        chat_req = {"model": "gpt-5-codex", "messages": [{"role": "user", "content": "hi"}]}
        resp_obj = {
            "id": "resp_123",
            "object": "response",
            "created_at": 1,
            "model": "gpt-5-codex",
            "output": [
                {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "output_text", "text": "Hi!", "annotations": [], "logprobs": []},
                    ],
                }
            ],
            "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        }

        chat_resp = responses_response_to_chat_completions_response(resp_obj, original_request=chat_req)
        self.assertEqual(chat_resp["object"], "chat.completion")
        self.assertTrue(str(chat_resp["id"]).startswith("chatcmpl_"))
        self.assertEqual(chat_resp["choices"][0]["message"]["role"], "assistant")
        self.assertEqual(chat_resp["choices"][0]["message"]["content"], "Hi!")
        self.assertEqual(
            chat_resp.get("usage"),
            {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
        )

    def test_responses_sse_to_chat_sse(self) -> None:
        chat_req = {
            "model": "gpt-5-codex",
            "messages": [{"role": "user", "content": "hi"}],
        }
        translator = ResponsesToChatCompletionsSSETranslator(original_request=chat_req)

        raw = b"".join(
            [
                b"event: response.output_text.delta\n"
                b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\n",
                b"event: response.output_text.delta\n"
                b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\n",
                b"event: response.completed\n"
                b"data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
            ]
        )

        outs, done = translator.feed(raw)
        self.assertTrue(done)

        out_bytes = b"".join(outs)
        self.assertIn(b"data: [DONE]", out_bytes)

        data_lines = [
            line[len(b"data: ") :].strip()
            for line in out_bytes.splitlines()
            if line.startswith(b"data: {")
        ]
        self.assertGreaterEqual(len(data_lines), 2)

        first = json.loads(data_lines[0].decode("utf-8"))
        self.assertEqual(first["object"], "chat.completion.chunk")
        self.assertEqual(first["choices"][0]["delta"]["role"], "assistant")
        self.assertEqual(first["choices"][0]["delta"]["content"], "Hel")

        second = json.loads(data_lines[1].decode("utf-8"))
        self.assertEqual(second["choices"][0]["delta"]["content"], "lo")


if __name__ == "__main__":
    unittest.main()

