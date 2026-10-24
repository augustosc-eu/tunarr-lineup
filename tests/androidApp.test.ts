import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, 'android', file), 'utf8');

describe('Android app (D60)', () => {
  const gradle = read('app/build.gradle.kts');
  const manifest = read('app/src/main/AndroidManifest.xml');
  const applicationId = /applicationId = "([^"]+)"/.exec(gradle)?.[1];

  it('names one application id everywhere the launcher looks for it', () => {
    expect(applicationId).toBe('io.github.augustosc_eu.tunarrlineup');
    expect(gradle).toContain(`namespace = "${applicationId}"`);
    const shortcuts = read('app/src/main/res/xml/shortcuts.xml');
    expect(shortcuts).toContain(`android:targetPackage="${applicationId}"`);
    expect(shortcuts).toContain(`android:action="${applicationId}.CHANGE_SERVER"`);
    expect(read(`app/src/main/java/${applicationId!.replaceAll('.', '/')}/MainActivity.java`)).toContain(`ACTION_CHANGE_SERVER = "${applicationId}.CHANGE_SERVER"`);
  });

  it('is versioned from package.json, so 2026.10.15 becomes 20261015', () => {
    expect(gradle).toContain('rootDir.resolve("../package.json")');
    expect(gradle).toContain('versionCode = year * 10000 + month * 100 + release');
    const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const [year, month, release] = version.split('.').map(Number);
    expect(month).toBeLessThan(100);
    expect(release).toBeLessThan(100);
    expect(year * 10000 + month * 100 + release).toBeLessThan(2_100_000_000); // Android's versionCode limit
  });

  it('asks only for the internet, and shows on phones, tablets and Android TV', () => {
    expect(manifest.match(/uses-permission android:name="([^"]+)"/g)).toEqual(['uses-permission android:name="android.permission.INTERNET"']);
    expect(manifest).toContain('android.intent.category.LEANBACK_LAUNCHER');
    expect(manifest).toContain('android:name="android.hardware.touchscreen" android:required="false"');
    expect(manifest).toContain('android:banner="@drawable/banner"');
    expect(manifest).toContain('android:allowBackup="false"');
  });

  it('gives the page no bridge into the app and no local files (invariant 1)', () => {
    const java = read('app/src/main/java/io/github/augustosc_eu/tunarrlineup/MainActivity.java');
    expect(java).not.toContain('addJavascriptInterface');
    expect(java).toContain('setAllowFileAccess(false)');
    expect(java).toContain('setAllowContentAccess(false)');
    expect(java).toContain('ServerAddress.isSameOrigin(origin, url.toString())');
  });
});
