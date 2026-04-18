#!/usr/bin/env node
/**
 * build-track-cache.js
 *
 * Run once locally to pre-fetch the top 10 Spotify track URIs for every
 * artist in edc_artists.json and save them to netlify/functions/track_cache.json
 *
 * Usage:  node build-track-cache.js
 *
 * Requires your .env file to be present in the same folder.
 */

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

// ── Load .env ──────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env file not found — make sure it exists in the project root.');
  }
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) return;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) process.env[key] = val;
  });
}

// ── Spotify helpers ────────────────────────────────────────────────────────
async function getAccessToken() {
  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret, SPOTIFY_REFRESH_TOKEN: rt } = process.env;
  if (!id || !secret || !rt) throw new Error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REFRESH_TOKEN in .env');

  const res  = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  return data.access_token;
}

async function fetchTopTracks(token, artistId, retries = 3) {
  const res  = await fetch(
    `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  // Rate limited — wait and retry
  if (res.status === 429 && retries > 0) {
    const wait = parseInt(res.headers.get('Retry-After') || '2', 10) * 1000;
    await sleep(wait);
    return fetchTopTracks(token, artistId, retries - 1);
  }

  const data = await res.json();
  if (!res.ok) throw new Error(`Spotify ${res.status} for ${artistId}`);
  if (!Array.isArray(data.tracks)) return [];
  return data.tracks.slice(0, 10).map(t => t.uri);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  loadEnv();

  const artistsPath = path.join(__dirname, 'edc_artists.json');
  if (!fs.existsSync(artistsPath)) throw new Error('edc_artists.json not found.');
  const artists = JSON.parse(fs.readFileSync(artistsPath, 'utf8'));
  const names   = Object.keys(artists);

  console.log(`\nBuilding track cache for ${names.length} artists…\n`);

  const token = await getAccessToken();
  console.log('✓ Spotify token obtained\n');

  const cache     = {};
  const BATCH     = 25;   // parallel requests per batch
  const DELAY_MS  = 150;  // pause between batches to stay under rate limits
  let   succeeded = 0;
  let   skipped   = 0;
  let   failed    = 0;

  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);

    await Promise.allSettled(
      batch.map(async name => {
        const artist = artists[name];
        if (!artist.id) {
          cache[name] = [];
          skipped++;
          return;
        }
        try {
          cache[name] = await fetchTopTracks(token, artist.id);
          succeeded++;
        } catch (err) {
          console.warn(`  ✗ ${name}: ${err.message}`);
          cache[name] = [];
          failed++;
        }
      })
    );

    const done = Math.min(i + BATCH, names.length);
    process.stdout.write(`  Progress: ${done}/${names.length}\r`);

    if (i + BATCH < names.length) await sleep(DELAY_MS);
  }

  // ── Write output ──────────────────────────────────────────────────────
  const outDir  = path.join(__dirname, 'netlify', 'functions');
  const outPath = path.join(outDir, 'track_cache.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(cache, null, 2));

  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\n\n✓ Done!`);
  console.log(`  Artists with tracks : ${succeeded}`);
  console.log(`  Skipped (no ID)     : ${skipped}`);
  console.log(`  Failed              : ${failed}`);
  console.log(`  Output              : netlify/functions/track_cache.json (${kb} KB)\n`);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
