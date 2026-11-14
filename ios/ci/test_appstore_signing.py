import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from appstore_signing import (
    APP_GROUP,
    ProfileChoice,
    consider_profile,
    der_to_raw,
    distribution_names,
    patch_pbxproj,
    select_profile,
)


NOW = datetime(2026, 11, 14, 22, 0, tzinfo=timezone.utc)


def consider(**overrides: object) -> bool:
    values = {
        "profile_type": "IOS_APP_STORE",
        "state": "ACTIVE",
        "expiration": "2027-01-01T00:00:00Z",
        "bundle_id": "com.brando454.steady",
        "wanted_bundle": "com.brando454.steady",
        "certificate_ids": {"DIST"},
        "wanted_certs": {"DIST"},
        "groups": [APP_GROUP],
        "now": NOW,
    }
    values.update(overrides)
    return consider_profile(**values)  # type: ignore[arg-type]


class SigningTests(unittest.TestCase):
    def test_script_runs_main(self) -> None:
        source = Path(__file__).with_name("appstore_signing.py").read_text()
        self.assertIn('if __name__ == "__main__":\n    main()', source)

    def test_der_signature_becomes_raw_rs(self) -> None:
        first = bytes([0x11]) * 32
        second = bytes([0x22]) * 32

        def encode(value: bytes) -> bytes:
            if value[0] & 0x80:
                value = b"\x00" + value
            return bytes([0x02, len(value)]) + value

        body = encode(first) + encode(second)
        self.assertEqual(der_to_raw(bytes([0x30, len(body)]) + body), first + second)

    def test_distribution_subject_rejects_development(self) -> None:
        self.assertTrue(distribution_names("subject=CN=Apple Distribution: Brandon (TEAM)"))
        self.assertFalse(distribution_names("subject=CN=Apple Development: Brandon (TEAM)"))

    def test_profile_must_match_bundle_cert_and_app_group(self) -> None:
        self.assertTrue(consider())
        self.assertFalse(consider(profile_type="IOS_APP_DEVELOPMENT"))
        self.assertFalse(consider(state="INVALID"))
        self.assertFalse(consider(expiration="2020-01-01T00:00:00Z"))
        self.assertFalse(consider(bundle_id="com.brando454.steady.widget"))
        self.assertFalse(consider(certificate_ids={"OTHER"}))
        self.assertFalse(consider(groups=[]))

    def test_latest_profile_wins(self) -> None:
        early = ProfileChoice("old", "2026-12-01T00:00:00Z", "", "1", "com.brando454.steady")
        late = ProfileChoice("new", "2027-06-01T00:00:00Z", "", "2", "com.brando454.steady")
        self.assertEqual(select_profile([early, late]), late)
        self.assertIsNone(select_profile([]))

    def test_release_configs_get_separate_profiles(self) -> None:
        project = """
		APP111 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				PRODUCT_BUNDLE_IDENTIFIER = com.brando454.steady;
			};
			name = Release;
		};
		APP222 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				PRODUCT_BUNDLE_IDENTIFIER = com.brando454.steady;
			};
			name = Debug;
		};
		WID111 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				PRODUCT_BUNDLE_IDENTIFIER = com.brando454.steady.widget;
			};
			name = Release;
		};
"""
        patched = patch_pbxproj(
            project,
            {
                "com.brando454.steady": "Steady App Store",
                "com.brando454.steady.widget": "Steady Widget App Store",
            },
            "TEAM123456",
        )
        self.assertEqual(patched.count("CODE_SIGN_STYLE = Manual;"), 2)
        self.assertEqual(patched.count("CODE_SIGN_STYLE = Automatic;"), 1)
        self.assertEqual(patched.count('PROVISIONING_PROFILE_SPECIFIER = "Steady App Store";'), 1)
        self.assertEqual(patched.count('PROVISIONING_PROFILE_SPECIFIER = "Steady Widget App Store";'), 1)
        self.assertEqual(patched.count("DEVELOPMENT_TEAM = TEAM123456;"), 2)
        self.assertIn('CODE_SIGN_IDENTITY = "Apple Distribution";', patched)


if __name__ == "__main__":
    unittest.main()
