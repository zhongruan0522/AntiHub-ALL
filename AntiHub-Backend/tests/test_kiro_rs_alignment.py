import unittest

from app.schemas.anthropic import AnthropicMessagesRequest
from app.services.kiro_anthropic_converter import (
    EDIT_TOOL_DESCRIPTION_SUFFIX,
    SYSTEM_CHUNKED_POLICY,
    WRITE_TOOL_DESCRIPTION_SUFFIX,
    KiroAnthropicConverter,
)


class TestKiroRsAlignment(unittest.TestCase):
    def test_system_chunked_policy_appended(self) -> None:
        request = AnthropicMessagesRequest(
            model="claude-sonnet-4-20250514",
            max_tokens=128,
            system="sys",
            messages=[{"role": "user", "content": "hi"}],
        )

        out = KiroAnthropicConverter.to_kiro_chat_completions_request(request)
        history = out["conversationState"]["history"]

        # system prompt is represented as a userInputMessage + assistantResponseMessage pair
        system_user = history[0]["userInputMessage"]["content"]
        self.assertIn("sys", system_user)
        self.assertIn(SYSTEM_CHUNKED_POLICY, system_user)

    def test_write_edit_tool_description_suffix(self) -> None:
        request = AnthropicMessagesRequest(
            model="claude-sonnet-4-20250514",
            max_tokens=128,
            messages=[{"role": "user", "content": "hi"}],
            tools=[
                {
                    "name": "Write",
                    "description": "write tool",
                    "input_schema": {"type": "object", "properties": {}},
                },
                {
                    "name": "Edit",
                    "description": "edit tool",
                    "input_schema": {"type": "object", "properties": {}},
                },
            ],
        )

        out = KiroAnthropicConverter.to_kiro_chat_completions_request(request)
        tools = (
            out["conversationState"]["currentMessage"]["userInputMessage"]["userInputMessageContext"].get("tools") or []
        )
        by_name = {t["toolSpecification"]["name"]: t["toolSpecification"]["description"] for t in tools}

        self.assertIn(WRITE_TOOL_DESCRIPTION_SUFFIX, by_name["Write"])
        self.assertIn(EDIT_TOOL_DESCRIPTION_SUFFIX, by_name["Edit"])
        self.assertLessEqual(len(by_name["Write"]), 10000)
        self.assertLessEqual(len(by_name["Edit"]), 10000)

    def test_merge_consecutive_user_messages_in_history(self) -> None:
        request = AnthropicMessagesRequest(
            model="claude-opus-4-6",
            max_tokens=128,
            messages=[
                {"role": "user", "content": "a"},
                {"role": "user", "content": "b"},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "final"},
            ],
        )

        out = KiroAnthropicConverter.to_kiro_chat_completions_request(request)
        history = out["conversationState"]["history"]

        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["userInputMessage"]["content"], "a\nb")
        self.assertEqual(history[1]["assistantResponseMessage"]["content"], "ok")

    def test_trailing_user_messages_are_auto_paired_with_ok(self) -> None:
        request = AnthropicMessagesRequest(
            model="claude-opus-4-6",
            max_tokens=128,
            messages=[
                {"role": "user", "content": "a"},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "tail1"},
                {"role": "user", "content": "tail2"},
                {"role": "user", "content": "final"},
            ],
        )

        out = KiroAnthropicConverter.to_kiro_chat_completions_request(request)
        history = out["conversationState"]["history"]

        self.assertEqual(history[-1]["assistantResponseMessage"]["content"], "OK")
        self.assertEqual(history[-2]["userInputMessage"]["content"], "tail1\ntail2")

    def test_tool_use_only_assistant_has_minimal_placeholder_content(self) -> None:
        request = AnthropicMessagesRequest(
            model="claude-opus-4-6",
            max_tokens=128,
            messages=[
                {"role": "user", "content": "hi"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {}},
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "tool-1", "content": "ok", "is_error": False},
                        {"type": "text", "text": "next"},
                    ],
                },
            ],
        )

        out = KiroAnthropicConverter.to_kiro_chat_completions_request(request)
        history = out["conversationState"]["history"]

        assistant_msg = history[1]["assistantResponseMessage"]
        self.assertEqual(assistant_msg["content"], " ")
        self.assertIn("toolUses", assistant_msg)


if __name__ == "__main__":
    unittest.main()
