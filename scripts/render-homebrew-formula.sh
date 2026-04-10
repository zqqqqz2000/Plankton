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

source_archive="plankton-v${version}-source.tar.gz"
source_sha="$(lookup_sha "$source_archive")"

if [ -z "$source_sha" ]; then
  echo "missing checksum for ${source_archive} in ${checksums_file}" >&2
  exit 1
fi

cat <<EOF
class ${formula_class} < Formula
  desc "Read-only CLI for Plankton access attempts, request inspection, and audit queries"
  homepage "${homepage_url}"
  version "${version}"
  license "MIT"
  url "${release_base_url}/${source_archive}"
  sha256 "${source_sha}"

  depends_on "rust" => :build

  def install
    system "cargo", "install", "--locked", "--path", "crates/plankton-cli", "--root", prefix
    prefix.install_metafiles "LICENSE", "README.md"
  end

  test do
    help = shell_output("#{bin}/${binary_name} --help")
    assert_match "read-only", help
  end
end
EOF
