const fetch = require('node-fetch');
const path  = require('path');

// Track cache is built once by running: node build-track-cache.js
// It maps artist name → array of up to 10 Spotify track URIs.
let trackCache = {};
try {
  trackCache = require('./track_cache.json');
} catch (e) {
  console.warn('track_cache.json not found — will fall back to live Spotify lookups.');
}

// ── Spotify helpers ────────────────────────────────────────────────────────
async function getAccessToken() {
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Spotify environment variables');
  }

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Failed to refresh token: ${data.error_description || data.error}`);
  return data.access_token;
}

async function getUserId(accessToken) {
  const response = await fetch('https://api.spotify.com/v1/me', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Failed to get user profile: ${data.error?.message || response.status}`);
  return data.id;
}

async function createSpotifyPlaylist(accessToken, userId, name, description) {
  const response = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, public: true })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Failed to create playlist: ${data.error?.message || response.status}`);
  return data;
}

async function addChunkToPlaylist(accessToken, playlistId, uris) {
  const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris })
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(`Failed to add tracks: ${data.error?.message || response.status}`);
  }
}

// Fallback: live lookup used only if an artist is missing from the cache
async function getArtistTopTracks(accessToken, artistId, limit) {
  const response = await fetch(
    `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(`Spotify ${response.status} for ${artistId}`);
  if (!Array.isArray(data.tracks)) return [];
  return data.tracks.slice(0, limit).map(t => t.uri);
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { artists, playlistName, playlistDescription, tracksPerArtist } = JSON.parse(event.body);

    if (!artists || !Array.isArray(artists) || artists.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Artists array is required' }) };
    }
    if (!playlistName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Playlist name is required' }) };
    }

    const limit        = Math.max(1, Math.min(10, tracksPerArtist || 5));
    const validArtists = artists.filter(a => a.spotifyId);
    const usingCache   = Object.keys(trackCache).length > 0;

    console.log(`Creating playlist: "${playlistName}" | ${validArtists.length} artists | ${limit} tracks each | cache: ${usingCache ? 'yes' : 'no'}`);

    const accessToken = await getAccessToken();
    const userId      = await getUserId(accessToken);
    const playlist    = await createSpotifyPlaylist(
      accessToken, userId, playlistName,
      playlistDescription || 'Created with EDC Playlist Generator'
    );

    // ── Collect track URIs ──────────────────────────────────────────────
    const allTrackUris = [];
    const cacheMisses  = [];

    for (const artist of validArtists) {
      if (usingCache && trackCache[artist.name] !== undefined) {
        // Cache hit — instant, no API call needed
        allTrackUris.push(...trackCache[artist.name].slice(0, limit));
      } else {
        // Cache miss — queue for live lookup
        cacheMisses.push(artist);
      }
    }

    // Live lookups for any artists not in the cache (all parallel)
    if (cacheMisses.length > 0) {
      console.log(`Cache misses: ${cacheMisses.length} artists — fetching live…`);
      const results = await Promise.allSettled(
        cacheMisses.map(a => getArtistTopTracks(accessToken, a.spotifyId, limit))
      );
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') allTrackUris.push(...result.value);
        else console.warn(`  ✗ ${cacheMisses[i].name}: ${result.reason?.message}`);
      });
    }

    // ── Add tracks sequentially in chunks of 100 ────────────────────────
    // Sequential (not parallel) to avoid Spotify rate limits on the write endpoint.
    // With the cache, track lookup is instant so this is still fast end-to-end.
    let tracksAdded = 0;
    if (allTrackUris.length > 0) {
      const chunks = [];
      for (let i = 0; i < allTrackUris.length; i += 100) chunks.push(allTrackUris.slice(i, i + 100));
      console.log(`Adding ${allTrackUris.length} tracks in ${chunks.length} sequential chunks…`);
      for (const chunk of chunks) {
        try {
          await addChunkToPlaylist(accessToken, playlist.id, chunk);
          tracksAdded += chunk.length;
        } catch (err) {
          console.warn(`Chunk add failed (${chunk.length} tracks skipped): ${err.message}`);
        }
      }
    }

    console.log(`✓ Playlist created: ${playlist.external_urls.spotify}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        playlist: {
          id:         playlist.id,
          name:       playlist.name,
          url:        playlist.external_urls.spotify,
          uri:        playlist.uri,
          trackCount: tracksAdded
        }
      })
    };

  } catch (error) {
    console.error('create-playlist error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Failed to create playlist' })
    };
  }
};
