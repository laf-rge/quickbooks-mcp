Publish a new version of quickbooks-mcp to npm and the MCP Registry.

## Arguments

$ARGUMENTS should be the version bump type: `patch`, `minor`, or `major`.
If no argument is provided, ask the user which bump type they want (patch, minor, or major) before proceeding.

## Steps

### 1. Pre-flight checks

- Verify the working directory is clean (`git status` shows no uncommitted changes). If there are uncommitted changes, stop and ask the user to commit or stash them first.
- Verify `npm whoami` succeeds (user is logged into npm).
- Start from an up-to-date master and branch off it — **this repo never commits directly to `master`**, releases included:
  ```
  git fetch origin && git switch -c chore/release-{new_version} origin/master
  ```

### 2. Version bump

- Read the current version from `package.json`.
- Compute the new version based on the bump type argument (patch/minor/major) using semver rules.
- Update the `version` field in `package.json`.
- Update both the top-level `version` and `packages[0].version` fields in `server.json` to match.
- Show the user: "Bumping version: {old} -> {new}" and confirm before proceeding.

### 3. Build verification

- Run `npm run build` and verify it completes without errors.
- If the build fails, stop and show the errors. Do not proceed with publishing.

### 4. Open the release PR

The version bump lands on master through review like any other change.

- Stage `package.json`, `package-lock.json`, and `server.json`.
- Commit with message: `v{new_version}`
- Push the branch and open a PR titled `v{new_version}` summarizing what ships in the release.
- **Stop here and wait for the user to merge.** Do not merge it yourself.

### 5. Publish to npm

Only proceed after the release PR is merged. Switch back to master and pull first,
so the published artifact matches the merged tree:

```
git switch master && git fetch origin && git pull
```

npm publish requires passkey authentication via browser. Do NOT run `npm publish`
directly — it will fail waiting for interactive auth.

- Tell the user to run `npm publish` themselves in their terminal.
- Wait for the user to confirm it succeeded before continuing.

### 6. Tag the release

Only proceed after the user confirms npm publish succeeded. The tag goes on the
merge commit, not on the release branch.

- Create a git tag: `git tag v{new_version}`
- Push it: `git push --tags`

### 7. Publish to MCP Registry

- Run `mcp-publisher publish` from the repo root.
- If it fails with a 401/expired token, tell the user to re-authenticate and publish manually:
  ```
  mcp-publisher login github
  mcp-publisher publish
  ```
- Wait for the user to confirm before continuing.

### 8. Summary

Print a summary:
```
Published quickbooks-mcp v{new_version}
  npm: https://www.npmjs.com/package/quickbooks-mcp
  MCP Registry: https://registry.modelcontextprotocol.io/
  GitHub: https://github.com/laf-rge/quickbooks-mcp
```
