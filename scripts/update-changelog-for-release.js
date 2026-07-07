#!/usr/bin/env node

/**
 * Update CHANGELOG.md for a release: rename "Unreleased" section to a dated version.
 * Usage: node scripts/update-changelog-for-release.js <version>
 * Example: node scripts/update-changelog-for-release.js v2026.07.07
 *
 * The script will:
 * - Extract date from version string (v2026.07.07 -> 2026-07-07)
 * - Replace "Unreleased" header with dated header
 * - Verify the change was made successfully
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const version = process.argv[2];

if (!version) {
  console.error('❌ Error: Version argument required (e.g., v2026.07.07)');
  process.exit(1);
}

// Extract date from version: v2026.07.07 -> 2026-07-07
const dateMatch = version.match(/v?(\d{4})\.(\d{2})\.(\d{2})/);
if (!dateMatch) {
  console.error(`❌ Error: Invalid version format "${version}" (expected: v2026.07.07)`);
  process.exit(1);
}

const [, year, month, day] = dateMatch;
const releaseDate = `${year}-${month}-${day}`;

const changelogPath = path.resolve(__dirname, '../CHANGELOG.md');

if (!fs.existsSync(changelogPath)) {
  console.error(`❌ Error: CHANGELOG.md not found at ${changelogPath}`);
  process.exit(1);
}

let content = fs.readFileSync(changelogPath, 'utf-8');
const originalContent = content;

// Replace "Unreleased" header with dated header
// Match "Unreleased\n----------" pattern (Keep a Changelog format)
const unreleasePattern = /^Unreleased\s*\n-+\s*\n/m;

if (!unreleasePattern.test(content)) {
  console.error('❌ Error: Could not find "Unreleased" section in CHANGELOG.md');
  console.error('Expected format:');
  console.error('Unreleased');
  console.error('----------');
  process.exit(1);
}

// Replace with dated section
// Keep "Unreleased" at the top, add new dated section below it
content = content.replace(
  unreleasePattern,
  `Unreleased\n----------\n\n${releaseDate}\n${'-'.repeat(releaseDate.length)}\n\n`
);

// Verify the replacement was made
if (content === originalContent) {
  console.error('❌ Error: CHANGELOG.md was not modified');
  process.exit(1);
}

// Write back
fs.writeFileSync(changelogPath, content, 'utf-8');

console.log(`✅ Successfully updated CHANGELOG.md`);
console.log(`   Renamed "Unreleased" → "${releaseDate}"`);
console.log(`   Created new "Unreleased" section for next release`);







