#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// test-tunnel-options.js
//
// Unit tests for tunnel-options.js createTunnelOptions() function.
// Tests Classic and KNX IP Secure mode configurations, error scenarios.
// Runs standalone – no hardware connection required.
//
// Spec §11 Scenarios:
//   ✓ Classic Mode (TunnelUDP)
//   ✓ Classic Mode (TunnelTCP)
//   ✓ Secure Mode (valid keyring)
//   ✗ Secure Mode (missing keyring file)
//   ✗ Secure Mode (missing password)
//   ✗ Secure Mode (invalid keyring path)

import fs from 'fs';
import path from 'path';
import { createTunnelOptions } from './tunnel-options.js';

// ===== Test Infrastructure =====

const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
};

function timestamp() {
    return new Date().toISOString().split('T')[1].slice(0, 8);
}

function pass(msg) {
    console.log(`[${timestamp()}] ${colors.green}✓${colors.reset} ${msg}`);
}

function fail(msg) {
    console.log(`[${timestamp()}] ${colors.red}✗${colors.reset} ${msg}`);
}

function info(msg) {
    console.log(`[${timestamp()}] ${colors.blue}ℹ${colors.reset} ${msg}`);
}

function error(msg) {
    console.log(`[${timestamp()}] ${colors.red}✗${colors.reset} ${colors.red}${msg}${colors.reset}`);
}

function section(title) {
    console.log(`\n${colors.bold}${colors.blue}${title}${colors.reset}`);
    console.log(colors.dim + '─'.repeat(60) + colors.reset);
}

// ===== Simple Logger Mock =====

class TestLogger {
    constructor(testName) {
        this.testName = testName;
    }

    info(msg) {
        info(`[${this.testName}] ${msg}`);
    }

    warn(msg) {
        console.log(`[${timestamp()}] ${colors.yellow}⚠${colors.reset} [${this.testName}] ${msg}`);
    }

    debug(msg) {
        // Suppress debug logs in tests
    }

    error(msg) {
        error(`[${this.testName}] ${msg}`);
    }
}

// ===== Test Cases =====

let passedTests = 0;
let failedTests = 0;

function testCase(name, fn) {
    try {
        fn();
        pass(name);
        passedTests++;
    } catch (e) {
        fail(`${name}: ${e.message}`);
        failedTests++;
    }
}

