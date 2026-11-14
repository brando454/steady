"""Install App Store profiles for manual signing. Never creates certificates."""

from __future__ import annotations

import base64
import json
import os
import plistlib
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

APP_BUNDLE = "com.brando454.steady"
WIDGET_BUNDLE = "com.brando454.steady.widget"
APP_GROUP = "group.com.brando454.steady"
DISTRIBUTION_TYPES = {"DISTRIBUTION", "IOS_DISTRIBUTION"}
API = "https://api.appstoreconnect.apple.com"


@dataclass(frozen=True)
class ProfileChoice:
    name: str
    expiration: str
    content_b64: str
    uuid: str
    bundle_id: str


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def der_to_raw(der: bytes) -> bytes:
    """Turn an ASN.1 ECDSA signature into the 64-byte form a JWT needs."""
    if len(der) < 8 or der[0] != 0x30:
        raise ValueError("bad signature")
    index = 2

    def read_int(pos: int) -> tuple[bytes, int]:
        if der[pos] != 0x02:
            raise ValueError("bad signature")
        length = der[pos + 1]
        pos += 2
        value = der[pos : pos + length].lstrip(b"\x00") or b"\x00"
        if len(value) > 32:
            raise ValueError("bad signature")
        return value.rjust(32, b"\x00"), pos + length

    first, index = read_int(index)
    second, _index = read_int(index)
    return first + second


def redact(text: str) -> str:
    text = re.sub(r"[A-Za-z0-9+/=_-]{40,}", "[redacted]", text)
    return text[:400]


