import unittest

from app.services.kiro_anthropic_converter import KiroAnthropicConverter


class TestKiroModelMapping(unittest.TestCase):
    def test_claude_opus_46_emits_dot_version(self) -> None:
        # 用户可能会传入不同写法：4.6 / 4-6 / 带日期后缀
        self.assertEqual(KiroAnthropicConverter._map_model("claude-opus-4.6"), "claude-opus-4.6")
        self.assertEqual(KiroAnthropicConverter._map_model("claude-opus-4-6"), "claude-opus-4.6")
        self.assertEqual(
            KiroAnthropicConverter._map_model("claude-opus-4-6-20260205"),
            "claude-opus-4.6",
        )

    def test_claude_opus_45_stays_45(self) -> None:
        self.assertEqual(KiroAnthropicConverter._map_model("claude-opus-4.5"), "claude-opus-4.5")
        self.assertEqual(
            KiroAnthropicConverter._map_model("claude-opus-4-5-20251101"),
            "claude-opus-4.5",
        )


if __name__ == "__main__":
    unittest.main()

