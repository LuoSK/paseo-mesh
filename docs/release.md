# Releasing

Releases are cut from `main` by pushing a `vX.Y.Z` tag. The `Release` workflow checks that the tag matches `package.json`, runs every check including the end-to-end suite, publishes to npm through trusted publishing, and creates a GitHub release from the matching `CHANGELOG.md` section.

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

The workflow publishes with [trusted publishing](https://docs.npmjs.com/trusted-publishers): npm accepts the job's GitHub OIDC token, so there is no npm token secret, and every release carries provenance. The trust relationship is bound to this repository and the `release.yml` workflow filename; renaming the workflow breaks publishing until the relationship is updated:

```bash
npx npm@latest trust list paseo-mesh
npx npm@latest trust github paseo-mesh --file release.yml --repository jtsang4/paseo-mesh --allow-publish
```

Both commands need an npm login with 2FA; older npm 11 releases answer the second with a bare `400`. A version that is already on npm is skipped, so re-running a release only creates the GitHub release.

npm reviews new versions before they go live. The publish request returns `202 Accepted`, the package page shows a holding version for a few minutes, and `npm view` may lag behind. Wait for `npm view paseo-mesh@X.Y.Z version` before announcing a release.

## Paseo registry

To list the plugin on [paseo.sh/plugins](https://paseo.sh/plugins), follow the submission guide in [getpaseo/plugins](https://github.com/getpaseo/plugins) with the released commit. `OVERVIEW.md` is the listing text; update it in the same release when behavior users see changes.

## Compatibility

The `Paseo compatibility` workflow runs weekly against the newest `@getpaseo/*` packages. When it fails, fix the incompatibility, raise the dependency ranges, and release.
