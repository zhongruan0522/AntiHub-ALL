import unittest

from app.services.gemini_cli_api_service import _normalize_gemini_request_to_cli_request


class TestGeminiCLINormalizeGeminiRequest(unittest.TestCase):
    def test_inline_data_normalized_and_thought_signature_injected(self) -> None:
        req = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": "what is in the image?"},
                        {"inlineData": {"mimeType": "image/png", "data": "AAA"}},
                    ],
                }
            ]
        }

        out = _normalize_gemini_request_to_cli_request("gemini-2.5-pro", req)

        # Ensure normalization does not mutate the original request object.
        self.assertNotIn("thoughtSignature", req["contents"][0]["parts"][1])
        self.assertNotIn("mime_type", req["contents"][0]["parts"][1]["inlineData"])

        part = out["request"]["contents"][0]["parts"][1]
        self.assertEqual(part["thoughtSignature"], "skip_thought_signature_validator")
        self.assertNotIn("mimeType", part["inlineData"])
        self.assertEqual(part["inlineData"]["mime_type"], "image/png")
        self.assertEqual(part["inlineData"]["data"], "AAA")

    def test_file_data_normalized_and_thought_signature_injected(self) -> None:
        req = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "fileData": {
                                "mimeType": "video/mp4",
                                "fileUri": "gs://bucket/video.mp4",
                            }
                        }
                    ],
                }
            ]
        }

        out = _normalize_gemini_request_to_cli_request("gemini-2.5-pro", req)

        part = out["request"]["contents"][0]["parts"][0]
        self.assertEqual(part["thoughtSignature"], "skip_thought_signature_validator")
        self.assertNotIn("mimeType", part["fileData"])
        self.assertNotIn("fileUri", part["fileData"])
        self.assertEqual(part["fileData"]["mime_type"], "video/mp4")
        self.assertEqual(part["fileData"]["file_uri"], "gs://bucket/video.mp4")

    def test_existing_thought_signature_preserved(self) -> None:
        req = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "inlineData": {"mimeType": "image/png", "data": "AAA"},
                            "thoughtSignature": "keep",
                        }
                    ],
                }
            ]
        }

        out = _normalize_gemini_request_to_cli_request("gemini-2.5-pro", req)
        part = out["request"]["contents"][0]["parts"][0]
        self.assertEqual(part["thoughtSignature"], "keep")

    def test_snake_case_thought_signature_normalized(self) -> None:
        req = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "inlineData": {"mimeType": "image/png", "data": "AAA"},
                            "thought_signature": "sig",
                        }
                    ],
                }
            ]
        }

        out = _normalize_gemini_request_to_cli_request("gemini-2.5-pro", req)
        part = out["request"]["contents"][0]["parts"][0]
        self.assertEqual(part["thoughtSignature"], "sig")
        self.assertNotIn("thought_signature", part)


if __name__ == "__main__":
    unittest.main()
