import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const mode = process.argv[2]
const validModes = new Set(['debug', 'release'])

if (!validModes.has(mode)) {
  console.error('Usage: node scripts/package-android-apk.mjs <debug|release>')
  process.exit(1)
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(scriptDir, '..')
const androidDir = join(rootDir, 'android')
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))

function commandName(command) {
  return process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command
}

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  })

  if (result.error) {
    console.error(result.error.message)
    process.exit(result.status ?? 1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function versionCodeFrom(versionName) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(versionName)
  if (!match) {
    throw new Error(`Cannot derive Android versionCode from package version "${versionName}"`)
  }

  const [, major, minor, patch] = match.map(Number)
  return major * 10000 + minor * 100 + patch
}

function requireReleaseSigningEnv() {
  const required = [
    'HIVEKEEP_ANDROID_KEYSTORE',
    'HIVEKEEP_ANDROID_KEY_ALIAS',
    'HIVEKEEP_ANDROID_KEYSTORE_PASSWORD',
  ]
  const missing = required.filter((name) => !process.env[name])

  if (missing.length > 0) {
    console.error(`Missing release signing environment variable(s): ${missing.join(', ')}`)
    console.error('Set them before running the release APK script. HIVEKEEP_ANDROID_KEY_PASSWORD is optional and defaults to HIVEKEEP_ANDROID_KEYSTORE_PASSWORD.')
    process.exit(1)
  }

  if (!existsSync(process.env.HIVEKEEP_ANDROID_KEYSTORE)) {
    console.error(`Keystore file not found: ${process.env.HIVEKEEP_ANDROID_KEYSTORE}`)
    process.exit(1)
  }
}

const versionName = process.env.HIVEKEEP_ANDROID_VERSION_NAME || packageJson.version
const versionCode = process.env.HIVEKEEP_ANDROID_VERSION_CODE || String(versionCodeFrom(versionName))

if (!/^\d+$/.test(versionCode) || Number(versionCode) <= 0) {
  console.error(`HIVEKEEP_ANDROID_VERSION_CODE must be a positive integer; received "${versionCode}"`)
  process.exit(1)
}

if (mode === 'release') {
  requireReleaseSigningEnv()
}

const npmExecPath = process.env.npm_execpath || ''
const npmUserAgent = process.env.npm_config_user_agent || ''
const packageRunner = npmUserAgent.startsWith('bun') || npmExecPath.toLowerCase().includes('bun') ? 'bun' : 'npm'
run(commandName(packageRunner), ['run', 'mobile:sync'])

const gradleCommand = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
const gradleTask = mode === 'debug' ? 'assembleDebug' : 'assembleRelease'
const gradleArgs = [
  gradleTask,
  `-PhivekeepVersionName=${versionName}`,
  `-PhivekeepVersionCode=${versionCode}`,
]

run(gradleCommand, gradleArgs, { cwd: androidDir })

const apkPath = join(
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  mode,
  mode === 'debug' ? 'app-debug.apk' : 'app-release.apk',
)
console.log(`\nAPK created: ${apkPath}`)
console.log(`Version: ${versionName} (${versionCode})`)
