import unittest

from app.utils.model_normalization import normalize_claude_model_id


class TestClaudeModelNormalization(unittest.TestCase):
    def test_dash_to_dot(self) -> None:
        self.assertEqual(normalize_claude_model_id("claude-sonnet-4-6"), "claude-sonnet-4.6")
        self.assertEqual(normalize_claude_model_id("claude-opus-4-6"), "claude-opus-4.6")
        self.assertEqual(normalize_claude_model_id("claude-opus-4-5"), "claude-opus-4.5")

    def test_date_suffix_collapsed(self) -> None:
        self.assertEqual(
            normalize_claude_model_id("claude-sonnet-4-5-20250929"),
            "claude-sonnet-4.5",
        )
        self.assertEqual(
            normalize_claude_model_id("claude-opus-4-5-20251101"),
            "claude-opus-4.5",
        )
        self.assertEqual(
            normalize_claude_model_id("claude-sonnet-4-20250514"),
            "claude-sonnet-4",
        )

    def test_thinking_suffix_stripped(self) -> None:
        self.assertEqual(
            normalize_claude_model_id("claude-sonnet-4-6-thinking"),
            "claude-sonnet-4.6",
        )

    def test_provider_prefix_preserved(self) -> None:
        self.assertEqual(
            normalize_claude_model_id("anthropic/claude-sonnet-4-6"),
            "anthropic/claude-sonnet-4.6",
        )

    def test_passthrough(self) -> None:
        self.assertEqual(normalize_claude_model_id("gemini-2.5-pro"), "gemini-2.5-pro")
        self.assertEqual(normalize_claude_model_id("claude-3-5-sonnet"), "claude-3-5-sonnet")


if __name__ == "__main__":
    unittest.main()

