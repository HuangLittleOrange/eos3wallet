'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { removeAndroidSigning } = require('./android-unsigned.cjs');
const { installPublicDependencies } = require('./native-install.cjs');
const root = path.resolve(__dirname, '..');
const stage = path.dirname(root);
const mode = process.argv[2];
const policy = JSON.parse(fs.readFileSync(path.join(root, 'native-build-policy.json')));
const reviewAbi = process.env.EOS3_ANDROID_ABI;
if (reviewAbi && reviewAbi !== 'arm64-v8a') throw new Error('Unsupported emulator architecture.');

function run(command, args, cwd = root) {
  const started = Date.now();
  console.log(`Starting ${path.basename(command)} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native ${args[0]} step failed (${result.status ?? result.signal}).`);
  console.log(`Finished ${path.basename(command)} in ${Math.round((Date.now() - started) / 1000)}s`);
}

async function main() {
  if (mode === 'install') {
    run('node', ['scripts/dependency-policy.cjs']);
    await installPublicDependencies(root);
    run('npm', ['audit', 'signatures']);
  } else if (mode === 'build' || mode === 'cache') {
    run('npm', ['run', 'patch:dependencies']);
    if (mode === 'build') {
      run('npm', ['test', '--', '--runInBand']);
      run('npm', ['run', 'typecheck']);
      run('npm', ['run', 'test:update-native']);
    }
    run('node', ['node_modules/expo/bin/cli', 'prebuild', '--platform', 'android', '--no-install', '--template', './node_modules/expo/template.tgz']);
    const android = path.join(root, 'android');
    const buildFile = path.join(android, 'app/build.gradle');
    fs.writeFileSync(buildFile, removeAndroidSigning(fs.readFileSync(buildFile, 'utf8')));
    fs.rmSync(path.join(android, 'app/debug.keystore'), { force: true });
    const wrapper = path.join(android, 'gradle/wrapper/gradle-wrapper.jar');
    if (crypto.createHash('sha256').update(fs.readFileSync(wrapper)).digest('hex') !== policy.gradle.wrapperJarSha256) throw new Error('Unapproved Gradle wrapper.');
    const wrapperProperties = path.join(android, 'gradle/wrapper/gradle-wrapper.properties');
    const properties = fs.readFileSync(wrapperProperties, 'utf8');
    if (!properties.includes(`gradle-${policy.gradle.version}-bin.zip`)) throw new Error('Gradle version changed.');
    fs.writeFileSync(wrapperProperties, properties + `\ndistributionSha256Sum=${policy.gradle.sha256}\n`);
    fs.appendFileSync(path.join(android, 'gradle.properties'), `\norg.gradle.daemon=false\norg.gradle.parallel=true\norg.gradle.workers.max=4\norg.gradle.console=plain\nkotlin.compiler.execution.strategy=in-process\norg.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m -XX:-UsePerfData -Djava.io.tmpdir=${path.join(stage, 'tmp')}\n`);
    fs.writeFileSync(path.join(android, 'local.properties'), `sdk.dir=${process.env.ANDROID_HOME}\n`);
    const gradle = path.join(stage, `gradle-${policy.gradle.version}`, 'bin/gradle');
    if (mode === 'cache') {
      const init = path.join(stage, 'resolve-public.gradle');
      // Resolve external tool/app artifacts without requesting project build
      // outputs. Configuration plugins still execute inside this sandbox.
      fs.writeFileSync(init, `allprojects { p ->\n  tasks.register('resolvePublicArtifacts') {\n    doLast {\n      p.configurations.findAll { it.canBeResolved && (it.name.toLowerCase().contains('release') || it.name.toLowerCase().contains('lint') || it.name.toLowerCase().contains('prefab') || it.name.toLowerCase().contains('compilerclasspath') || it.name.toLowerCase().contains('buildtoolsapiclasspath')) }.each { c ->\n        c.incoming.artifactView { componentFilter { it instanceof org.gradle.api.artifacts.component.ModuleComponentIdentifier } }.files.files\n      }\n    }\n  }\n}\n`);
      // AGP creates some tool configurations lazily inside task actions.
      // Preload their exact artifacts too: Prefab uses the shaded "all" JAR,
      // not an unclassified CLI artifact. No native task is executed here.
      fs.appendFileSync(init, `allprojects { p ->\n  if (p == p.rootProject) {\n    tasks.named('resolvePublicArtifacts').configure {\n      doLast {\n        ${JSON.stringify(policy.mavenBuildTools)}.each { coordinate ->\n          def tools = p.configurations.detachedConfiguration(p.dependencies.create(coordinate))\n          tools.attributes.attribute(org.gradle.api.attributes.Usage.USAGE_ATTRIBUTE, p.objects.named(org.gradle.api.attributes.Usage, org.gradle.api.attributes.Usage.JAVA_RUNTIME))\n          tools.attributes.attribute(org.gradle.api.attributes.java.TargetJvmEnvironment.TARGET_JVM_ENVIRONMENT_ATTRIBUTE, p.objects.named(org.gradle.api.attributes.java.TargetJvmEnvironment, org.gradle.api.attributes.java.TargetJvmEnvironment.STANDARD_JVM))\n          tools.resolve()\n        }\n      }\n    }\n  }\n}\n`);
      // Task-graph preparation also resolves lazy tool dependencies such as
      // Android lint. Dry run performs no APK compilation or signing.
      run(gradle, ['--no-daemon', '--stacktrace', '--max-workers=4', '-Pkotlin.compiler.execution.strategy=in-process', '--dry-run', ':app:assembleRelease'], android);
      run(gradle, ['--no-daemon', '--stacktrace', '--max-workers=4', '-Pkotlin.compiler.execution.strategy=in-process', '--init-script', init, 'resolvePublicArtifacts'], android);
      process.exit(0);
    }
    run(gradle, ['--offline', '--no-daemon', '--stacktrace', '--max-workers=4', '-Pkotlin.compiler.execution.strategy=in-process',
      ...(reviewAbi ? [`-PreactNativeArchitectures=${reviewAbi}`] : []), ':app:assembleRelease'], android);
    const unsigned = path.join(android, 'app/build/outputs/apk/release/app-release-unsigned.apk');
    if (!fs.existsSync(unsigned)) throw new Error('Expected an unsigned release APK.');
    fs.copyFileSync(unsigned, path.join(stage, 'app-release-unsigned.apk'));
  } else throw new Error('Use install or build.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
