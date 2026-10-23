#!/usr/bin/env python3
"""Refresh static iOS version copy from the public update catalog."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import tempfile
import urllib.request

from ios_release import render_ios, validate_release
from sync_releases import publish_page, render_page

API = 'https://eos3.app/api/app-update/check?platform=ios&versionCode=0'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Unexpected update API redirect')


def fetch_release():
    request = urllib.request.Request(API, headers={
        'User-Agent': 'eos3-wallet-site-sync/1', 'Accept': 'application/json', 'Cache-Control': 'no-cache',
    })
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        payload = response.read(256 * 1024 + 1)
    if len(payload) > 256 * 1024:
        raise ValueError('Update response exceeds limit')
    data = json.loads(payload)
    if data.get('updateAvailable') is False and data.get('release') is None:
        return None
    if data.get('updateAvailable') is not True:
        raise ValueError('Invalid update response')
    return validate_release(data.get('release'))


def write_snapshot(path, release):
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.ios-', delete=False) as output:
            temporary = Path(output.name)
            json.dump(release, output, ensure_ascii=False)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, path)
    finally:
        if 'temporary' in locals():
            temporary.unlink(missing_ok=True)


def sync(root, site_root, get_release=fetch_release):
    release = get_release()
    # Serialize with Android mirroring so either refresh preserves both platforms.
    with (root / 'sync.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        public = root / 'public'
        android = json.loads((public / 'latest.json').read_text())
        template = (site_root / 'index.html').read_text()
        expected = render_ios(render_page(template, android), release)
        snapshot = public / 'ios-latest.json'
        old_snapshot = snapshot.read_bytes() if snapshot.exists() else None
        if old_snapshot is not None and json.loads(old_snapshot) == release and (public / 'index.html').read_text() == expected:
            return 'Already current'
        # Validate everything before promoting the snapshot or HTML. Restore the
        # snapshot if publication fails, keeping the last successful state.
        try:
            write_snapshot(snapshot, release)
            publish_page(public, site_root, android)
        except Exception:
            if old_snapshot is None:
                snapshot.unlink(missing_ok=True)
            else:
                write_snapshot(snapshot, json.loads(old_snapshot))
            raise
        return 'Published iOS ' + (release['versionName'] if release else 'unversioned installation link')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/var/lib/eos3-wallet-mirror'))
    parser.add_argument('--site-root', type=Path, default=Path('/var/www/wallet.eos3.app/current'))
    args = parser.parse_args()
    print(sync(args.root, args.site_root), flush=True)


if __name__ == '__main__':
    main()
