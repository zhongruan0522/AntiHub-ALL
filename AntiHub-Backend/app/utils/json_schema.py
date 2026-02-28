from __future__ import annotations

from typing import Any, Dict, List


def normalize_json_schema(schema: Any) -> Dict[str, Any]:
    """
    Normalize a JSON-Schema-ish dict into a strict, upstream-friendly shape.

    Motivation:
    - Some clients/gateways occasionally emit invalid values like:
      - `required: null`
      - `properties: null`
      - missing/empty `type`
      - invalid `additionalProperties`
    - Strict upstreams (e.g. Kiro) may reject such payloads with 400.
    """

    if not isinstance(schema, dict):
        return {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": True,
        }

    out: Dict[str, Any] = dict(schema)

    # type: must be a non-empty string
    schema_type = out.get("type")
    if not isinstance(schema_type, str) or not schema_type.strip():
        out["type"] = "object"

    # properties: must be an object
    if not isinstance(out.get("properties"), dict):
        out["properties"] = {}

    # required: must be an array of strings
    required_raw = out.get("required")
    if isinstance(required_raw, list):
        cleaned: List[str] = []
        for item in required_raw:
            if isinstance(item, str) and item.strip():
                cleaned.append(item)
        out["required"] = cleaned
    else:
        out["required"] = []

    # additionalProperties: allow bool or object; otherwise default to true
    additional = out.get("additionalProperties")
    if not isinstance(additional, (bool, dict)):
        out["additionalProperties"] = True

    return out

