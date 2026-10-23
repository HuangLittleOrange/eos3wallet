#!/usr/bin/env python3
"""Mirror verified public Android releases using only Python's standard library."""
from ios_release import render_ios_page

import argparse
import fcntl
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import signal
import tempfile
from datetime import datetime, timezone
import urllib.request
from urllib.parse import urlsplit

REPOSITORY = 'HuangLittleOrange/eos3wallet'
BASE = 'https://github.com/' + REPOSITORY
API = 'https://api.github.com/repos/' + REPOSITORY + '/releases/latest'
NAMES = ('wallet-release.apk', 'SHA256SUMS', 'android-release-evidence.zip')
LIMITS = dict(zip(NAMES, (512 * 1024**2, 65536, 2 * 1024**3)))
HOSTS = {'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}


def safe_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Untrusted upstream URL')
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, safe_url(newurl))


def open_url(url):
    request = urllib.request.Request(safe_url(url), headers={
        'User-Agent': 'eos3-wallet-release-mirror/1', 'Accept': 'application/vnd.github+json',
    })
    return urllib.request.build_opener(SafeRedirect()).open(request, timeout=60)


def fetch_release():
    with open_url(API) as response:
        raw = response.read(2 * 1024**2 + 1)
    if len(raw) > 2 * 1024**2:
        raise ValueError('Release metadata exceeds limit')
    data = json.loads(raw)
    validate_release(data)
    return data


def requested_release(request, get_latest=fetch_release):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?', request.get('versionName', ''))
    if not match:
        raise ValueError('Invalid saved Android version')
    expected = tuple(map(int, match.groups()))
    data = get_latest()
    validate_release(data)
    published = tuple(map(int, re.search(r'Wallet v(\d+)\.(\d+)\.(\d+)', data['name']).groups()))
    if published < expected:
        raise ValueError('GitHub release is not ready for the saved Android version; retry required')
    return data


def validate_release(data):
    if (not isinstance(data, dict) or data.get('draft') is not False or data.get('prerelease') is not False
            or type(data.get('id')) is not int or data['id'] <= 0
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', data.get('tag_name', ''))
            or data['tag_name'] in ('.', '..')
            or data.get('html_url') != BASE + '/releases/tag/' + data['tag_name']
            or not re.fullmatch(r'[a-f0-9]{40}', data.get('target_commitish', ''))
            or not re.fullmatch(r'EOS³ Wallet v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? · Android', data.get('name', ''))
            or not isinstance(data.get('assets'), list)):
        raise ValueError('Invalid stable release')
    assets = {}
    for name in NAMES:
        matches = [a for a in data['assets'] if isinstance(a, dict) and a.get('name') == name]
        if len(matches) != 1:
            raise ValueError('Missing or duplicate release asset: ' + name)
        asset = matches[0]
        if (type(asset.get('id')) is not int or asset['id'] <= 0
                or type(asset.get('size')) is not int or not 0 < asset['size'] <= LIMITS[name]
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest', ''))
                or asset.get('browser_download_url') != BASE + '/releases/download/' + data['tag_name'] + '/' + name):
            raise ValueError('Invalid release asset: ' + name)
        assets[name] = asset
    return assets


def identity(data):
    assets = validate_release(data)
    return {key: data[key] for key in ('id', 'tag_name', 'name', 'target_commitish')} | {
        'assets': [{key: assets[name][key] for key in ('id', 'name', 'digest', 'size')} for name in NAMES]
    }


def release_path(data):
    fingerprint = hashlib.sha256(json.dumps(identity(data), sort_keys=True).encode()).hexdigest()[:16]
    return data['tag_name'] + '/' + str(data['id']) + '-' + fingerprint


def digest_file(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024**2), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def download(asset, target):
    hasher = hashlib.sha256()
    count = 0
    with open_url(asset['browser_download_url']) as response, target.open('xb') as output:
        for chunk in iter(lambda: response.read(1024**2), b''):
            count += len(chunk)
            if count > asset['size']:
                raise ValueError('Asset exceeded advertised size: ' + asset['name'])
            hasher.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    if count != asset['size'] or 'sha256:' + hasher.hexdigest() != asset['digest']:
        raise ValueError('Asset size or SHA256 mismatch: ' + asset['name'])
    target.chmod(0o644)


