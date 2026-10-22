"""Capture the unmodified build-35 source on disposable Apple simulators.

Only local public watch-account/session preferences are seeded. Balances,
resources and transaction data are fetched by the release app, never mocked.
No private wallet, signing credential, App Store key or production token is used.
"""

import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import sys
import time

SOURCE_SHA = "56c2bb5eaee6903e578cc6c378c594b76dc51a60"
BUNDLE = "com.eos3.wallet"
WATCH_ACCOUNT = "eosio"  # Public system account; no ownership/signing implied.


def run(args, *, cwd=None, log=None, check=True):
    if log:
        with log.open("w") as output:
            result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
        if check and result.returncode:
            raise RuntimeError(f"{args[0]} failed; see {log.name}")
        return ""
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr[-2500:]}")
    return result.stdout.strip()


def sim(*args, **kwargs):
    return run(["xcrun", "simctl", *args], **kwargs)


def capture(udid, path, accepted):
    sim("io", udid, "screenshot", "--type=png", str(path))
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError("Simulator did not produce PNG")
    size = struct.unpack(">II", raw[16:24])
    if size not in accepted:
        raise RuntimeError(f"Unexpected screenshot dimensions: {size}")
    return {"file": path.name, "width": size[0], "height": size[1],
            "sha256": hashlib.sha256(raw).hexdigest()}


def main():
    source, output = [Path(arg).resolve() for arg in sys.argv[1:]]
    output.mkdir(parents=True, exist_ok=True)
    if os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise RuntimeError("Only disposable GitHub-hosted runners are supported")
    if run(["git", "rev-parse", "HEAD"], cwd=source) != SOURCE_SHA:
        raise RuntimeError("Source differs from release build 35")
    if run(["git", "status", "--porcelain"], cwd=source):
        raise RuntimeError("Expected unmodified release sources")
    temporary = Path(os.environ["RUNNER_TEMP"]) / "eos3-store-screenshots"
    temporary.mkdir(exist_ok=False)
    devices = []
    report = {"sourceSha": SOURCE_SHA, "version": "1.0.10", "build": "35",
              "xcode": run(["xcodebuild", "-version"]), "devices": [],
              "watchAccount": WATCH_ACCOUNT, "dataMode": "live public watch-only",
              "appSourcesModified": False, "releaseCredentialsUsed": False}
    try:
        run(["node", "node_modules/expo/bin/cli", "prebuild", "--platform", "ios",
             "--no-install", "--template", "./node_modules/expo/template.tgz",
             "--skip-dependency-update", "react,react-native"], cwd=source,
            log=output / "prebuild.log")
        run(["npm", "run", "check:dependencies"], cwd=source,
            log=output / "dependencies.log")
        run(["pod", "install"], cwd=source / "ios", log=output / "pods.log")
        workspace, = (source / "ios").glob("*.xcworkspace")
        scheme, = (source / "ios").glob("*.xcodeproj/xcshareddata/xcschemes/*.xcscheme")
        derived = temporary / "DerivedData"
        run(["xcodebuild", "-workspace", str(workspace), "-scheme", scheme.stem,
             "-configuration", "Release", "-sdk", "iphonesimulator",
             "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", str(derived),
             "ARCHS=arm64",
             "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO",
             "COMPILER_INDEX_STORE_ENABLE=NO", "build"], cwd=source,
            log=output / "simulator-build.log")
        app, = (derived / "Build/Products/Release-iphonesimulator").glob("*.app")
        info = plistlib.loads((app / "Info.plist").read_bytes())
        if (info["CFBundleIdentifier"], info["CFBundleShortVersionString"],
                info["CFBundleVersion"]) != (BUNDLE, "1.0.10", "35"):
            raise RuntimeError("Compiled identity does not match release")
        run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app),
             str(output / "simulator-app.zip")])
        inventory = json.loads(sim("list", "--json"))
        (output / "simulator-inventory.json").write_text(json.dumps(inventory, indent=2))
        runtime = next(r for r in inventory["runtimes"]
                       if r.get("isAvailable") and r["identifier"].endswith("iOS-26-4"))
        types = inventory["devicetypes"]
        phone = next(t for t in types if t["name"] == "iPhone 17 Pro")
        tablet = next(t for t in types if t["name"].startswith("iPad Pro 13-inch (M4)"))
        for label, model, sizes in [
            ("iphone", phone, {(1206, 2622), (1179, 2556)}),
            ("ipad", tablet, {(2064, 2752), (2048, 2732)}),
        ]:
            print(f"Booting {model['name']}", flush=True)
            udid = sim("create", "EOS3 Store " + label, model["identifier"], runtime["identifier"])
            devices.append(udid)
            sim("boot", udid)
            sim("bootstatus", udid, "-b", log=output / f"{label}-boot.log")
            sim("status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi",
                "--wifiMode", "active", "--wifiBars", "3", "--batteryState", "charged",
                "--batteryLevel", "100")
            sim("ui", udid, "appearance", "light")
            sim("install", udid, str(app))
            container = Path(sim("get_app_container", udid, BUNDLE, "data"))
            storage = container / "Library/Application Support" / BUNDLE / "RCTAsyncLocalStorage_V1"
            storage.mkdir(parents=True, exist_ok=True)
            prefs = {"aurora.locale.v1": "en", "eos3.usage-analytics.v1": "disabled"}
            manifest = storage / "manifest.json"
            manifest.write_text(json.dumps(prefs))
            sim("launch", udid, BUNDLE, "-AppleLanguages", "(en)", "-AppleLocale", "en_US")
            time.sleep(20)
            shots = [capture(udid, output / f"{label}-02-get-started.png", sizes)]
            sim("terminate", udid, BUNDLE)
            # The release's ordinary persisted watch-only session, with no wallet keys.
            session = {"chainId": "vaulta", "account": WATCH_ACCOUNT, "hasAccount": True,
                       "perChain": {"vaulta": {"account": WATCH_ACCOUNT, "hasAccount": True}}}
            prefs = json.loads(manifest.read_text())
            prefs["aurora.session.v1"] = json.dumps(session)
            manifest.write_text(json.dumps(prefs))
            sim("launch", udid, BUNDLE, "-AppleLanguages", "(en)", "-AppleLocale", "en_US")
            time.sleep(50)
            shots.insert(0, capture(udid, output / f"{label}-01-watch-assets.png", sizes))
            report["devices"].append({"model": model["name"], "runtime": runtime["version"],
                                      "screenshots": shots})
            sim("shutdown", udid)
            sim("delete", udid)
            devices.remove(udid)
            print(f"Captured {label}", flush=True)
        report["status"] = "CAPTURED_REQUIRES_VISUAL_REVIEW"
    finally:
        (output / "provenance.json").write_text(json.dumps(report, indent=2) + "\n")
        for udid in devices:
            sim("shutdown", udid, check=False)
            sim("delete", udid, check=False)
        shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    main()
