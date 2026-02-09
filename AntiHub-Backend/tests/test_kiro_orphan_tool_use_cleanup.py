import unittest

from app.schemas.anthropic import AnthropicMessagesRequest
from app.services.kiro_anthropic_converter import KiroAnthropicConverter


class TestKiroOrphanToolUseCleanup(unittest.TestCase):
    def test_missing_tool_use_id_is_patched_and_paired(self) -> None:
        request = AnthropicMessagesRequest(
            model="claude-opus-4.6",
            max_tokens=128,
            messages=[
                {"role": "user", "content": "hi"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {}},
                        # Simulate upstream/client bug: missing/blank tool_use id.
                        {"type": "tool_use", "id": "", "name": "Write", "input": {}},
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "tool-1", "content": "ok", "is_error": False},
                        # Simulate upstream/client bug: missing/blank tool_use_id.
                        {"type": "tool_result", "tool_use_id": "", "content": "ok2", "is_error": False},
                    ],
                },
            ],
        )

        out = KiroAnthropicConverter.to_kiro_chat_completions_request(request)
        conversation_state = out["conversationState"]
        history = conversation_state["history"]

        assistant_msg = history[1]["assistantResponseMessage"]
        self.assertIn("toolUses", assistant_msg)
        tool_uses = assistant_msg["toolUses"]
        self.assertEqual(len(tool_uses), 2)

        tool_use_ids = [tu["toolUseId"] for tu in tool_uses]
        self.assertIn("tool-1", tool_use_ids)
        self.assertTrue(all(isinstance(tid, str) and tid for tid in tool_use_ids))

        generated_id = next(tid for tid in tool_use_ids if tid != "tool-1")

        current_tool_results = (
            conversation_state["currentMessage"]["userInputMessage"]["userInputMessageContext"]["toolResults"]
        )
        current_ids = [r["toolUseId"] for r in current_tool_results]
        self.assertIn("tool-1", current_ids)
        self.assertIn(generated_id, current_ids)

    def test_orphan_tool_use_removed_from_history(self) -> None:
        request = AnthropicMessagesRequest(
            model="claude-opus-4.6",
            max_tokens=128,
            messages=[
                {"role": "user", "content": "hi"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {}},
                    ],
                },
                {"role": "user", "content": "next"},
            ],
        )

        out = KiroAnthropicConverter.to_kiro_chat_completions_request(request)
        history = out["conversationState"]["history"]

        assistant_msg = history[1]["assistantResponseMessage"]
        self.assertNotIn("toolUses", assistant_msg)

    def test_tool_use_kept_when_result_in_current_message(self) -> None:
        request = AnthropicMessagesRequest(
            model="claude-opus-4.6",
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
                        {
                            "type": "tool_result",
                            "tool_use_id": "tool-1",
                            "content": "ok",
                            "is_error": False,
                        },
                        {"type": "text", "text": "continue"},
                    ],
                },
            ],
        )

        out = KiroAnthropicConverter.to_kiro_chat_completions_request(request)
        conversation_state = out["conversationState"]
        history = conversation_state["history"]

        assistant_msg = history[1]["assistantResponseMessage"]
        self.assertIn("toolUses", assistant_msg)
        self.assertEqual(assistant_msg["toolUses"][0]["toolUseId"], "tool-1")

        current_tool_results = (
            conversation_state["currentMessage"]["userInputMessage"]["userInputMessageContext"]["toolResults"]
        )
        self.assertEqual(current_tool_results[0]["toolUseId"], "tool-1")

    def test_only_orphaned_tool_uses_removed(self) -> None:
        request = AnthropicMessagesRequest(
            model="claude-opus-4.6",
            max_tokens=128,
            messages=[
                {"role": "user", "content": "hi"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {}},
                        {"type": "tool_use", "id": "tool-2", "name": "Write", "input": {}},
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "tool-2",
                            "content": "ok",
                            "is_error": False,
                        }
                    ],
                },
            ],
        )

        out = KiroAnthropicConverter.to_kiro_chat_completions_request(request)
        history = out["conversationState"]["history"]

        assistant_msg = history[1]["assistantResponseMessage"]
        self.assertIn("toolUses", assistant_msg)
        self.assertEqual(len(assistant_msg["toolUses"]), 1)
        self.assertEqual(assistant_msg["toolUses"][0]["toolUseId"], "tool-2")


if __name__ == "__main__":
    unittest.main()