def verify_files(directory, data):
    assets = validate_release(data)
    for name, asset in assets.items():
        path = directory / name
        if (path.is_symlink() or not path.is_file() or path.stat().st_size != asset['size']
                or 'sha256:' + digest_file(path) != asset['digest']):
            raise ValueError('Local asset verification failed: ' + name)
    checksums = {}
    for line in (directory / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (wallet-release\.apk|android-release-evidence\.zip)', line)
        if not match or match[2] in checksums:
            raise ValueError('Invalid checksum inventory')
        checksums[match[2]] = match[1]
    expected = {name: assets[name]['digest'][7:] for name in (NAMES[0], NAMES[2])}
    if checksums != expected:
        raise ValueError('Checksums differ from GitHub asset digests')


def public_metadata(data):
    assets = validate_release(data)
    result = {key: data[key] for key in ('id', 'name', 'tag_name', 'target_commitish', 'draft', 'prerelease', 'html_url', 'published_at')}
    prefix = '/downloads/' + release_path(data) + '/'
    result['mirror'] = {'schemaVersion': 1, 'repository': REPOSITORY, 'prefix': prefix,
                        'syncedAt': datetime.now(timezone.utc).isoformat()}
    result['assets'] = [dict(assets[name], mirror_url=prefix + name) for name in NAMES]
    # Expose only the fields needed for download verification.
    result['assets'] = [{key: a[key] for key in ('id', 'name', 'size', 'digest', 'browser_download_url', 'mirror_url')} for a in result['assets']]
    return result


def write_json(path, data):
    with path.open('w') as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    path.chmod(0o644)


def render_page(template, data):
    """Render the complete verified release before serving HTML to visitors."""
    assets = validate_release(data)
    prefix = '/downloads/' + release_path(data) + '/'
    if data.get('mirror', {}).get('prefix') != prefix:
        raise ValueError('Invalid mirrored page metadata')
    values = {
        'release-version': ('text', re.search(r'Wallet (v[^ ]+)', data['name'])[1]),
        'apk-sha256': ('text', assets[NAMES[0]]['digest'][7:]),
        'release-page': ('href', data['html_url']),
        'github-download': ('href', assets[NAMES[0]]['browser_download_url']),
    }
    for element, name in [('apk-download', NAMES[0]), ('checksum-download', NAMES[1]), ('evidence-download', NAMES[2])]:
        if assets[name].get('mirror_url') != prefix + name:
            raise ValueError('Invalid mirrored page asset')
        values[element] = ('href', 'https://wallet.eos3.app' + prefix + name)
    for element, (kind, value) in values.items():
        pattern = r'(<[^>]+\bid="' + element + r'"[^>]*>)([^<]*)' if kind == 'text' else r'(<[^>]+\bid="' + element + r'"[^>]*\bhref=")[^"]*(")'
        replacement = (lambda m: m[1] + html.escape(value)) if kind == 'text' else (lambda m: m[1] + html.escape(value, quote=True) + m[2])
        template, count = re.subn(pattern, replacement, template)
        if count != 1:
            raise ValueError('Missing or duplicate page element: ' + element)
    payload = json.dumps(data, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    template, count = re.subn(r'(<script id="release-data" type="application/json">).*?(</script>)',
                              lambda m: m[1] + payload + m[2], template, flags=re.S)
    if count != 1:
        raise ValueError('Missing embedded release data')
    return template


def publish_page(public, site_root, data):
    if site_root is None:
        return
    rendered = render_ios_page(render_page((site_root / 'index.html').read_text(), data), public / 'ios-latest.json')
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=public, prefix='.page-', delete=False) as output:
            temporary = Path(output.name)
            output.write(rendered)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, public / 'index.html')
    finally:
        if 'temporary' in locals():
            temporary.unlink(missing_ok=True)


def prune(public, current, site_root, keep=3):
    # Only this program's verified release folders qualify; unknown files are preserved.
    pinned = set()
    if site_root and (site_root / 'index.html').is_file():
        pinned.update(re.findall(r'/downloads/([A-Za-z0-9._-]+/\d+-[a-f0-9]{16})/', (site_root / 'index.html').read_text()))
    releases = []
    for tag in public.iterdir():
        if tag.is_symlink() or not tag.is_dir():
            continue
        for folder in tag.iterdir():
            if folder.is_symlink() or not folder.is_dir():
                continue
            try:
                entries = list(folder.iterdir())
                if ({p.name for p in entries} != set(NAMES) | {'release.json'}
                        or any(p.is_symlink() or not p.is_file() for p in entries)):
                    continue
                metadata = json.loads((folder / 'release.json').read_text())
                if release_path(metadata) != folder.relative_to(public).as_posix():
                    continue
                releases.append((folder.stat().st_mtime, folder, metadata))
            except (ValueError, KeyError, OSError):
                continue
    now = datetime.now(timezone.utc).timestamp()
    for _, folder, metadata in sorted(releases, key=lambda item: item[0], reverse=True)[keep:]:
        relative = folder.relative_to(public).as_posix()
        if relative == current or relative in pinned or now - folder.stat().st_mtime < 86400:
            continue
        verify_files(folder, metadata)
        shutil.rmtree(folder)
        if not any(folder.parent.iterdir()):
            folder.parent.rmdir()


