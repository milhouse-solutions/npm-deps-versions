# NPM Deps Versions

<p align="center">
  <img src="icon.png">
</p>

## Features

This extension adds a codelense above each dependency in package.json file to show the latest version of the dependency on npmjs.com.
If there is a newer version of the dependency, you can directly upgrade to the specific version by clicking on the codelense.

## Extension Settings

This extension contributes the following settings:

- `npm-deps-versions.enableCodeLens`: Enable/disable this extension.
- `npm-deps-versions.enableReleaseCandidateUpgrades`: Enables search for release candidate versions.
- `npm-deps-versions.enableBetaUpgrades`: Enables search for beta versions.
- `npm-deps-versions.enableAlphaUpgrades`: Enables search for alpha versions.
- `npm-deps-versions.enableDevUpgrades`: Enables search for developer versions.

## Known Issues

- Low performance on large package.json files
- No support for private packages (not possible)
