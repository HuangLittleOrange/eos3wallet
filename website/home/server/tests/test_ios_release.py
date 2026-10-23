import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ios_release import render_ios, validate_release
import sync_ios_release as ios
import sync_releases as android

HOME = Path(__file__).resolve().parents[2]


def release(version='1.0.12', code=37):
    return dict(platform='ios', enabled=True, versionName=version, versionCode=code,
                apkUrl='https://testflight.apple.com/join/BJrMV91r')


class IOSReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='eos3-ios-site-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.public = self.root / 'public'
        self.public.mkdir()
        self.site = self.root / 'site'
        self.site.mkdir()
        self.template = (HOME / 'index.html').read_text()
        (self.site / 'index.html').write_text(self.template)
        self.android = json.loads(self.template.split('<script id="release-data" type="application/json">')[1].split('</script>')[0])
        (self.public / 'latest.json').write_text(json.dumps(self.android))
        (self.public / 'index.html').write_text('previous complete page')

    def sync(self, data):
        return ios.sync(self.root, self.site, get_release=lambda: data)

    def test_new_version_updates_static_html_without_build_number(self):
        self.sync(release('1.0.13', 38))
        page = (self.public / 'index.html').read_text()
        self.assertIn('EOS³ Wallet 1.0.13 已开放', page)
        self.assertNotIn('（38）', page)
        self.assertIn('"versionCode": 38', page)
        self.assertEqual(json.loads((self.public / 'latest.json').read_text()), self.android)

    def test_android_refresh_preserves_current_ios_snapshot(self):
        self.sync(release('1.0.13', 38))
        android.publish_page(self.public, self.site, self.android)
        self.assertIn('1.0.13 已开放', (self.public / 'index.html').read_text())

    def test_unchanged_version_does_not_rewrite_page(self):
        self.sync(release())
        page = self.public / 'index.html'
        before = page.stat().st_mtime_ns
        self.assertEqual(self.sync(release()), 'Already current')
        self.assertEqual(page.stat().st_mtime_ns, before)

    def test_disabled_catalog_removes_stale_version(self):
        self.sync(release())
        self.sync(None)
        page = (self.public / 'index.html').read_text()
        self.assertIn('打开安装链接查看当前版本', page)
        self.assertNotIn('1.0.12 已开放', page)
        self.assertIn('id="ios-release-data" type="application/json">null</script>', page)

    def test_api_failure_preserves_page_and_snapshot(self):
        self.sync(release())
        page = (self.public / 'index.html').read_bytes()
        snapshot = (self.public / 'ios-latest.json').read_bytes()
        with self.assertRaises(OSError):
            ios.sync(self.root, self.site, get_release=lambda: (_ for _ in ()).throw(OSError('offline')))
        self.assertEqual((self.public / 'index.html').read_bytes(), page)
        self.assertEqual((self.public / 'ios-latest.json').read_bytes(), snapshot)

    def test_publication_failure_restores_snapshot(self):
        self.sync(release())
        before = (self.public / 'ios-latest.json').read_bytes()
        with patch.object(ios, 'publish_page', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.sync(release('1.0.13', 38))
        self.assertEqual((self.public / 'ios-latest.json').read_bytes(), before)
        self.assertFalse(list(self.public.glob('.ios-*')))

    def test_wrong_invitation_is_rejected_before_publication(self):
        self.sync(release())
        before = (self.public / 'index.html').read_bytes()
        wrong = release('1.0.13', 38)
        wrong['apkUrl'] = 'https://testflight.apple.com/join/other'
        with self.assertRaisesRegex(ValueError, 'invitation'):
            self.sync(wrong)
        self.assertEqual((self.public / 'index.html').read_bytes(), before)

    def test_invalid_version_or_destination_is_rejected(self):
        for key, value in [('platform', 'android'), ('enabled', False), ('versionName', '<script>'),
                           ('versionCode', True), ('versionCode', -1), ('apkUrl', 'https://evil.example/')]:
            with self.subTest(key=key, value=value):
                data = release()
                data[key] = value
                with self.assertRaises(ValueError):
                    validate_release(data)

    def test_missing_markers_fail_instead_of_publishing_incomplete_copy(self):
        with self.assertRaises(ValueError):
            render_ios('<html></html>', release())


if __name__ == '__main__':
    unittest.main()