def clean_interrupted_work(work):
    for task in work.iterdir():
        if task.is_symlink() or not task.is_dir() or not task.name.startswith('sync-'):
            continue
        marker = task / '.mirror-task'
        if not marker.is_file() or marker.is_symlink() or marker.read_text() != REPOSITORY:
            continue
        entries = list(task.iterdir())
        if any(p.is_symlink() or p.name not in ('.mirror-task', 'release', 'latest.json')
               or (p.name != 'release' and not p.is_file()) for p in entries):
            continue
        stage = task / 'release'
        if stage.exists() and (not stage.is_dir() or any(
                p.is_symlink() or not p.is_file() or p.name not in (*NAMES, 'release.json') for p in stage.iterdir())):
            continue
        shutil.rmtree(task)


def sync(root, site_root=None, get_release=fetch_release, download_asset=download, before_publish=lambda: None):
    root.mkdir(parents=True, exist_ok=True)
    public, work = root / 'public', root / 'work'
    public.mkdir(exist_ok=True, mode=0o755)
    work.mkdir(exist_ok=True, mode=0o700)
    with (root / 'sync.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 'Another sync is running'
        clean_interrupted_work(work)
        data = get_release()
        assets = validate_release(data)
        relative = release_path(data)
        destination = public / relative
        latest = public / 'latest.json'
        if latest.is_file() and destination.is_dir():
            previous = json.loads(latest.read_text())
            if identity(previous) == identity(data) and all(
                    not (destination / name).is_symlink() and (destination / name).is_file()
                    and (destination / name).stat().st_size == assets[name]['size'] for name in NAMES):
                before_publish()
                if site_root is not None:
                    verify_files(destination, previous)
                    publish_page(public, site_root, previous)
                return 'Already current: ' + data['tag_name']
        # The temporary directory is private, on the same filesystem, and cleaned on all exits.
        with tempfile.TemporaryDirectory(prefix='sync-', dir=work) as task_dir:
            task = Path(task_dir)
            (task / '.mirror-task').write_text(REPOSITORY)
            stage = task / 'release'
            stage.mkdir()
            if not destination.exists():
                if shutil.disk_usage(root).free < sum(a['size'] for a in assets.values()) + 512 * 1024**2:
                    raise ValueError('Insufficient free space; keeping the previous release')
                # Small checksum inventory first; large artifacts are streamed, never buffered.
                for name in ('SHA256SUMS', 'wallet-release.apk', 'android-release-evidence.zip'):
                    print('Downloading ' + data['tag_name'] + '/' + name, flush=True)
                    download_asset(assets[name], stage / name)
                verify_files(stage, data)
            else:
                verify_files(destination, data)
            # Do not publish a stale or replaced release if Latest changed during download.
            if identity(get_release()) != identity(data):
                raise ValueError('Latest changed during download; retrying on the next run')
            before_publish()
            metadata = public_metadata(data)
            # Validate the template before promoting metadata or HTML.
            if site_root is not None:
                render_page((site_root / 'index.html').read_text(), metadata)
            if not destination.exists():
                write_json(stage / 'release.json', metadata)
                stage.chmod(0o755)
                destination.parent.mkdir(exist_ok=True, mode=0o755)
                os.replace(stage, destination)
            write_json(task / 'latest.json', metadata)
            os.replace(task / 'latest.json', latest)
            publish_page(public, site_root, metadata)
        prune(public, relative, site_root)
        return 'Mirrored and verified: ' + data['tag_name']


def main():
    def terminated(_signal, _frame):
        raise InterruptedError('Sync terminated; temporary downloads will be cleaned')
    signal.signal(signal.SIGTERM, terminated)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/var/lib/eos3-wallet-mirror'))
    parser.add_argument('--site-root', type=Path, default=Path('/var/www/wallet.eos3.app/current'))
    parser.add_argument('--request-file', type=Path)
    args = parser.parse_args()
    try:
        get_release = fetch_release
        before_publish = lambda: None
        if args.request_file:
            request_bytes = args.request_file.read_bytes()
            request = json.loads(request_bytes)
            if request is None:
                print('No enabled Android release; preserving the last verified website', flush=True)
                return
            # The admin save is a trigger, not a replacement source of trust.
            # Keep mirroring GitHub Latest so saving an older app-update policy
            # cannot silently downgrade the public download website.
            # If the admin saves before publication finishes, keep retrying
            # until GitHub has that version instead of acknowledging an old one.
            get_release = lambda: requested_release(request)
            def before_publish():
                if args.request_file.read_bytes() != request_bytes:
                    raise ValueError('Admin release changed during sync; retry required')
        print(sync(args.root, args.site_root, get_release=get_release, before_publish=before_publish), flush=True)
    except Exception as error:
        print('Sync failed; previous downloads preserved: ' + str(error), flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
