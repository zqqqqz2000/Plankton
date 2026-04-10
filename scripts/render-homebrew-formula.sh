#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <version> <github-repository> <checksums-file>" >&2
  exit 1
fi

version="$1"
github_repository="$2"
checksums_file="$3"
formula_class="PlanktonCli"
binary_name="plankton-cli"
homepage_url="https://github.com/${github_repository}"
release_base_url="https://github.com/${github_repository}/releases/download/v${version}"

lookup_sha() {
  local archive_name="$1"
  awk -v file="$archive_name" '$2 == file { print $1; exit }' "$checksums_file"
}

darwin_arm_archive="${binary_name}-v${version}-aarch64-apple-darwin.tar.gz"
darwin_amd_archive="${binary_name}-v${version}-x86_64-apple-darwin.tar.gz"
linux_amd_archive="${binary_name}-v${version}-x86_64-unknown-linux-gnu.tar.gz"

darwin_arm_sha="$(lookup_sha "$darwin_arm_archive")"
darwin_amd_sha="$(lookup_sha "$darwin_amd_archive")"
linux_amd_sha="$(lookup_sha "$linux_amd_archive")"

for checksum in "$darwin_arm_sha" "$darwin_amd_sha" "$linux_amd_sha"; do
  if [ -z "$checksum" ]; then
    echo "missing checksum in ${checksums_file}" >&2
    exit 1
  fi
done

cat <<EOF
class ${formula_class} < Formula
  desc "Read-only CLI for Plankton access attempts, request inspection, and audit queries"
  homepage "${homepage_url}"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${release_base_url}/${darwin_arm_archive}"
      sha256 "${darwin_arm_sha}"
    else
      url "${release_base_url}/${darwin_amd_archive}"
      sha256 "${darwin_amd_sha}"
    end
  end

  on_linux do
    url "${release_base_url}/${linux_amd_archive}"
    sha256 "${linux_amd_sha}"
  end

  def install
    bin.install "${binary_name}"
    prefix.install_metafiles "LICENSE", "README.md"
  end

  test do
    help = shell_output("#{bin}/${binary_name} --help")
    assert_match "read-only", help
  end
end
EOF
