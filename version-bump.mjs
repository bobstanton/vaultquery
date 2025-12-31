import { readFileSync, writeFileSync } from 'fs';

// Read package.json to get the new version
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const targetVersion = packageJson.version;

// Update manifest.json
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t'));

// Update versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));

console.log(`Version bumped to ${targetVersion}`);
