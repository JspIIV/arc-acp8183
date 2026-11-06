#!/usr/bin/env bash
# Fetches the pinned Solidity dependencies into contracts/lib (git-ignored).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p lib
[ -d lib/forge-std ] || git clone --quiet --depth 1 --branch v1.17.0 https://github.com/foundry-rs/forge-std lib/forge-std
[ -d lib/openzeppelin-contracts ] || git clone --quiet --depth 1 --branch v5.7.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
echo "dependencies ready"
