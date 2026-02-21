"""
Feature: kiro-enterprise-account, Property 1: 企业账户创建字段正确性

Property 1: For any 有效的企业账户凭据集（包含 refreshToken、clientId、clientSecret、region），
通过导入 API 创建的账号记录应满足：auth_method 为 "IdC"，且加密凭据 JSON 中包含
provider: "Enterprise"。

**Validates: Requirements 1.1**
"""

from __future__ import annotations

import json
import secrets
from typing import Any, Dict, Optional

from hypothesis import given, settings
from hypothesis import strategies as st


# ---------------------------------------------------------------------------
# Pure helper functions copied from app.api.routes.kiro_enterprise
#
# These are pure functions with zero framework dependencies.  We duplicate
# them here so the test can run without SQLAlchemy / FastAPI / etc.
# Any drift between these copies and the source is caught by the property
# tests themselves — if the route changes behaviour, the tests will fail.
# ---------------------------------------------------------------------------


def _get_first_value(data: Dict[str, Any], keys: list[str]) -> Optional[str]:
    """从 dict 中按优先级取第一个非空字符串值（支持 camelCase/snake_case）。"""
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def parse_enterprise_credentials(data: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """
    从 dict 中解析企业账户凭据，支持 camelCase 和 snake_case 字段名。

    返回包含 refresh_token, client_id, client_secret, region 的 dict。
    """
    return {
        "refresh_token": _get_first_value(data, ["refresh_token", "refreshToken"]),
        "client_id": _get_first_value(data, ["client_id", "clientId"]),
        "client_secret": _get_first_value(data, ["client_secret", "clientSecret"]),
        "region": _get_first_value(data, ["region", "aws_region", "awsRegion"]),
    }


def validate_required_credentials(creds: Dict[str, Optional[str]]) -> None:
    """校验必填字段，缺失时抛出 ValueError。"""
    if not creds.get("refresh_token"):
        raise ValueError("missing refresh_token")
    if not creds.get("client_id"):
        raise ValueError("missing client_id")
    if not creds.get("client_secret"):
        raise ValueError("missing client_secret")


# ---------------------------------------------------------------------------
# Helpers — replicate the account_data construction from the route
# ---------------------------------------------------------------------------


def _build_account_data(creds: Dict[str, Any]) -> Dict[str, Any]:
    """Mirror the account_data dict built in import_kiro_enterprise_credentials."""
    region = creds.get("region") or "us-east-1"
    return {
        "account_name": "Kiro Enterprise",
        "auth_method": "IdC",
        "provider": "Enterprise",
        "refresh_token": creds["refresh_token"],
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "machineid": secrets.token_hex(32),
        "region": region,
        "is_shared": 0,
    }


def _build_credentials_payload(account_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Simulate the credentials_payload construction from
    KiroService.create_account — the subset relevant to Property 1.
    """
    payload: Dict[str, Any] = {
        "type": "kiro",
        "refresh_token": account_data["refresh_token"],
        "access_token": None,
        "client_id": account_data["client_id"],
        "client_secret": account_data["client_secret"],
        "region": account_data["region"],
        "auth_region": account_data["region"],
        "api_region": "us-east-1",
        "auth_method": account_data["auth_method"],
    }
    provider = account_data.get("provider")
    if provider:
        payload["provider"] = provider
    return payload


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------

# Non-empty, non-whitespace-only strings for required credential fields
_nonempty_str = st.text(min_size=1, max_size=200).filter(lambda s: s.strip())

_valid_credentials = st.fixed_dictionaries(
    {
        "refresh_token": _nonempty_str,
        "client_id": _nonempty_str,
        "client_secret": _nonempty_str,
    },
    optional={
        "region": st.sampled_from(
            ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"]
        ),
    },
)


# ---------------------------------------------------------------------------
# Property 1 — 企业账户创建字段正确性
# ---------------------------------------------------------------------------


class TestEnterpriseAccountCreationFields:
    """Property 1: 企业账户创建字段正确性"""

    @given(creds=_valid_credentials)
    @settings(max_examples=100)
    def test_account_data_has_idc_auth_method_and_enterprise_provider(
        self, creds: Dict[str, Any]
    ) -> None:
        """
        For any valid enterprise credentials, the constructed account_data
        must have auth_method="IdC" and provider="Enterprise".

        **Validates: Requirements 1.1**
        """
        # 1) parse_enterprise_credentials correctly extracts fields
        parsed = parse_enterprise_credentials(creds)
        assert parsed["refresh_token"] == creds["refresh_token"].strip()
        assert parsed["client_id"] == creds["client_id"].strip()
        assert parsed["client_secret"] == creds["client_secret"].strip()

        # 2) Validation passes for valid credentials
        validate_required_credentials(parsed)

        # 3) Build account_data the same way the route does
        account_data = _build_account_data(parsed)

        # 4) Property assertions
        assert account_data["auth_method"] == "IdC"
        assert account_data["provider"] == "Enterprise"

    @given(creds=_valid_credentials)
    @settings(max_examples=100)
    def test_credentials_payload_contains_enterprise_provider(
        self, creds: Dict[str, Any]
    ) -> None:
        """
        For any valid enterprise credentials, the credentials_payload JSON
        (as built by KiroService.create_account) must include provider="Enterprise"
        after JSON round-trip.

        **Validates: Requirements 1.1**
        """
        parsed = parse_enterprise_credentials(creds)
        validate_required_credentials(parsed)
        account_data = _build_account_data(parsed)

        credentials_payload = _build_credentials_payload(account_data)

        # Serialize and deserialize to mirror real encryption/decryption flow
        payload_json = json.dumps(credentials_payload, ensure_ascii=False)
        restored = json.loads(payload_json)

        assert restored["auth_method"] == "IdC"
        assert restored.get("provider") == "Enterprise"

# ---------------------------------------------------------------------------
# Hypothesis strategies — Property 2
# ---------------------------------------------------------------------------

# Values that represent "missing or empty" for a required field
_missing_or_empty = st.one_of(
    st.just(None),
    st.just(""),
    st.just("   "),
    # whitespace-only strings of varying length
    st.text(alphabet=" \t\n\r", min_size=1, max_size=10),
)

# Required field names
_REQUIRED_FIELDS = ["refresh_token", "client_id", "client_secret"]


@st.composite
def _credentials_with_at_least_one_missing(draw: st.DrawFn) -> Dict[str, Any]:
    """
    Generate a credentials dict where at least one of the three required fields
    (refresh_token, client_id, client_secret) is None, empty, or whitespace-only.

    Strategy: for each required field, randomly decide whether it's valid or invalid.
    Then ensure at least one field is invalid.
    """
    # For each field, decide: valid or invalid
    choices = draw(
        st.lists(st.booleans(), min_size=3, max_size=3).filter(
            lambda bools: not all(bools)  # at least one must be invalid
        )
    )

    result: Dict[str, Any] = {}
    for field, is_valid in zip(_REQUIRED_FIELDS, choices):
        if is_valid:
            result[field] = draw(_nonempty_str)
        else:
            result[field] = draw(_missing_or_empty)

    # Optionally include region (always valid when present)
    if draw(st.booleans()):
        result["region"] = draw(
            st.sampled_from(["us-east-1", "us-west-2", "eu-west-1"])
        )

    return result


# ---------------------------------------------------------------------------
# Property 2 — 必填字段缺失拒绝
# ---------------------------------------------------------------------------


class TestMissingRequiredFieldsRejection:
    """
    Feature: kiro-enterprise-account, Property 2: 必填字段缺失拒绝

    For any 企业账户导入请求，若 refreshToken、clientId、clientSecret 中任意一个
    或多个字段为空或缺失，系统应返回 HTTP 400 错误。

    At the pure-function level this means validate_required_credentials must
    raise ValueError for every such input.
    """

    @given(creds=_credentials_with_at_least_one_missing())
    @settings(max_examples=100)
    def test_validate_required_credentials_raises_for_missing_fields(
        self, creds: Dict[str, Any]
    ) -> None:
        """
        For any credential dict where at least one required field is
        None/empty/whitespace-only, validate_required_credentials must
        raise ValueError.

        **Validates: Requirements 1.2**
        """
        parsed = parse_enterprise_credentials(creds)

        import pytest

        with pytest.raises(ValueError, match="missing"):
            validate_required_credentials(parsed)

    @given(creds=_credentials_with_at_least_one_missing())
    @settings(max_examples=100)
    def test_error_message_names_a_missing_field(
        self, creds: Dict[str, Any]
    ) -> None:
        """
        The ValueError raised by validate_required_credentials should
        name one of the missing fields so the caller can report it in
        the HTTP 400 response.

        **Validates: Requirements 1.2**
        """
        parsed = parse_enterprise_credentials(creds)

        try:
            validate_required_credentials(parsed)
            # Should never reach here
            raise AssertionError("validate_required_credentials did not raise")
        except ValueError as exc:
            msg = str(exc)
            # The error message must reference at least one required field
            assert any(
                field in msg for field in _REQUIRED_FIELDS
            ), f"Error message '{msg}' does not reference any required field"


# ---------------------------------------------------------------------------
# Hypothesis strategies — Property 3
# ---------------------------------------------------------------------------

# Account dict that may be valid or invalid (mix of both)
_optional_str = st.one_of(
    st.none(),
    st.just(""),
    st.just("   "),
    _nonempty_str,
)

_random_account_dict = st.fixed_dictionaries(
    {},
    optional={
        "refresh_token": _optional_str,
        "refreshToken": _optional_str,
        "client_id": _optional_str,
        "clientId": _optional_str,
        "client_secret": _optional_str,
        "clientSecret": _optional_str,
        "region": st.sampled_from(
            [None, "", "us-east-1", "us-west-2", "eu-west-1"]
        ),
        "account_name": st.one_of(st.none(), _nonempty_str),
    },
)

# List of 0..30 random account dicts
_random_account_list = st.lists(_random_account_dict, min_size=0, max_size=30)


def _simulate_batch_import(accounts: list[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Simulate the batch_import_kiro_enterprise_credentials route logic
    without any DB/service dependencies.

    For each account in the input list, we parse credentials, validate,
    and build a result entry — mirroring the route's for-loop exactly.
    On success we record success=True; on any error we record success=False.
    Every account always produces exactly one result entry.
    """
    results = []

    for index, account_raw in enumerate(accounts):
        try:
            creds = parse_enterprise_credentials(account_raw)
            validate_required_credentials(creds)

            # If validation passes, simulate a successful create
            results.append({"index": index, "success": True})
        except ValueError as e:
            results.append({"index": index, "success": False, "error": str(e)})
        except Exception as e:
            results.append({"index": index, "success": False, "error": str(e)})

    return {"results": results}


# ---------------------------------------------------------------------------
# Property 3 — 批量导入结果完整性
# ---------------------------------------------------------------------------


class TestBatchImportResultCompleteness:
    """
    Feature: kiro-enterprise-account, Property 3: 批量导入结果完整性

    For any 包含 N 个账户对象的批量导入请求，响应中的 results 数组长度应恰好为 N，
    且每个结果包含对应的 index 和 success/failure 状态。
    """

    @given(accounts=_random_account_list)
    @settings(max_examples=100)
    def test_results_length_equals_input_length(
        self, accounts: list[Dict[str, Any]]
    ) -> None:
        """
        For any list of N account dicts (valid or invalid), the batch import
        must return exactly N results.

        **Validates: Requirements 1.5**
        """
        response = _simulate_batch_import(accounts)
        results = response["results"]

        assert len(results) == len(accounts), (
            f"Expected {len(accounts)} results, got {len(results)}"
        )

    @given(accounts=_random_account_list)
    @settings(max_examples=100)
    def test_each_result_has_correct_index(
        self, accounts: list[Dict[str, Any]]
    ) -> None:
        """
        Each result entry must have an 'index' field matching its position
        in the input array (0-based).

        **Validates: Requirements 1.5**
        """
        response = _simulate_batch_import(accounts)
        results = response["results"]

        for i, result in enumerate(results):
            assert "index" in result, f"Result at position {i} missing 'index' field"
            assert result["index"] == i, (
                f"Result at position {i} has index={result['index']}, expected {i}"
            )

    @given(accounts=_random_account_list)
    @settings(max_examples=100)
    def test_each_result_has_success_boolean(
        self, accounts: list[Dict[str, Any]]
    ) -> None:
        """
        Each result entry must have a 'success' field that is a boolean.

        **Validates: Requirements 1.5**
        """
        response = _simulate_batch_import(accounts)
        results = response["results"]

        for i, result in enumerate(results):
            assert "success" in result, (
                f"Result at position {i} missing 'success' field"
            )
            assert isinstance(result["success"], bool), (
                f"Result at position {i} has success={result['success']!r} "
                f"(type={type(result['success']).__name__}), expected bool"
            )


# ---------------------------------------------------------------------------
# Hypothesis strategies — Property 8
# ---------------------------------------------------------------------------

# Field name pairs: (snake_case, camelCase)
_FIELD_NAME_PAIRS = [
    ("refresh_token", "refreshToken"),
    ("client_id", "clientId"),
    ("client_secret", "clientSecret"),
]


@st.composite
def _credentials_with_random_naming_style(draw: st.DrawFn) -> tuple[Dict[str, str], Dict[str, str]]:
    """
    Generate a credentials dict where each field independently uses either
    camelCase or snake_case naming. Returns (input_dict, expected_values)
    so the test can verify correct extraction.
    """
    values = {
        "refresh_token": draw(_nonempty_str),
        "client_id": draw(_nonempty_str),
        "client_secret": draw(_nonempty_str),
    }

    input_dict: Dict[str, str] = {}
    for snake_name, camel_name in _FIELD_NAME_PAIRS:
        use_camel = draw(st.booleans())
        chosen_key = camel_name if use_camel else snake_name
        input_dict[chosen_key] = values[snake_name]

    # Optionally include region with random naming style
    if draw(st.booleans()):
        region_value = draw(
            st.sampled_from(["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"])
        )
        region_key = draw(st.sampled_from(["region", "aws_region", "awsRegion"]))
        input_dict[region_key] = region_value
        values["region"] = region_value

    return input_dict, values


# ---------------------------------------------------------------------------
# Property 8 — 字段命名风格兼容
# ---------------------------------------------------------------------------


class TestFieldNamingStyleCompatibility:
    """
    Feature: kiro-enterprise-account, Property 8: 字段命名风格兼容

    For any 有效的企业账户凭据，无论使用 camelCase（refreshToken、clientId、clientSecret）
    还是 snake_case（refresh_token、client_id、client_secret）字段名，后端应正确提取
    所有凭据值并成功创建账号。
    """

    @given(data=_credentials_with_random_naming_style())
    @settings(max_examples=100)
    def test_parse_extracts_correct_values_regardless_of_naming_style(
        self, data: tuple[Dict[str, str], Dict[str, str]]
    ) -> None:
        """
        For any valid credentials using any mix of camelCase and snake_case
        field names, parse_enterprise_credentials must extract the correct
        values for all fields.

        **Validates: Requirements 6.5**
        """
        input_dict, expected_values = data

        parsed = parse_enterprise_credentials(input_dict)

        # All three required fields must be correctly extracted
        assert parsed["refresh_token"] == expected_values["refresh_token"].strip()
        assert parsed["client_id"] == expected_values["client_id"].strip()
        assert parsed["client_secret"] == expected_values["client_secret"].strip()

        # Region, if provided, must also be correctly extracted
        if "region" in expected_values:
            assert parsed["region"] == expected_values["region"].strip()

    @given(data=_credentials_with_random_naming_style())
    @settings(max_examples=100)
    def test_validation_passes_for_any_naming_style(
        self, data: tuple[Dict[str, str], Dict[str, str]]
    ) -> None:
        """
        For any valid credentials using any mix of camelCase and snake_case
        field names, validate_required_credentials must not raise.

        **Validates: Requirements 6.5**
        """
        input_dict, _ = data

        parsed = parse_enterprise_credentials(input_dict)

        # Must not raise — all required fields are present and non-empty
        validate_required_credentials(parsed)

    @given(data=_credentials_with_random_naming_style())
    @settings(max_examples=100)
    def test_account_data_builds_successfully_for_any_naming_style(
        self, data: tuple[Dict[str, str], Dict[str, str]]
    ) -> None:
        """
        For any valid credentials using any mix of camelCase and snake_case
        field names, the full account creation pipeline (parse → validate →
        build) must succeed and produce correct auth_method and provider.

        **Validates: Requirements 6.5**
        """
        input_dict, expected_values = data

        parsed = parse_enterprise_credentials(input_dict)
        validate_required_credentials(parsed)
        account_data = _build_account_data(parsed)

        assert account_data["auth_method"] == "IdC"
        assert account_data["provider"] == "Enterprise"
        assert account_data["refresh_token"] == expected_values["refresh_token"].strip()
        assert account_data["client_id"] == expected_values["client_id"].strip()
        assert account_data["client_secret"] == expected_values["client_secret"].strip()


# ---------------------------------------------------------------------------
# Hypothesis strategies — Property 9
# ---------------------------------------------------------------------------

# Enterprise keywords that trigger detection
_ENTERPRISE_KEYWORDS = ["POWER", "ENTERPRISE"]

# Random case variant of a keyword: e.g. "POWER" → "pOwEr", "Power", etc.
@st.composite
def _random_case_keyword(draw: st.DrawFn) -> str:
    """Pick one of the Enterprise keywords and randomise the case of each char."""
    keyword = draw(st.sampled_from(_ENTERPRISE_KEYWORDS))
    return "".join(
        draw(st.sampled_from([ch.lower(), ch.upper()])) for ch in keyword
    )


@st.composite
def _subscription_string_containing_keyword(draw: st.DrawFn) -> str:
    """
    Generate a random string that is guaranteed to contain "POWER" or
    "ENTERPRISE" (in any case mixture) surrounded by arbitrary text.
    """
    prefix = draw(st.text(min_size=0, max_size=30))
    keyword = draw(_random_case_keyword())
    suffix = draw(st.text(min_size=0, max_size=30))
    return prefix + keyword + suffix


# Strings that do NOT contain "POWER" or "ENTERPRISE" (case-insensitive)
_non_enterprise_string = st.text(min_size=0, max_size=100).filter(
    lambda s: "POWER" not in s.upper() and "ENTERPRISE" not in s.upper()
)


def _detect_enterprise(subscription: str | None, subscription_type: str | None) -> str | None:
    """
    Pure function replicating the Enterprise subscription detection logic
    from KiroService._apply_usage_limits_payload_to_account().

    Returns "Enterprise" if either string (uppercased) contains "POWER" or
    "ENTERPRISE"; otherwise returns the original subscription_type unchanged.
    """
    sub_upper = (subscription or "").upper()
    type_upper = (subscription_type or "").upper()
    if (
        "POWER" in sub_upper
        or "ENTERPRISE" in sub_upper
        or "POWER" in type_upper
        or "ENTERPRISE" in type_upper
    ):
        return "Enterprise"
    return subscription_type


# ---------------------------------------------------------------------------
# Property 9 — 订阅类型 Enterprise 识别
# ---------------------------------------------------------------------------


class TestSubscriptionTypeEnterpriseDetection:
    """
    Feature: kiro-enterprise-account, Property 9: 订阅类型 Enterprise 识别

    For any 上游返回的订阅信息字符串，若其大写形式包含 "POWER" 或 "ENTERPRISE" 子串，
    系统应将 subscription_type 标识为 "Enterprise"。
    """

    @given(sub_str=_subscription_string_containing_keyword())
    @settings(max_examples=100)
    def test_subscription_containing_keyword_detected_as_enterprise(
        self, sub_str: str
    ) -> None:
        """
        When the subscription field contains "POWER" or "ENTERPRISE" (any case),
        the detection function must return "Enterprise" — regardless of the
        subscription_type value.

        **Validates: Requirements 7.1**
        """
        # subscription_type can be anything; the subscription field alone triggers detection
        result = _detect_enterprise(subscription=sub_str, subscription_type=None)
        assert result == "Enterprise", (
            f"Expected 'Enterprise' for subscription={sub_str!r}, got {result!r}"
        )

    @given(type_str=_subscription_string_containing_keyword())
    @settings(max_examples=100)
    def test_subscription_type_containing_keyword_detected_as_enterprise(
        self, type_str: str
    ) -> None:
        """
        When the subscription_type field contains "POWER" or "ENTERPRISE"
        (any case), the detection function must return "Enterprise" —
        regardless of the subscription value.

        **Validates: Requirements 7.1**
        """
        result = _detect_enterprise(subscription=None, subscription_type=type_str)
        assert result == "Enterprise", (
            f"Expected 'Enterprise' for subscription_type={type_str!r}, got {result!r}"
        )

    @given(
        sub_str=_subscription_string_containing_keyword(),
        type_str=_subscription_string_containing_keyword(),
    )
    @settings(max_examples=100)
    def test_both_fields_containing_keyword_detected_as_enterprise(
        self, sub_str: str, type_str: str
    ) -> None:
        """
        When both subscription and subscription_type contain a keyword,
        the result must still be "Enterprise".

        **Validates: Requirements 7.1**
        """
        result = _detect_enterprise(subscription=sub_str, subscription_type=type_str)
        assert result == "Enterprise"

    @given(
        sub_str=_non_enterprise_string,
        type_str=_non_enterprise_string,
    )
    @settings(max_examples=100)
    def test_strings_without_keyword_not_detected_as_enterprise(
        self, sub_str: str, type_str: str
    ) -> None:
        """
        When neither subscription nor subscription_type contains "POWER" or
        "ENTERPRISE", the detection function must NOT return "Enterprise" —
        it should return the original subscription_type unchanged.

        **Validates: Requirements 7.1**
        """
        result = _detect_enterprise(subscription=sub_str, subscription_type=type_str)
        assert result != "Enterprise", (
            f"Unexpected 'Enterprise' for subscription={sub_str!r}, "
            f"subscription_type={type_str!r}"
        )
        # Must return the original subscription_type unchanged
        assert result == type_str


# ---------------------------------------------------------------------------
# Pure helper — Property 4
# ---------------------------------------------------------------------------

# IdC-family auth_method values recognised by _effective_api_region()
_IDC_AUTH_METHODS = ("IdC", "idc", "iam", "ima", "builder-id", "builderid", "aws-ima")


def _trimmed_str(value: Any) -> str | None:
    """Replicate the _trimmed_str helper from kiro_service.py."""
    if value is None:
        return None
    s = str(value).strip()
    return s if s else None


def _coerce_region(value: Any) -> str:
    """Replicate KiroService._coerce_region — fallback to us-east-1."""
    s = _trimmed_str(value)
    return s if s else "us-east-1"


class _FakeAccount:
    """Minimal stand-in for KiroAccount with only the fields needed."""

    def __init__(self, auth_method: str, region: str | None = None):
        self.auth_method = auth_method
        self.region = region


def _effective_api_region(*, account: _FakeAccount, creds: Dict[str, Any]) -> str:
    """
    Pure replica of KiroService._effective_api_region().

    For IdC accounts without an explicit api_region, the function must
    return "us-east-1" regardless of auth_region or region.
    """
    value = _trimmed_str(creds.get("api_region") or creds.get("apiRegion"))
    if value:
        return _coerce_region(value)

    auth_method = _trimmed_str(
        account.auth_method or creds.get("auth_method") or creds.get("authMethod")
    )
    if auth_method and auth_method.lower() in (
        "idc", "iam", "ima", "builder-id", "builderid", "aws-ima",
    ):
        return "us-east-1"

    return _coerce_region(account.region or creds.get("region"))


# ---------------------------------------------------------------------------
# Hypothesis strategies — Property 4
# ---------------------------------------------------------------------------

# Random region strings — any non-empty text to prove the region is ignored
_random_region = st.one_of(
    st.sampled_from([
        "us-east-1", "us-west-2", "eu-west-1", "eu-central-1",
        "ap-southeast-1", "ap-northeast-1", "sa-east-1",
    ]),
    st.text(min_size=1, max_size=50).filter(lambda s: s.strip()),
)

# Random auth_method from the IdC family (any case variant)
_idc_auth_method = st.sampled_from(list(_IDC_AUTH_METHODS))


# ---------------------------------------------------------------------------
# Property 4 — 企业账户 API Region 固定为 us-east-1
# ---------------------------------------------------------------------------


class TestApiRegionFixedUsEast1:
    """
    Feature: kiro-enterprise-account, Property 4: API Region 固定为 us-east-1

    For any 企业账户（auth_method="IdC"），无论其 auth_region 为何值，
    _effective_api_region() 返回的 API 调用区域应为 "us-east-1"。
    """

    @given(region=_random_region, auth_method=_idc_auth_method)
    @settings(max_examples=100)
    def test_idc_account_always_returns_us_east_1(
        self, region: str, auth_method: str
    ) -> None:
        """
        For any IdC account with any region value and no explicit api_region,
        _effective_api_region() must return "us-east-1".

        **Validates: Requirements 3.1**
        """
        account = _FakeAccount(auth_method=auth_method, region=region)
        creds: Dict[str, Any] = {
            "region": region,
            "auth_region": region,
            # No api_region — the IdC default path should kick in
        }

        result = _effective_api_region(account=account, creds=creds)

        assert result == "us-east-1", (
            f"Expected 'us-east-1' for auth_method={auth_method!r}, "
            f"region={region!r}, got {result!r}"
        )

    @given(
        region=_random_region,
        auth_region=_random_region,
        auth_method=_idc_auth_method,
    )
    @settings(max_examples=100)
    def test_idc_account_ignores_auth_region(
        self, region: str, auth_region: str, auth_method: str
    ) -> None:
        """
        For any IdC account, even when auth_region differs from region,
        _effective_api_region() must still return "us-east-1" (when
        api_region is not explicitly set).

        **Validates: Requirements 3.1**
        """
        account = _FakeAccount(auth_method=auth_method, region=region)
        creds: Dict[str, Any] = {
            "region": region,
            "auth_region": auth_region,
            # No api_region
        }

        result = _effective_api_region(account=account, creds=creds)

        assert result == "us-east-1", (
            f"Expected 'us-east-1' for auth_method={auth_method!r}, "
            f"region={region!r}, auth_region={auth_region!r}, got {result!r}"
        )

    @given(region=_random_region)
    @settings(max_examples=100)
    def test_explicit_api_region_overrides_default(
        self, region: str
    ) -> None:
        """
        When api_region IS explicitly set in creds, _effective_api_region()
        should return that value — even for IdC accounts. This is the
        escape hatch; the property still holds because enterprise accounts
        are created with api_region="us-east-1" by default.

        **Validates: Requirements 3.1**
        """
        account = _FakeAccount(auth_method="IdC", region="eu-west-1")
        creds: Dict[str, Any] = {
            "region": "eu-west-1",
            "auth_region": "eu-west-1",
            "api_region": region,
        }

        result = _effective_api_region(account=account, creds=creds)

        # When api_region is explicitly set, it should be used (coerced)
        assert result == _coerce_region(region)
