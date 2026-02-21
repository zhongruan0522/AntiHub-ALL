import unittest
from types import SimpleNamespace

from app.services.kiro_service import KiroService


class TestKiroRegionResolution(unittest.TestCase):
    def test_effective_auth_region_prefers_creds_auth_region(self) -> None:
        account = SimpleNamespace(auth_method="IdC", region="ap-southeast-1")
        creds = {"auth_region": "eu-west-1", "region": "ap-southeast-1"}

        self.assertEqual(
            KiroService._effective_auth_region(account=account, creds=creds),
            "eu-west-1",
        )

    def test_effective_api_region_prefers_creds_api_region(self) -> None:
        account = SimpleNamespace(auth_method="IdC", region="ap-southeast-1")
        creds = {"api_region": "eu-central-1", "region": "ap-southeast-1"}

        self.assertEqual(
            KiroService._effective_api_region(account=account, creds=creds),
            "eu-central-1",
        )

    def test_effective_api_region_defaults_to_us_east_1_for_idc(self) -> None:
        account = SimpleNamespace(auth_method="IdC", region="ap-southeast-1")
        creds = {"region": "ap-southeast-1"}

        self.assertEqual(
            KiroService._effective_api_region(account=account, creds=creds),
            "us-east-1",
        )

    def test_effective_api_region_defaults_to_us_east_1_for_idc_alias(self) -> None:
        account = SimpleNamespace(auth_method="IAM", region="eu-central-1")
        creds = {"region": "eu-central-1"}

        self.assertEqual(
            KiroService._effective_api_region(account=account, creds=creds),
            "us-east-1",
        )

    def test_effective_api_region_falls_back_to_account_region_for_social(self) -> None:
        account = SimpleNamespace(auth_method="Social", region="ap-northeast-1")
        creds = {"region": "ap-northeast-1"}

        self.assertEqual(
            KiroService._effective_api_region(account=account, creds=creds),
            "ap-northeast-1",
        )


if __name__ == "__main__":
    unittest.main()

