"""Prepare an HTTPS Ad Hoc installation page from an already signed CI IPA."""

import argparse
import datetime
import hashlib
import html
import json
from pathlib import Path
import plistlib
import re
import secrets
import shutil
from string import Template
import subprocess
import tempfile
from urllib.parse import quote, urlsplit
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def prepare(release, output, base_url):
    parsed = urlsplit(base_url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment or
            not re.fullmatch(r"/(?:[A-Za-z0-9_-]+/)*", parsed.path)):
        raise ValueError("Use an HTTPS directory URL without credentials, query or fragment.")
    if output.exists():
        raise ValueError("Choose a new output directory; existing install links must be preserved.")
    info_bytes = (release / "build-info.json").read_bytes()
    inventory = (release / "SHA256SUMS").read_text()
    info_expected = re.search(r"^([a-f0-9]{64})  build-info\.json$", inventory, re.M)
    if not info_expected or info_expected[1] != hashlib.sha256(info_bytes).hexdigest():
        raise ValueError("The build metadata checksum does not match the release.")
    info = json.loads(info_bytes)
    if (info.get("distribution") != "ad-hoc" or info.get("signing") != "ad-hoc" or
            type(info.get("registeredDeviceCount")) is not int or info["registeredDeviceCount"] < 1):
        raise ValueError("Use a verified Ad Hoc release with registered devices.")
    version, build = info["version"], info["IOS_BUILD_NUMBER"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or not re.fullmatch(r"[1-9][0-9]{0,8}", build):
        raise ValueError("Invalid release version or build number.")
    expiry = datetime.datetime.fromisoformat(info["profileExpiration"]).replace(tzinfo=datetime.timezone.utc)
    if expiry <= datetime.datetime.now(datetime.timezone.utc):
        raise ValueError("The Ad Hoc profile has expired.")
    ipa = release / "wallet.ipa"
    hasher = hashlib.sha256()
    with ipa.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    ipa_hash = hasher.hexdigest()
    expected = re.search(r"^([a-f0-9]{64})  wallet\.ipa$", inventory, re.M)
    if not expected or expected[1] != ipa_hash:
        raise ValueError("The signed IPA checksum does not match the release.")
    with zipfile.ZipFile(ipa) as archive:
        names = [name for name in archive.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info.plist", name)]
        if len(names) != 1:
            raise ValueError("Expected exactly one application in the IPA.")
        app = plistlib.loads(archive.read(names[0]))
    if (app.get("CFBundleIdentifier") != "com.eos3.wallet" or info["bundleId"] != "com.eos3.wallet" or
            app.get("CFBundleShortVersionString") != version or app.get("CFBundleVersion") != build):
        raise ValueError("The IPA identity does not match the release metadata.")
    slug = f"{version}-{build}-{secrets.token_hex(16)}"
    page_url = base_url + slug + "/"
    install_url = "itms-services://?action=download-manifest&url=" + quote(page_url + "manifest.plist", safe="")
    manifest = {"items": [{"assets": [{"kind": "software-package", "url": page_url + "wallet.ipa"}],
                           "metadata": {"bundle-identifier": app["CFBundleIdentifier"],
                                        "bundle-version": build, "kind": "software", "title": "EOS³ Wallet"}}]}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=output.name + "-prepare-", dir=output.parent) as staging:
        site = Path(staging) / "public" / slug
        site.mkdir(parents=True)
        (site / "manifest.plist").write_bytes(plistlib.dumps(manifest))
        shutil.copyfile(ipa, site / "wallet.ipa")
        shutil.copyfile(ROOT / "assets/brand/eos3-app-icon.png", site / "icon.png")
        templates = ROOT / "scripts/ios-install-page"
        shutil.copyfile(templates / "styles.css", site / "styles.css")
        fields = {"version": version, "build": build, "size": f"{ipa.stat().st_size / 1000000:.1f}",
                  "minimum_os": str(app.get("MinimumOSVersion", "16.4")), "install_url": install_url,
                  "page_url": page_url, "devices": str(info["registeredDeviceCount"])}
        page = Template((templates / "index.html").read_text()).substitute(
            {key: html.escape(value, quote=True) for key, value in fields.items()})
        (site / "index.html").write_text(page)
        qr_code = """const fs = require('node:fs'); const qr = require('qrcode');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
qr.toFile(input.file, input.url, {width: 720, margin: 4, errorCorrectionLevel: 'M',
  color: {dark: '#102541', light: '#ffffff'}}).catch(error => { console.error(error.message); process.exitCode = 1; });
"""
        subprocess.run(["node", "-e", qr_code], cwd=ROOT, check=True, text=True,
                       input=json.dumps({"file": str((site / "qr.png").resolve()), "url": page_url}))
        record = {"pageUrl": page_url, "installUrl": install_url, "slug": slug,
                  "version": version, "buildNumber": build, "bundleId": app["CFBundleIdentifier"],
                  "registeredDeviceCount": info["registeredDeviceCount"], "profileExpirationUTC": expiry.isoformat(),
                  "ipaSha256": ipa_hash, "sourceCommit": info["GITHUB_SHA"],
                  "files": {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(site.iterdir())}}
        (Path(staging) / "deployment.json").write_text(json.dumps(record, indent=2) + "\n")
        if output.exists():
            raise ValueError("The output directory was created during preparation; refusing to replace it.")
        Path(staging).rename(output)
    print(f"Prepared iOS {version} ({build}) install page: {output / 'deployment.json'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, required=True, help="Signed CI release directory")
    parser.add_argument("--output", type=Path, required=True, help="New local delivery directory")
    parser.add_argument("--base-url", required=True, help="HTTPS directory, ending in /")
    args = parser.parse_args()
    prepare(args.release.resolve(), args.output.resolve(), args.base_url)
