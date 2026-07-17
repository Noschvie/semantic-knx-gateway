#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Noschvie
# KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

# run-unit-tests.sh
#
# Quick-start wrapper for test-tunnel-options.js
# Runs KNX IP Secure Unit Tests immediately – no setup required.
#
# Usage:
#   bash run-unit-tests.sh
#   or
#   ./run-unit-tests.sh (after chmod +x)

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TEST_FILE="$SCRIPT_DIR/test-tunnel-options.js"

if [[ ! -f "$TEST_FILE" ]]; then
    echo "Error: test-tunnel-options.js not found in $SCRIPT_DIR"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

echo "Running KNX IP Secure Unit Tests..."
echo ""

node "$TEST_FILE"
