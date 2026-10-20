"""GitHub-hosted iOS build/export/upload controller; Python standard library only."""

import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
BUNDLE_ID = "com.eos3.wallet"
UNSIGNED = ROOT / "exports/github-ios-unsigned"
SIGNED = ROOT / "exports/github-ios-signed"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def context(env=None):
    env = os.environ if env is None else env
    require(env.get("GITHUB_ACTIONS") == "true" and
            env.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and
            env.get("GITHUB_REF") == "refs/heads/main" and
            env.get("GITHUB_SERVER_URL") == "https://github.com",
            "iOS releases must be manually dispatched from main on GitHub Actions.")
    rules = {"GITHUB_SHA": r"[a-f0-9]{40}", "GITHUB_REPOSITORY": r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",
             "GITHUB_RUN_ID": r"[1-9][0-9]*", "GITHUB_RUN_ATTEMPT": r"[1-9][0-9]*",
             "IOS_BUILD_NUMBER": r"[1-9][0-9]{0,8}"}
    for name, pattern in rules.items():
        require(re.fullmatch(pattern, env.get(name, "")), f"Invalid or missing {name}.")
    return {name: env[name] for name in rules}


def run(args, *, cwd=ROOT, log=None, quiet=False, env=None):
    if log:
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("w") as output:
            process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True)
            for line in process.stdout:
                print(line, end="", flush=True)
                output.write(line)
            require(process.wait() == 0, f"{Path(args[0]).name} failed; see {log.name}.")
        return ""
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)
    # Never echo command arguments or diagnostics from keychain/credential operations.
    require(result.returncode == 0, f"{Path(args[0]).name} failed." if quiet else
            f"{Path(args[0]).name} failed: {result.stderr[-4000:]}")
    return result.stdout.strip()


def work():
    require(os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "Use a disposable GitHub-hosted runner.")
    parent = Path(os.environ["RUNNER_TEMP"]).resolve()
    target = parent / "eos3-ios"
    require(not target.is_symlink(), "Unexpected temporary directory symlink.")
    target.mkdir(mode=0o700, exist_ok=True)
    return target


def digest(file):
    require(file.is_file() and not file.is_symlink(), "Expected a regular artifact file.")
    hasher = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def checksums(directory, names, verify=False):
    text = "".join(f"{digest(directory / name)}  {name}\n" for name in names)
    target = directory / "SHA256SUMS"
    if verify:
        require(not target.is_symlink() and target.read_text() == text, "Artifact inventory or SHA-256 mismatch.")
    else:
        target.write_text(text)


