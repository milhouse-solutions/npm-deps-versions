# NPM Deps Versions

<p align="center">
  <img src="icon.png">
</p>

## Features

This extension adds a codelense above each dependency in package.json file to show the latest version of the dependency on npmjs.com.
If there is a newer version of the dependency, you can directly upgrade to the specific version by clicking on the codelense.

## Commands

This extension contributes the following commands:

- `npm-deps-versions.enableCodeLens`: Enable CodeLens
- `npm-deps-versions.disableCodeLens`: Disable Codelens
- `npm-deps-versions.refreshCache`: Refresh Cache

## Extension Settings

This extension contributes the following settings:

- `npm-deps-versions.enableCodeLens`: Show CodeLens for available dependency upgrades.
- `npm-deps-versions.enableReleaseCandidateUpgrades`: Search for release candidate versions.
- `npm-deps-versions.enableBetaUpgrades`: Search for beta versions.
- `npm-deps-versions.enableAlphaUpgrades`: Search for alpha versions.
- `npm-deps-versions.enableDevUpgrades`: Search for developer versions.

## Known Issues

- No support for private packages (not possible)
