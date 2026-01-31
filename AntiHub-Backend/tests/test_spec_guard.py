import unittest

from fastapi import HTTPException

from app.core.spec_guard import SPEC_NOT_SUPPORTED_DETAIL, ensure_spec_allowed


class TestSpecGuard(unittest.TestCase):
    def _assert_rejected(self, spec: str, config_type: str) -> None:
        with self.assertRaises(HTTPException) as ctx:
            ensure_spec_allowed(spec, config_type)
        exc = ctx.exception
        self.assertEqual(exc.status_code, 403)
        self.assertEqual(exc.detail, SPEC_NOT_SUPPORTED_DETAIL)

    def test_oairesponses_allow_and_reject(self) -> None:
        ensure_spec_allowed("OAIResponses", "codex")
        self._assert_rejected("OAIResponses", "antigravity")

    def test_oaichat_allow_and_reject(self) -> None:
        ensure_spec_allowed("OAIChat", "qwen")
        self._assert_rejected("OAIChat", "codex")

    def test_claude_allow_and_reject(self) -> None:
        ensure_spec_allowed("Claude", "antigravity")
        ensure_spec_allowed("Claude", "qwen")
        self._assert_rejected("Claude", "codex")

    def test_gemini_allow_and_reject(self) -> None:
        ensure_spec_allowed("Gemini", "gemini-cli")
        ensure_spec_allowed("Gemini", "antigravity")
        self._assert_rejected("Gemini", "qwen")


if __name__ == "__main__":
    unittest.main()
