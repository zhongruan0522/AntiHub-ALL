import unittest

from pydantic import ValidationError

from app.schemas.api_key import APIKeyUpdateType


class TestAPIKeySchema(unittest.TestCase):
    def test_update_type_valid(self) -> None:
        req = APIKeyUpdateType(config_type="codex")
        self.assertEqual(req.config_type, "codex")

    def test_update_type_invalid(self) -> None:
        with self.assertRaises(ValidationError):
            APIKeyUpdateType(config_type="not-a-real-type")


if __name__ == "__main__":
    unittest.main()

