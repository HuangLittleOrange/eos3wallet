import base64
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("github_ios", Path(__file__).resolve().parents[1] / "github-ios.py")
ios = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ios)

ENV = {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main",
       "GITHUB_SERVER_URL": "https://github.com", "GITHUB_SHA": "a" * 40, "GITHUB_REPOSITORY": "example/wallet",
       "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "IOS_BUILD_NUMBER": "27"}
NOW = datetime.datetime(2026, 10, 20, tzinfo=datetime.timezone.utc)
TEAM = "ABCD123456"


def profile():
    return {"UUID": "12345678-1234-1234-1234-123456789ABC", "TeamIdentifier": [TEAM],
            "ExpirationDate": NOW + datetime.timedelta(days=30), "Entitlements": {
                "application-identifier": f"{TEAM}.{ios.BUNDLE_ID}", "com.apple.developer.team-identifier": TEAM,
                "beta-reports-active": True, "get-task-allow": False,
                "com.apple.developer.associated-domains": ["*"]}}


class IosReleasePolicy(unittest.TestCase):
    def test_context_rejects_untrusted_refs_and_injected_build_numbers(self):
        self.assertEqual(ios.context(ENV)["IOS_BUILD_NUMBER"], "27")
        for name, value in [("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF", "refs/heads/topic"),
                            ("GITHUB_REF", "refs/tags/v1.0.9"), ("GITHUB_SHA", "main"),
                            ("GITHUB_RUN_ATTEMPT", ""), ("GITHUB_REPOSITORY", "example/wallet\nother"),
                            ("IOS_BUILD_NUMBER", "0"), ("IOS_BUILD_NUMBER", "01"),
                            ("IOS_BUILD_NUMBER", "1; echo injected"), ("IOS_BUILD_NUMBER", "1.2")]:
            with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                ios.context({**ENV, name: value})

    def test_distribution_profile_must_match_team_app_capability_and_expiration(self):
        ios.validate_profile(profile(), TEAM, NOW)
        for field, value in [("TeamIdentifier", ["OTHER12345"]), ("ProvisionedDevices", ["udid"]),
                             ("ProvisionedDevices", []), ("ProvisionsAllDevices", True),
                             ("ExpirationDate", NOW - datetime.timedelta(seconds=1)), ("UUID", "../../profile")]:
            changed = profile()
            changed[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                ios.validate_profile(changed, TEAM, NOW)
        for field, value in [("application-identifier", f"{TEAM}.other.app"), ("get-task-allow", True),
                             ("beta-reports-active", False), ("com.apple.developer.associated-domains", [])]:
            changed = profile()
            changed["Entitlements"][field] = value
            with self.subTest(entitlement=field), self.assertRaises(ValueError):
                ios.validate_profile(changed, TEAM, NOW)

    def test_artifact_tampering_and_cross_run_replay_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="eos3-ios-policy-") as temp, patch.dict(os.environ, ENV):
            folder = Path(temp)
            info = {**ios.context(), "version": "1.0.9", "bundleId": ios.BUNDLE_ID}
            payload = folder / "wallet.ipa"
            payload.write_bytes(b"fixture")
            (folder / "build-info.json").write_text(json.dumps(info))
            names = ["wallet.ipa", "build-info.json"]
            ios.checksums(folder, names)
            self.assertEqual(ios.metadata(folder, names), info)
            payload.write_bytes(b"replacement")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                ios.metadata(folder, names)
            ios.checksums(folder, names)
            with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}), self.assertRaisesRegex(ValueError, "another"):
                ios.metadata(folder, names)
            payload.unlink()
            payload.symlink_to(folder / "build-info.json")
            with self.assertRaisesRegex(ValueError, "regular"):
                ios.checksums(folder, names)

    def test_extraction_rejects_traversal_links_and_duplicate_entries(self):
        with tempfile.TemporaryDirectory(prefix="eos3-ios-tar-") as temp:
            folder = Path(temp)
            for name, kind in [("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                               ("Wallet.xcarchive/link", tarfile.SYMTYPE),
                               ("Wallet.xcarchive/link", tarfile.LNKTYPE), ("Wallet.xcarchive/device", tarfile.CHRTYPE)]:
                file = folder / "bad.tar.gz"
                with tarfile.open(file, "w:gz") as archive:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = "../../escape"
                    archive.addfile(member)
                with self.subTest(name=name, kind=kind), self.assertRaisesRegex(ValueError, "Unsafe"):
                    ios.extract_archive(file, folder / "out")
            file = folder / "valid.tar.gz"
            with tarfile.open(file, "w:gz") as archive:
                member = tarfile.TarInfo("Wallet.xcarchive/Info.plist")
                member.size = 4
                archive.addfile(member, io.BytesIO(b"test"))
            result = ios.extract_archive(file, folder / "valid")
            self.assertEqual((result / "Info.plist").read_bytes(), b"test")
            with tarfile.open(file, "w:gz") as archive:
                for name in ["Wallet.xcarchive/Info.plist", "Wallet.xcarchive//Info.plist"]:
                    archive.addfile(tarfile.TarInfo(name))
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                ios.extract_archive(file, folder / "duplicate")

    def test_extraction_never_uses_extractall_or_restores_special_file_modes(self):
        with tempfile.TemporaryDirectory(prefix="eos3-ios-extract-") as temp:
            folder = Path(temp)
            file = folder / "archive.tar.gz"
            with tarfile.open(file, "w:gz") as archive:
                member = tarfile.TarInfo("Wallet.xcarchive/executable")
                member.mode, member.size = 0o6777, 4
                archive.addfile(member, io.BytesIO(b"test"))
            with patch.object(tarfile.TarFile, "extractall", side_effect=AssertionError("must not use extractall")):
                result = ios.extract_archive(file, folder / "out")
            self.assertEqual((result / "executable").stat().st_mode & 0o7777, 0o755)
            with self.assertRaises(FileExistsError):
                ios.extract_archive(file, folder / "out")

    def test_ipa_version_is_checked_again_before_upload(self):
        with tempfile.TemporaryDirectory(prefix="eos3-ios-ipa-") as temp:
            file = Path(temp) / "app.ipa"
            info = {"version": "1.0.9", "IOS_BUILD_NUMBER": "27"}
            identity = {"CFBundleIdentifier": ios.BUNDLE_ID, "CFBundleShortVersionString": "1.0.9", "CFBundleVersion": "27"}
            with zipfile.ZipFile(file, "w") as archive:
                archive.writestr("Payload/Wallet.app/Info.plist", plistlib.dumps(identity))
            ios.ipa_identity(file, info)
            for key in ["version", "IOS_BUILD_NUMBER"]:
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, "identity"):
                    ios.ipa_identity(file, {**info, key: "999"})

    def test_base64_credentials_are_private_and_never_echoed_on_errors(self):
        with tempfile.TemporaryDirectory(prefix="eos3-ios-secret-") as temp:
            file = Path(temp) / "credential"
            with patch.dict(os.environ, {"FIXTURE_CREDENTIAL": base64.b64encode(b"fixture").decode()}):
                ios.secret_file("FIXTURE_CREDENTIAL", file)
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(file.read_bytes(), b"fixture")
            with patch.dict(os.environ, {"FIXTURE_CREDENTIAL": "invalid!"}), self.assertRaisesRegex(ValueError, "Base64"):
                ios.secret_file("FIXTURE_CREDENTIAL", file)


if __name__ == "__main__":
    unittest.main()