function assertObjectHasProperty(obj, prop, msg) {
    if (!(prop in obj)) {
        throw new Error(`${msg || `Property "${prop}" not found`}`);
    }
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg || 'Assertion failed'}: expected "${expected}", got "${actual}"`);
    }
}

function assertFalse(val, msg) {
    if (val !== false) {
        throw new Error(`${msg || 'Assertion failed'}: expected false, got ${val}`);
    }
}

function assertThrows(fn, expectedMsg, msg) {
    try {
        fn();
        throw new Error(`${msg || 'Expected exception'}: none was thrown`);
    } catch (e) {
        if (expectedMsg && !e.message.includes(expectedMsg)) {
            throw new Error(
                `${msg || 'Wrong exception'}: expected "${expectedMsg}", got "${e.message}"`
            );
        }
    }
}

// ===== Tests =====

section('Test 1: Classic Mode (TunnelUDP) – Default Configuration');

testCase('KNX_SECURE_ENABLED unset, KNX_HOST_PROTOCOL unset → defaults to TunnelUDP', () => {
    delete process.env.KNX_SECURE_ENABLED;
    delete process.env.KNX_HOST_PROTOCOL;
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-1');
    const opts = createTunnelOptions(logger);

    assertEqual(opts.hostProtocol, 'TunnelUDP', 'Protocol should be TunnelUDP');
    assertFalse(opts.isSecureKNXEnabled, 'isSecureKNXEnabled should be false');
    assertEqual(opts.ipAddr, '192.168.1.1', 'ipAddr mismatch');
    assertEqual(opts.ipPort, 3671, 'ipPort mismatch');
});

testCase('KNX_SECURE_ENABLED=false, KNX_HOST_PROTOCOL=TunnelUDP → Classic TunnelUDP', () => {
    process.env.KNX_SECURE_ENABLED = 'false';
    process.env.KNX_HOST_PROTOCOL = 'TunnelUDP';
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-1b');
    const opts = createTunnelOptions(logger);

    assertEqual(opts.hostProtocol, 'TunnelUDP', 'Protocol should be TunnelUDP');
    assertFalse(opts.isSecureKNXEnabled, 'isSecureKNXEnabled should be false');
});

section('Test 2: Classic Mode (TunnelTCP) – Explicit TCP Configuration');

testCase('KNX_SECURE_ENABLED=false, KNX_HOST_PROTOCOL=TunnelTCP → Classic TunnelTCP', () => {
    process.env.KNX_SECURE_ENABLED = 'false';
    process.env.KNX_HOST_PROTOCOL = 'TunnelTCP';
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-2');
    const opts = createTunnelOptions(logger);

    assertEqual(opts.hostProtocol, 'TunnelTCP', 'Protocol should be TunnelTCP');
    assertFalse(opts.isSecureKNXEnabled, 'isSecureKNXEnabled should be false');
});

section('Test 3: Secure Mode – Valid Keyring Setup');

testCase('KNX_SECURE_ENABLED=true, valid keyring file, valid password → Secure TunnelTCP', () => {
    // Create a temporary dummy keyring file for testing
    const tmpDir = '/tmp';
    const keyringPath = path.join(tmpDir, 'test-keyring.knxkeys');
    fs.writeFileSync(keyringPath, 'DUMMY_KEYRING_CONTENT');

    process.env.KNX_SECURE_ENABLED = 'true';
    process.env.KNX_HOST_PROTOCOL = 'TunnelUDP'; // Will be forced to TCP
    process.env.KNX_KEYRING_FILE = keyringPath;
    process.env.KNX_KEYRING_PASSWORD = 'test-password';
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-3');
    const opts = createTunnelOptions(logger);

    assertEqual(opts.hostProtocol, 'TunnelTCP', 'Protocol should be forced to TunnelTCP');
    assertEqual(opts.isSecureKNXEnabled, true, 'isSecureKNXEnabled should be true');
    assertObjectHasProperty(opts, 'secureTunnelConfig', 'secureTunnelConfig missing');
    assertEqual(
        opts.secureTunnelConfig.knxkeys_file_path,
        keyringPath,
        'Keyring file path mismatch'
    );
    assertEqual(
        opts.secureTunnelConfig.knxkeys_password,
        'test-password',
        'Keyring password mismatch'
    );

    // Cleanup
    fs.unlinkSync(keyringPath);
});

section('Test 4: Secure Mode – Error: Missing Keyring File');

testCase('KNX_SECURE_ENABLED=true, no KNX_KEYRING_FILE → throws error', () => {
    process.env.KNX_SECURE_ENABLED = 'true';
    delete process.env.KNX_KEYRING_FILE;
    process.env.KNX_KEYRING_PASSWORD = 'test-password';
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-4');
    assertThrows(
        () => createTunnelOptions(logger),
        'KNX_KEYRING_FILE',
        'Should throw error for missing KNX_KEYRING_FILE'
    );
});

section('Test 5: Secure Mode – Error: Missing Password');

testCase('KNX_SECURE_ENABLED=true, no KNX_KEYRING_PASSWORD → throws error', () => {
    const tmpDir = '/tmp';
    const keyringPath = path.join(tmpDir, 'test-keyring2.knxkeys');
    fs.writeFileSync(keyringPath, 'DUMMY_KEYRING_CONTENT');

    process.env.KNX_SECURE_ENABLED = 'true';
    process.env.KNX_KEYRING_FILE = keyringPath;
    delete process.env.KNX_KEYRING_PASSWORD;
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-5');
    assertThrows(
        () => createTunnelOptions(logger),
        'KNX_KEYRING_PASSWORD',
        'Should throw error for missing KNX_KEYRING_PASSWORD'
    );

    // Cleanup
    fs.unlinkSync(keyringPath);
});

section('Test 6: Secure Mode – Error: Keyring File Not Found');

testCase('KNX_SECURE_ENABLED=true, keyring file does not exist → throws error', () => {
    process.env.KNX_SECURE_ENABLED = 'true';
    process.env.KNX_KEYRING_FILE = '/nonexistent/path/to/keyring.knxkeys';
    process.env.KNX_KEYRING_PASSWORD = 'test-password';
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-6');
    assertThrows(
        () => createTunnelOptions(logger),
        'not found on disk',
        'Should throw error for nonexistent keyring file'
    );
});

section('Test 7: Secure Mode – Verify TCP Forced Even If UDP Requested');

testCase('KNX_SECURE_ENABLED=true, KNX_HOST_PROTOCOL=TunnelUDP → forces TunnelTCP', () => {
    const tmpDir = '/tmp';
    const keyringPath = path.join(tmpDir, 'test-keyring3.knxkeys');
    fs.writeFileSync(keyringPath, 'DUMMY_KEYRING_CONTENT');

    process.env.KNX_SECURE_ENABLED = 'true';
    process.env.KNX_HOST_PROTOCOL = 'TunnelUDP';
    process.env.KNX_KEYRING_FILE = keyringPath;
    process.env.KNX_KEYRING_PASSWORD = 'test-password';
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-7');
    const opts = createTunnelOptions(logger);

    assertEqual(opts.hostProtocol, 'TunnelTCP', 'Protocol must be forced to TunnelTCP for Secure');

    // Cleanup
    fs.unlinkSync(keyringPath);
});

section('Test 8: Environment Variable Parsing – Boolean Edge Cases');

testCase('KNX_SECURE_ENABLED="1" → treated as true', () => {
    process.env.KNX_SECURE_ENABLED = '1';
    delete process.env.KNX_HOST_PROTOCOL;

    const tmpDir = '/tmp';
    const keyringPath = path.join(tmpDir, 'test-keyring4.knxkeys');
    fs.writeFileSync(keyringPath, 'DUMMY_KEYRING_CONTENT');

    process.env.KNX_KEYRING_FILE = keyringPath;
    process.env.KNX_KEYRING_PASSWORD = 'test-password';
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-8');
    const opts = createTunnelOptions(logger);

    assertEqual(opts.isSecureKNXEnabled, true, 'KNX_SECURE_ENABLED="1" should enable Secure');

    // Cleanup
    fs.unlinkSync(keyringPath);
});

testCase('KNX_SECURE_ENABLED="yes" → treated as true', () => {
    process.env.KNX_SECURE_ENABLED = 'yes';

    const tmpDir = '/tmp';
    const keyringPath = path.join(tmpDir, 'test-keyring5.knxkeys');
    fs.writeFileSync(keyringPath, 'DUMMY_KEYRING_CONTENT');

    process.env.KNX_KEYRING_FILE = keyringPath;
    process.env.KNX_KEYRING_PASSWORD = 'test-password';
    process.env.KNX_GATEWAY_IP = '192.168.1.1';
    process.env.KNX_GATEWAY_PORT = '3671';
    process.env.KNX_GATEWAY_PHYS_ADDR = '1.1.1';

    const logger = new TestLogger('TEST-8b');
    const opts = createTunnelOptions(logger);

    assertEqual(opts.isSecureKNXEnabled, true, 'KNX_SECURE_ENABLED="yes" should enable Secure');

    // Cleanup
    fs.unlinkSync(keyringPath);
});

// ===== Summary =====

section('Test Summary');
const total = passedTests + failedTests;
const pct = total > 0 ? Math.round((passedTests / total) * 100) : 0;

if (failedTests === 0) {
    console.log(
        `${colors.green}${colors.bold}✓ All ${passedTests} tests passed (${pct}%)${colors.reset}`
    );
    process.exit(0);
} else {
    console.log(
        `${colors.red}${colors.bold}✗ ${failedTests} of ${total} tests failed (${pct}% passed)${colors.reset}`
    );
    process.exit(1);
}
