const extraResources = [
  {
    from: '.',
    to: 'cc-bridge',
    filter: [
      '*.py',
      'backend/**',
      'bootstrap/**',
      'custom_tools/**',
      'docs/**',
      'static/**',
      'requirements.txt',
    ],
  },
]

module.exports = {
  appId: 'local.cc-bridge.desktop',
  productName: 'CC Bridge',
  icon: 'desktop/assets/icon',
  artifactName: `CC-Bridge-${'${version}'}-${'${os}'}-${'${arch}'}.${'${ext}'}`,
  publish: [
    {
      provider: 'github',
      owner: 'ling-kong-ran',
      repo: 'cc-bridge',
    },
  ],
  directories: {
    output: 'release',
  },
  files: [
    'desktop/electron/**',
    'desktop/assets/**',
    'package.json',
  ],
  extraResources,
  asar: true,
  win: {
    icon: 'desktop/assets/icon.ico',
    target: ['nsis'],
  },
  mac: {
    icon: 'desktop/assets/icon.icns',
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
  },
  linux: {
    icon: 'desktop/assets/icon.png',
    target: ['AppImage', 'deb'],
    category: 'Development',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    shortcutName: 'CC Bridge',
    uninstallDisplayName: 'CC Bridge',
  },
}
