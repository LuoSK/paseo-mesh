# Releasing

Releases are cut from `main` by pushing a `vX.Y.Z` tag. The `Release` workflow checks that the tag matches `package.json`, runs every check including the end-to-end suite, publishes to npm when the `NPM_TOKEN` secret is set, and creates a GitHub release from the matching `CHANGELOG.md` section.

## Steps

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading and update the compare links.
2. Bump the version in `package.json` and `shared/version.ts` (`npm test` fails if they differ), then run `npm install` to refresh the lockfile.
3. If the release needs newer Paseo APIs, raise `requirements.paseo` in `paseo-plugin.json` and the `@getpaseo/*` ranges together. Keep `PASEO_CLIENT_APP_VERSION` equal to the `@getpaseo/client` range floor.
4. Run the checks locally (see [CONTRIBUTING.md](../CONTRIBUTING.md)), commit, and push to `main`.
5. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Versions with a prerelease suffix (`1.2.0-beta.1`) publish under the npm `next` tag and are marked as prereleases on GitHub.

## npm

Create an npm automation token with publish rights for `paseo-mesh` and store it as the repository secret `NPM_TOKEN`. Without it the workflow skips publishing and still creates the GitHub release; users can install from Git.

## Paseo registry

To list the plugin on [paseo.sh/plugins](https://paseo.sh/plugins), follow the submission guide in [getpaseo/plugins](https://github.com/getpaseo/plugins) with the released commit. `OVERVIEW.md` is the listing text; update it in the same release when behavior users see changes.

## Compatibility

The `Paseo compatibility` workflow runs weekly against the newest `@getpaseo/*` packages. When it fails, fix the incompatibility, raise the dependency ranges, and release.