def sign_jwt(key_path: str, key_id: str, issuer_id: str, now: int | None = None) -> str:
    issued = int(time.time()) if now is None else now
    header = b64url(json.dumps({"alg": "ES256", "kid": key_id, "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(
        json.dumps(
            {"iss": issuer_id, "iat": issued, "exp": issued + 600, "aud": "appstoreconnect-v1"},
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{payload}".encode()
    der = subprocess.check_output(["openssl", "dgst", "-sha256", "-sign", key_path], input=signing_input)
    return f"{header}.{payload}.{b64url(der_to_raw(der))}"


def distribution_names(subject: str) -> bool:
    return ("Apple Distribution" in subject or "iPhone Distribution" in subject) and "Development" not in subject


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def consider_profile(
    *,
    profile_type: str,
    state: str,
    expiration: str,
    bundle_id: str,
    wanted_bundle: str,
    certificate_ids: set[str],
    wanted_certs: set[str],
    groups: list[str],
    now: datetime,
) -> bool:
    if profile_type != "IOS_APP_STORE" or state != "ACTIVE":
        return False
    try:
        expires = parse_time(expiration)
    except ValueError:
        return False
    if expires <= now:
        return False
    if bundle_id != wanted_bundle:
        return False
    if not certificate_ids.intersection(wanted_certs):
        return False
    return APP_GROUP in groups


def select_profile(choices: list[ProfileChoice]) -> ProfileChoice | None:
    if not choices:
        return None
    return max(choices, key=lambda item: parse_time(item.expiration))


def upsert_setting(settings: str, key: str, value: str) -> str:
    pattern = re.compile(rf"^(\s*){re.escape(key)} = .*;$", re.M)

    def replace(match: re.Match[str]) -> str:
        return f"{match.group(1)}{key} = {value};"

    if pattern.search(settings):
        return pattern.sub(replace, settings, count=1)
    return settings.replace("buildSettings = {", "buildSettings = {\n\t\t\t\t" + f"{key} = {value};", 1)


def patch_pbxproj(text: str, profiles: dict[str, str], team: str) -> str:
    """Point the Release configs for the app and widget at the named profiles."""

    def replace(match: re.Match[str]) -> str:
        block = match.group(0)
        if re.search(r"name = Release;", block) is None:
            return block
        bundle = re.search(r"PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);", block)
        if bundle is None:
            return block
        bundle_id = bundle.group(1).strip().strip('"')
        profile = profiles.get(bundle_id)
        if profile is None:
            return block
        updated = upsert_setting(block, "CODE_SIGN_STYLE", "Manual")
        updated = upsert_setting(updated, "CODE_SIGN_IDENTITY", '"Apple Distribution"')
        updated = upsert_setting(updated, "DEVELOPMENT_TEAM", team)
        updated = upsert_setting(updated, "PROVISIONING_PROFILE_SPECIFIER", json.dumps(profile))
        return updated

    return re.sub(r"isa = XCBuildConfiguration;.*?name = (?:Debug|Release);", replace, text, flags=re.S)


def decode_profile(content_b64: str) -> dict:
    raw = base64.b64decode(content_b64)
    with tempfile.NamedTemporaryFile(delete=False) as handle:
        handle.write(raw)
        path = handle.name
    try:
        plist = subprocess.check_output(["security", "cms", "-D", "-i", path])
    finally:
        os.unlink(path)
    decoded = plistlib.loads(plist)
    if not isinstance(decoded, dict):
        raise ValueError("profile")
    return decoded


def install_profile(content_b64: str, uuid: str) -> None:
    folder = Path.home() / "Library" / "MobileDevice" / "Provisioning Profiles"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{uuid}.mobileprovision").write_bytes(base64.b64decode(content_b64))


def export_options(team: str, profiles: dict[str, str]) -> str:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "<key>method</key><string>app-store-connect</string>",
        "<key>signingStyle</key><string>manual</string>",
        "<key>signingCertificate</key><string>Apple Distribution</string>",
        "<key>teamID</key><string>" + team + "</string>",
        "<key>uploadSymbols</key><true/>",
        "<key>provisioningProfiles</key>",
        "<dict>",
    ]
    for bundle_id, name in profiles.items():
        lines.append(f"<key>{bundle_id}</key><string>{_xml(name)}</string>")
    lines.extend(["</dict>", "</dict>", "</plist>", ""])
    return "\n".join(lines)


def _xml(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _api(token: str, method: str, path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = redact(error.read().decode("utf-8", "replace"))
        raise SystemExit(f"App Store Connect {method} {path} failed ({error.code}): {detail}") from None


def _pages(token: str, path: str) -> list[dict]:
    items: list[dict] = []
    included: list[dict] = []
    while path:
        page = _api(token, "GET", path)
        items.extend(page.get("data", []))
        included.extend(page.get("included", []))
        path = (page.get("links") or {}).get("next") or ""
        if path.startswith(API):
            path = path[len(API) :]
    return [{"data": items, "included": included}]


def local_distribution_ders(keychain: str) -> list[bytes]:
    pem_blob = subprocess.check_output(["security", "find-certificate", "-a", "-p", keychain])
    ders: list[bytes] = []
    for match in re.finditer(b"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", pem_blob, re.S):
        pem = b"-----BEGIN CERTIFICATE-----" + match.group(1) + b"-----END CERTIFICATE-----"
        subject = subprocess.check_output(["openssl", "x509", "-noout", "-subject"], input=pem).decode()
        if not distribution_names(subject):
            continue
        ders.append(base64.b64decode(re.sub(rb"-----[^-]+-----|\s+", b"", pem)))
    if not ders:
        raise SystemExit("The keychain has no Apple Distribution certificate. No certificate was created.")
    return ders


def matching_certificate_ids(token: str, ders: list[bytes]) -> list[str]:
    wanted = set(ders)
    found: list[str] = []
    for page in _pages(token, "/v1/certificates?limit=200"):
        for cert in page["data"]:
            attributes = cert.get("attributes") or {}
            if attributes.get("certificateType") not in DISTRIBUTION_TYPES:
                continue
            content = attributes.get("certificateContent") or ""
            try:
                der = base64.b64decode(content)
            except ValueError:
                continue
            if der in wanted:
                found.append(cert["id"])
    if not found:
        raise SystemExit("No App Store Connect distribution certificate matches the p12. No certificate was created.")
    return found


def _bundle_map(included: list[dict]) -> dict[str, str]:
    return {
        item["id"]: (item.get("attributes") or {}).get("identifier", "")
        for item in included
        if item.get("type") == "bundleIds"
    }


def existing_profile(token: str, bundle_id: str, cert_ids: set[str], now: datetime) -> ProfileChoice | None:
    choices: list[ProfileChoice] = []
    for page in _pages(token, "/v1/profiles?filter[profileType]=IOS_APP_STORE&include=bundleId,certificates&limit=200"):
        bundles = _bundle_map(page["included"])
        for profile in page["data"]:
            attributes = profile.get("attributes") or {}
            relationships = profile.get("relationships") or {}
            bundle_ref = ((relationships.get("bundleId") or {}).get("data") or {}).get("id", "")
            linked = {
                item["id"]
                for item in ((relationships.get("certificates") or {}).get("data") or [])
                if isinstance(item, dict) and item.get("id")
            }
            content = attributes.get("profileContent") or ""
            try:
                decoded = decode_profile(content) if content else {}
            except (subprocess.CalledProcessError, ValueError, plistlib.InvalidFileException):
                continue
            groups = list((decoded.get("Entitlements") or {}).get("com.apple.security.application-groups") or [])
            if not consider_profile(
                profile_type=attributes.get("profileType", ""),
                state=attributes.get("profileState", ""),
                expiration=attributes.get("expirationDate", ""),
                bundle_id=bundles.get(bundle_ref, ""),
                wanted_bundle=bundle_id,
                certificate_ids=linked,
                wanted_certs=cert_ids,
                groups=groups,
                now=now,
            ):
                continue
            choices.append(
                ProfileChoice(
                    name=attributes.get("name") or decoded.get("Name") or "",
                    expiration=attributes.get("expirationDate", ""),
                    content_b64=content,
                    uuid=str(decoded.get("UUID") or ""),
                    bundle_id=bundle_id,
                )
            )
    return select_profile(choices)


def _bundle_resource(token: str, bundle_id: str) -> dict:
    found = _api(token, "GET", f"/v1/bundleIds?filter[identifier]={urllib.request.quote(bundle_id)}&include=bundleIdCapabilities&limit=5")
    for item in found.get("data", []):
        if (item.get("attributes") or {}).get("identifier") == bundle_id:
            return item
    raise SystemExit(f"No bundle id {bundle_id} is registered. No certificate was created.")


def _ensure_app_group(token: str, bundle: dict) -> None:
    capabilities = _api(token, "GET", f"/v1/bundleIds/{bundle['id']}/bundleIdCapabilities?limit=50")
    for item in capabilities.get("data", []):
        if (item.get("attributes") or {}).get("capabilityType") == "APP_GROUPS":
            return
    _api(
        token,
        "POST",
        "/v1/bundleIdCapabilities",
        {
            "data": {
                "type": "bundleIdCapabilities",
                "attributes": {"capabilityType": "APP_GROUPS"},
                "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": bundle["id"]}}},
            }
        },
    )


def create_profile(token: str, bundle_id: str, cert_ids: list[str]) -> ProfileChoice:
    bundle = _bundle_resource(token, bundle_id)
    _ensure_app_group(token, bundle)
    stamp = time.strftime("%Y%m%d%H%M%S", time.gmtime())
    name = f"Steady App Store {stamp}" if bundle_id == APP_BUNDLE else f"Steady Widget App Store {stamp}"
    created = _api(
        token,
        "POST",
        "/v1/profiles",
        {
            "data": {
                "type": "profiles",
                "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
                "relationships": {
                    "bundleId": {"data": {"type": "bundleIds", "id": bundle["id"]}},
                    "certificates": {"data": [{"type": "certificates", "id": cert_id} for cert_id in cert_ids]},
                },
            }
        },
    )
    attributes = (created.get("data") or {}).get("attributes") or {}
    content = attributes.get("profileContent") or ""
    decoded = decode_profile(content)
    groups = list((decoded.get("Entitlements") or {}).get("com.apple.security.application-groups") or [])
    if APP_GROUP not in groups:
        raise SystemExit(f"The new profile for {bundle_id} does not include {APP_GROUP}. No certificate was created.")
    return ProfileChoice(
        name=attributes.get("name") or name,
        expiration=attributes.get("expirationDate", ""),
        content_b64=content,
        uuid=str(decoded.get("UUID") or ""),
        bundle_id=bundle_id,
    )


def profile_for(token: str, bundle_id: str, cert_ids: list[str], now: datetime) -> ProfileChoice:
    found = existing_profile(token, bundle_id, set(cert_ids), now)
    if found is not None:
        print(f"Using existing App Store profile for {bundle_id}")
        return found
    print(f"No matching App Store profile for {bundle_id}; creating one")
    return create_profile(token, bundle_id, cert_ids)


def main() -> None:
    keychain = os.environ["SIGNING_KEYCHAIN"]
    team = os.environ["APPLE_TEAM_ID"].strip()
    if not re.fullmatch(r"[A-Za-z0-9]+", team):
        raise SystemExit("APPLE_TEAM_ID is not a team id. No certificate was created.")
    key_path = os.environ["ASC_KEY_PATH"]
    token = sign_jwt(key_path, os.environ["APP_STORE_CONNECT_KEY_ID"].strip(), os.environ["APP_STORE_CONNECT_ISSUER_ID"].strip())
    cert_ids = matching_certificate_ids(token, local_distribution_ders(keychain))
    now = datetime.now(timezone.utc)
    chosen = {bundle: profile_for(token, bundle, cert_ids, now) for bundle in (APP_BUNDLE, WIDGET_BUNDLE)}
    names = {bundle: profile.name for bundle, profile in chosen.items()}
    for profile in chosen.values():
        if not profile.uuid or not profile.content_b64:
            raise SystemExit(f"Profile {profile.name} has no payload. No certificate was created.")
        install_profile(profile.content_b64, profile.uuid)
    pbxproj = Path(os.environ["PBXPROJ"])
    pbxproj.write_text(patch_pbxproj(pbxproj.read_text(), names, team))
    Path(os.environ["EXPORT_PLIST"]).write_text(export_options(team, names))
    print("Manual signing is ready for the app and the widget")
