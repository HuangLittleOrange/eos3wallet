"""Validate the published TestFlight release and render its static website copy."""
import html
import json
import re


def validate_release(release):
    if (not isinstance(release, dict) or release.get('platform') != 'ios'
            or release.get('enabled') is not True
            or not isinstance(release.get('versionName'), str)
            or not re.fullmatch(r'\d+\.\d+\.\d+', release['versionName'])
            or type(release.get('versionCode')) is not int
            or not 0 < release['versionCode'] <= 9007199254740991
            or not isinstance(release.get('apkUrl'), str)
            or not re.fullmatch(r'https://testflight\.apple\.com/join/[A-Za-z0-9]+', release['apkUrl'])):
        raise ValueError('Invalid published TestFlight release')
    return {key: release[key] for key in ('platform', 'enabled', 'versionName', 'versionCode', 'apkUrl')}


def render_ios(template, release):
    description = 'EOS³ Wallet 已开放 TestFlight 测试，打开安装链接查看当前版本，无需登记设备 ID。'
    if release is not None:
        release = validate_release(release)
        # The existing QR code encodes this invitation. Never announce a version
        # whose configured installation destination differs from the website.
        link = re.search(r'<a\b[^>]*id="ios-download"[^>]*href="([^"]+)"', template)
        if not link or html.unescape(link[1]) != release['apkUrl']:
            raise ValueError('TestFlight invitation differs from the website and QR code')
        description = f'EOS³ Wallet {release["versionName"]} 已开放 TestFlight 测试，无需登记设备 ID。'
    template, count = re.subn(r'(<p\b[^>]*data-i18n="iosDescription"[^>]*>)[^<]*(</p>)',
                              lambda m: m[1] + html.escape(description) + m[2], template)
    if count != 1:
        raise ValueError('Missing or duplicate iOS description')
    payload = json.dumps(release, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    template, count = re.subn(r'(<script id="ios-release-data" type="application/json">).*?(</script>)',
                              lambda m: m[1] + payload + m[2], template, flags=re.S)
    if count != 1:
        raise ValueError('Missing or duplicate iOS release data')
    return template


def render_ios_page(template, snapshot):
    # Legacy Android-only templates remain usable before iOS sync is installed.
    if not snapshot.exists() and 'id="ios-release-data"' not in template:
        return template
    release = json.loads(snapshot.read_text()) if snapshot.exists() else None
    return render_ios(template, release)
