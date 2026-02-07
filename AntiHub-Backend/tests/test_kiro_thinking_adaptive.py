import unittest

from app.utils.kiro_converters import (
    generate_thinking_hint,
    inject_thinking_hint,
    is_thinking_enabled,
)
from app.utils.thinking_parser import KiroThinkingTagParser, SegmentType


class TestKiroThinkingAdaptive(unittest.TestCase):
    def test_is_thinking_enabled_adaptive(self) -> None:
        self.assertTrue(is_thinking_enabled({"type": "adaptive"}))
        self.assertTrue(is_thinking_enabled("adaptive"))

    def test_is_thinking_enabled_enabled_compat(self) -> None:
        self.assertTrue(is_thinking_enabled(True))
        self.assertTrue(is_thinking_enabled({"type": "enabled", "budget_tokens": 10000}))

    def test_generate_thinking_hint_adaptive_effort(self) -> None:
        hint = generate_thinking_hint(
            {"type": "adaptive"},
            output_config={"effort": "medium"},
        )
        self.assertIn("<thinking_mode>adaptive</thinking_mode>", hint)
        self.assertIn("<thinking_effort>medium</thinking_effort>", hint)

    def test_generate_thinking_hint_adaptive_default_effort(self) -> None:
        hint = generate_thinking_hint({"type": "adaptive"})
        self.assertIn("<thinking_effort>high</thinking_effort>", hint)

    def test_generate_thinking_hint_enabled_budget_clamped(self) -> None:
        hint = generate_thinking_hint({"type": "enabled", "budget_tokens": 999999})
        self.assertIn("<thinking_mode>enabled</thinking_mode>", hint)
        self.assertIn("<max_thinking_length>24576</max_thinking_length>", hint)

    def test_inject_thinking_hint_adaptive(self) -> None:
        out = inject_thinking_hint(
            "sys",
            {"type": "adaptive"},
            output_config={"effort": "low"},
        )
        self.assertTrue(
            out.startswith(
                "<thinking_mode>adaptive</thinking_mode><thinking_effort>low</thinking_effort>\n\n"
            )
        )

    def test_thinking_parser_skips_leading_whitespace_before_open_tag(self) -> None:
        parser = KiroThinkingTagParser()
        self.assertEqual(parser.push_and_parse("\n\n"), [])

        segments = parser.push_and_parse("<thinking>abc</thinking>\n\nHello")
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0].type, SegmentType.THINKING)
        self.assertEqual(segments[0].content, "abc")
        self.assertEqual(segments[1].type, SegmentType.TEXT)
        self.assertEqual(segments[1].content, "Hello")

    def test_thinking_parser_open_tag_split_across_chunks(self) -> None:
        parser = KiroThinkingTagParser()
        self.assertEqual(parser.push_and_parse("\n\n<think"), [])

        segments = parser.push_and_parse("ing>abc</thinking>\n\n")
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].type, SegmentType.THINKING)
        self.assertEqual(segments[0].content, "abc")

    def test_thinking_parser_passthrough_when_not_thinking(self) -> None:
        parser = KiroThinkingTagParser()
        segments = parser.push_and_parse("\n\nHello")
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].type, SegmentType.TEXT)
        self.assertEqual(segments[0].content, "\n\nHello")


if __name__ == "__main__":
    unittest.main()