def metadata(directory, names):
    checksums(directory, names, verify=True)
    info = json.loads((directory / "build-info.json").read_text())
    require(all(info.get(key) == value for key, value in context().items()),
            "Artifact belongs to another source commit, build number or workflow attempt.")
    require(info.get("bundleId") == BUNDLE_ID and
            re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", info.get("version", "")), "Invalid app identity.")
    return info


def verify_identity(plist, info):
    require(plist.get("CFBundleIdentifier") == BUNDLE_ID and
            plist.get("CFBundleShortVersionString") == info["version"] and
            plist.get("CFBundleVersion") == info["IOS_BUILD_NUMBER"],
            "Compiled app identity differs from the requested version or build number.")


def ipa_identity(file, info):
    with zipfile.ZipFile(file) as archive:
        names = [name for name in archive.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info.plist", name)]
        require(len(names) == 1, "Expected exactly one iOS application in IPA.")
        verify_identity(plistlib.loads(archive.read(names[0])), info)


def prepare():
    context()
    require(run(["git", "rev-parse", "HEAD"]) == os.environ["GITHUB_SHA"], "Checkout differs from workflow commit.")
    require(not run(["git", "status", "--porcelain"]), "Expected a clean source checkout.")
    require(run(["xcodebuild", "-version"]).splitlines()[0] == "Xcode 26.4.1", "Expected Xcode 26.4.1.")
    require(run(["xcrun", "--sdk", "iphoneos", "--show-sdk-version"]) == "26.4", "Expected iOS SDK 26.4.")
    run(["pod", "--version"])
    work()
    print("Validated main checkout, build number, Xcode 26.4.1, iOS SDK 26.4 and CocoaPods.")


def build():
    info = context()
    temporary = work()
    logs = ROOT / "exports/github-ios-logs"
    require(not (ROOT / "ios").exists(), "Expected a fresh checkout without a generated iOS project.")
    app = json.loads((ROOT / "app.json").read_text())["expo"]
    require(app["ios"]["bundleIdentifier"] == BUNDLE_ID, "Unexpected source bundle identifier.")
    run(["node", "node_modules/expo/bin/cli", "prebuild", "--platform", "ios", "--no-install",
         "--template", "./node_modules/expo/template.tgz", "--skip-dependency-update", "react,react-native"],
        log=logs / "prebuild.txt")
    run(["npm", "run", "check:dependencies"], log=logs / "dependencies.txt")
    run(["pod", "install"], cwd=ROOT / "ios", log=logs / "pods.txt")
    workspaces = list((ROOT / "ios").glob("*.xcworkspace"))
    require(len(workspaces) == 1, "Expected one generated iOS workspace.")
    schemes = list((ROOT / "ios").glob("*.xcodeproj/xcshareddata/xcschemes/*.xcscheme"))
    require(len(schemes) == 1, "Expected one shared app scheme.")
    archive = temporary / "Wallet.xcarchive"
    run(["xcodebuild", "-workspace", str(workspaces[0]), "-scheme", schemes[0].stem,
         "-configuration", "Release", "-sdk", "iphoneos", "-destination", "generic/platform=iOS",
         "-archivePath", str(archive), "-derivedDataPath", str(temporary / "DerivedData"),
         "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "COMPILER_INDEX_STORE_ENABLE=NO", "archive"],
        log=logs / "archive.txt")
    info.update(bundleId=BUNDLE_ID, version=app["version"], signing="ad-hoc-without-identity",
                xcode=run(["xcodebuild", "-version"]), node=run(["node", "--version"]),
                cocoapods=run(["pod", "--version"]), lockSha256=digest(ROOT / "package-lock.json"))
    applications = list((archive / "Products/Applications").glob("*.app"))
    require(len(applications) == 1, "Expected one archived app.")
    verify_identity(plistlib.loads((applications[0] / "Info.plist").read_bytes()), info)
    require(not list(applications[0].rglob("*.appex")), "Extensions require their own signing profiles.")
    entitlement_files = list((ROOT / "ios").glob("*/*.entitlements"))
    require(len(entitlement_files) == 1, "Expected one generated app entitlement file.")
    capabilities = plistlib.loads(entitlement_files[0].read_bytes())
    require(capabilities == {"com.apple.developer.associated-domains": app["ios"]["associatedDomains"]},
            "App capabilities changed; review archive signing before releasing.")
    # Exporting a completely unsigned archive can drop capabilities. An ad hoc
    # signature preserves the generated entitlements without an Apple identity.
    nested = [file for file in applications[0].rglob("*") if file.suffix in {".framework", ".dylib"}]
    for file in sorted(nested, key=lambda file: len(file.parts), reverse=True):
        run(["codesign", "--force", "--sign", "-", str(file)])
    run(["codesign", "--force", "--sign", "-", "--entitlements", str(entitlement_files[0]), str(applications[0])])
    # Resolve only links contained within the archive; the signing job extracts regular files.
    for file in archive.rglob("*"):
        require(file.resolve().is_relative_to(archive.resolve()), "Archive contains an escaping symlink.")
    UNSIGNED.mkdir(parents=True, exist_ok=False)
    with tarfile.open(UNSIGNED / "Wallet.xcarchive.tar.gz", "w:gz", dereference=True) as output:
        output.add(archive, arcname="Wallet.xcarchive")
    (UNSIGNED / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
    checksums(UNSIGNED, ["Wallet.xcarchive.tar.gz", "build-info.json"])
    print("Archive without an Apple signing identity and source/build metadata saved.")


def extract_archive(file, destination):
    with tarfile.open(file) as archive:
        names = set()
        for member in archive.getmembers():
            path = Path(member.name)
            require(not path.is_absolute() and ".." not in path.parts and path.parts and
                    path.parts[0] == "Wallet.xcarchive" and (member.isfile() or member.isdir()) and
                    path.as_posix() not in names, "Unsafe archive entry.")
            names.add(path.as_posix())
        archive.extractall(destination, filter="data")
    return destination / "Wallet.xcarchive"


def validate_profile(profile, team, now=None):
    require(re.fullmatch(r"[A-Z0-9]{10}", team), "Set APPLE_TEAM_ID to your 10-character Apple team ID.")
    entitlements = profile.get("Entitlements", {})
    require(profile.get("TeamIdentifier") == [team] and
            entitlements.get("application-identifier") == f"{team}.{BUNDLE_ID}" and
            entitlements.get("com.apple.developer.team-identifier") == team and
            entitlements.get("beta-reports-active") is True and
            entitlements.get("get-task-allow") is not True and
            "ProvisionedDevices" not in profile and not profile.get("ProvisionsAllDevices"),
            "Use an App Store distribution profile matching this app and Apple team; Ad Hoc is not supported.")
    now = now or datetime.datetime.now(datetime.timezone.utc)
    expiration = profile.get("ExpirationDate")
    require(isinstance(expiration, datetime.datetime) and expiration.replace(tzinfo=datetime.timezone.utc) > now,
            "Provisioning profile has expired.")
    require(re.fullmatch(r"[A-Fa-f0-9-]{36}", profile.get("UUID", "")), "Invalid profile UUID.")
    require("webcredentials:eos3.app" in entitlements.get("com.apple.developer.associated-domains", []) or
            "*" in entitlements.get("com.apple.developer.associated-domains", []),
            "Enable Associated Domains on the App ID and regenerate its distribution profile.")


def secret_file(name, file):
    value = os.environ.get(name, "")
    require(value, f"Missing GitHub Environment secret: {name}.")
    try:
        data = base64.b64decode("".join(value.split()), validate=True)
    except ValueError:
        raise ValueError(f"{name} must contain Base64 file data.") from None
    require(data, f"Empty credential: {name}.")
    file.write_bytes(data)
    file.chmod(0o600)


def sign():
    temporary = work()
    source = ROOT / "exports/github-ios-input"
    info = metadata(source, ["Wallet.xcarchive.tar.gz", "build-info.json"])
    require(info.get("signing") == "ad-hoc-without-identity", "Expected an archive without an Apple signing identity.")
    archive = extract_archive(source / "Wallet.xcarchive.tar.gz", temporary)
    apps = list((archive / "Products/Applications").glob("*.app"))
    require(len(apps) == 1 and not list(apps[0].rglob("*.appex")), "Expected one app without extensions.")
    verify_identity(plistlib.loads((apps[0] / "Info.plist").read_bytes()), info)
    certificate, profile_file = temporary / "distribution.p12", temporary / "app.mobileprovision"
    secret_file("IOS_DISTRIBUTION_P12_BASE64", certificate)
    secret_file("IOS_APP_STORE_PROFILE_BASE64", profile_file)
    profile = plistlib.loads(subprocess.check_output(["security", "cms", "-D", "-i", str(profile_file)], stderr=subprocess.DEVNULL))
    team = os.environ.get("APPLE_TEAM_ID", "")
    validate_profile(profile, team)
    keychain = temporary / "signing.keychain-db"
    password = secrets.token_urlsafe(32)
    original = shlex.split(run(["security", "list-keychains", "-d", "user"], quiet=True))
    (temporary / "keychains.json").write_text(json.dumps(original))
    run(["security", "create-keychain", "-p", password, str(keychain)], quiet=True)
    run(["security", "set-keychain-settings", "-lut", "21600", str(keychain)], quiet=True)
    run(["security", "unlock-keychain", "-p", password, str(keychain)], quiet=True)
    p12_password = os.environ.get("IOS_DISTRIBUTION_P12_PASSWORD", "")
    run(["security", "import", str(certificate), "-k", str(keychain), "-P", p12_password,
         "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"], quiet=True)
    run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:",
         "-k", password, str(keychain)], quiet=True)
    run(["security", "list-keychains", "-d", "user", "-s", str(keychain), *original], quiet=True)
    identities = run(["security", "find-identity", "-v", "-p", "codesigning", str(keychain)], quiet=True)
    matches = re.findall(r'\b([A-F0-9]{40}) "Apple Distribution:[^"\n]+"', identities)
    require(len(matches) == 1, "P12 must contain one valid Apple Distribution signing identity with its private key.")
    require(any(hashlib.sha1(cert).hexdigest().upper() == matches[0] for cert in profile.get("DeveloperCertificates", [])),
            "Provisioning profile does not include the imported signing certificate.")
    for relative in ["Library/MobileDevice/Provisioning Profiles", "Library/Developer/Xcode/UserData/Provisioning Profiles"]:
        folder = Path.home() / relative
        folder.mkdir(parents=True, exist_ok=True)
        installed = folder / f"{profile['UUID']}.mobileprovision"
        require(not installed.exists() and not installed.is_symlink(), "Refusing to replace an existing provisioning profile.")
        # Record the exact created path before copying for cleanup on partial failures.
        with (temporary / "profiles.jsonl").open("a") as journal:
            journal.write(json.dumps(str(installed)) + "\n")
        shutil.copyfile(profile_file, installed)
    options = {"method": "app-store-connect", "destination": "export", "signingStyle": "manual",
               "teamID": team, "signingCertificate": matches[0], "manageAppVersionAndBuildNumber": False,
               "provisioningProfiles": {BUNDLE_ID: profile["UUID"]}, "stripSwiftSymbols": True,
               "uploadSymbols": True}
    export_options = temporary / "ExportOptions.plist"
    export_options.write_bytes(plistlib.dumps(options))
    exported = temporary / "exported"
    run(["xcodebuild", "-exportArchive", "-archivePath", str(archive), "-exportPath", str(exported),
         "-exportOptionsPlist", str(export_options)], log=temporary / "export.txt")
    ipas = list(exported.glob("*.ipa"))
    require(len(ipas) == 1, "Expected one exported IPA.")
    ipa_identity(ipas[0], info)
    verify = temporary / "verify"
    run(["ditto", "-x", "-k", str(ipas[0]), str(verify)])
    signed_apps = list((verify / "Payload").glob("*.app"))
    require(len(signed_apps) == 1, "Expected one signed app.")
    run(["codesign", "--verify", "--deep", "--strict", str(signed_apps[0])])
    entitlement_output = run(["codesign", "--display", "--entitlements", ":-", str(signed_apps[0])])
    signed_entitlements = plistlib.loads(entitlement_output.encode())
    require(signed_entitlements.get("application-identifier") == f"{team}.{BUNDLE_ID}" and
            signed_entitlements.get("com.apple.developer.team-identifier") == team and
            signed_entitlements.get("get-task-allow") is not True and
            set(signed_entitlements.get("com.apple.developer.associated-domains", [])) ==
            {"webcredentials:eos3.app", "applinks:eos3.app"},
            "Exported signature lost the app identity or Associated Domains entitlement.")
    SIGNED.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(ipas[0], SIGNED / "wallet.ipa")
    symbols = archive / "dSYMs"
    require(symbols.is_dir(), "Missing archive dSYMs.")
    run(["ditto", "-c", "-k", "--keepParent", str(symbols), str(SIGNED / "dSYMs.zip")])
    info.update(signing="app-store-connect", teamId=team, unsignedSha256=digest(source / "Wallet.xcarchive.tar.gz"))
    (SIGNED / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
    checksums(SIGNED, ["wallet.ipa", "dSYMs.zip", "build-info.json"])
    print("Signature-verified App Store IPA and dSYMs saved.")


def upload():
    info = metadata(SIGNED, ["wallet.ipa", "dSYMs.zip", "build-info.json"])
    require(info.get("signing") == "app-store-connect", "Only an App Store-signed IPA can be uploaded.")
    ipa_identity(SIGNED / "wallet.ipa", info)
    key_id, issuer = os.environ.get("APP_STORE_CONNECT_KEY_ID", ""), os.environ.get("APP_STORE_CONNECT_ISSUER_ID", "")
    require(re.fullmatch(r"[A-Z0-9]{10}", key_id), "Missing or invalid App Store Connect API key ID.")
    require(re.fullmatch(r"[a-fA-F0-9-]{36}", issuer), "Missing or invalid App Store Connect issuer ID.")
    keys = work() / "private_keys"
    keys.mkdir(mode=0o700)
    secret_file("APP_STORE_CONNECT_PRIVATE_KEY_BASE64", keys / f"AuthKey_{key_id}.p8")
    env = {**os.environ, "API_PRIVATE_KEYS_DIR": str(keys)}
    common = ["-f", str(SIGNED / "wallet.ipa"), "-t", "ios", "--apiKey", key_id, "--apiIssuer", issuer]
    run(["xcrun", "altool", "--validate-app", *common], quiet=True, env=env)
    run(["xcrun", "altool", "--upload-app", *common], quiet=True, env=env)
    output = ROOT / "exports/github-ios-upload"
    output.mkdir(parents=True, exist_ok=False)
    receipt = {**info, "ipaSha256": digest(SIGNED / "wallet.ipa"), "uploadAccepted": True,
               "appleProcessing": "pending; check App Store Connect", "uploadedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (output / "upload-result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as stream:
            stream.write(f"### iOS upload accepted\n\n{BUNDLE_ID} {info['version']} ({info['IOS_BUILD_NUMBER']})\n\n"
                         "Apple processing is pending. Check App Store Connect → TestFlight for availability and tester groups.\n")
    print("Upload accepted. Apple processing and TestFlight availability must be checked in App Store Connect.")


def cleanup():
    temporary = work()
    journal = temporary / "profiles.jsonl"
    if journal.exists():
        for line in journal.read_text().splitlines():
            Path(json.loads(line)).unlink(missing_ok=True)
    previous = temporary / "keychains.json"
    if previous.exists():
        run(["security", "list-keychains", "-d", "user", "-s", *json.loads(previous.read_text())], quiet=True)
    keychain = temporary / "signing.keychain-db"
    if keychain.exists():
        run(["security", "delete-keychain", str(keychain)], quiet=True)
    shutil.rmtree(temporary)


def cleanup_build():
    cleanup()
    for name in ["ios", "node_modules"]:
        target = ROOT / name
        require(not target.is_symlink(), "Refusing to clean a linked build directory.")
        if target.exists():
            shutil.rmtree(target)


if __name__ == "__main__":
    try:
        command = sys.argv[1] if len(sys.argv) == 2 else ""
        commands = {"prepare": prepare, "build": build, "sign": sign, "upload": upload,
                    "cleanup": cleanup, "cleanup-build": cleanup_build}
        require(command in commands, "Use prepare, build, sign, upload, cleanup or cleanup-build.")
        try:
            commands[command]()
        finally:
            if command in {"sign", "upload"}:
                cleanup()
    except Exception as error:
        # CalledProcessError may include secret command arguments. Never print it.
        print(str(error) if isinstance(error, ValueError) else f"iOS {command} failed ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
