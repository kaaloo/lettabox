#!/usr/bin/env bash
# Re-sign the single commit release-please creates above the triggering main
# commit, so release PRs satisfy required-signatures enforcement. Any other
# branch shape is refused rather than rewritten.
set -euo pipefail

if [[ -z "${GIT_SIGNING_KEY:-}" ]]; then
  echo "GIT_SIGNING_KEY is required to sign the release commit" >&2
  exit 1
fi
if [[ -z "${PRS:-}" ]]; then
  echo "release-please did not provide PR metadata" >&2
  exit 1
fi

# Read the branches release-please actually opened instead of deriving branch
# names, which differ between single-package and multi-package repositories.
if ! printf '%s' "$PRS" | jq -e 'type == "array" and length > 0 and all(.[]; (.headBranchName | type == "string" and length > 0))' >/dev/null; then
  echo "release-please returned no valid headBranchName list" >&2
  exit 1
fi
branches="$(printf '%s' "$PRS" | jq -r '.[].headBranchName')"
printf 'Signing %d release branch(es):\n%s\n' \
  "$(printf '%s\n' "$branches" | wc -l)" "$branches"

signing_key="$RUNNER_TEMP/release-signing-key"
allowed_signers="$RUNNER_TEMP/release-allowed-signers"
trap 'rm -f "$signing_key" "$signing_key.pub" "$allowed_signers"' EXIT
umask 077
if [[ "$GIT_SIGNING_KEY" == *"-----BEGIN"* ]]; then
  printf '%s\n' "$GIT_SIGNING_KEY" > "$signing_key"
else
  printf '%s' "$GIT_SIGNING_KEY" | tr -d '\n' | base64 --decode > "$signing_key"
  printf '\n' >> "$signing_key"
fi
ssh-keygen -y -f "$signing_key" > "$signing_key.pub"

signing_email="kaaloo@gmail.com"
git config user.name "Luis Arias"
git config user.email "$signing_email"
git config gpg.format ssh
git config user.signingkey "$signing_key"
git config commit.gpgsign true
git config gpg.ssh.allowedSignersFile "$allowed_signers"
printf '%s %s\n' "$signing_email" "$(< "$signing_key.pub")" > "$allowed_signers"

while IFS= read -r release_branch; do
  [[ -n "$release_branch" && "$release_branch" != "null" ]] || continue
  echo "::group::Sign $release_branch"

  git fetch origin "+refs/heads/$release_branch:refs/remotes/origin/$release_branch"
  git checkout --detach "origin/$release_branch"

  # Exactly one new release commit above the triggering main commit is valid.
  if [[ "$(git show -s --format=%P HEAD)" != "$GITHUB_SHA" ]]; then
    echo "Refusing to sign $release_branch: release commit is not a single commit on $GITHUB_SHA" >&2
    exit 1
  fi

  original_commit="$(git rev-parse HEAD)"
  git commit --amend --no-edit
  git verify-commit HEAD
  git push --force-with-lease="refs/heads/$release_branch:$original_commit" origin "HEAD:refs/heads/$release_branch"
  echo "::endgroup::"
done <<< "$branches"
