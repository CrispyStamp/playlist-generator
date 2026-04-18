const fetch = require('node-fetch');

async function getAccessToken() {
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Spotify environment variables (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN)');
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

async function addTracksToPlaylist(accessToken, playlistId, trackUris) {
  // Spotify max 100 tracks per request
  for (let i = 0; i < trackUris.length; i += 100) {
    const chunk = trackUris.slice(i, i + 100);
    const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: chunk })
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(`Failed to add tracks: ${data.error?.message || response.status}`);
    }
  }
}

async function getArtistTopTracks(accessToken, artistId, limit) {
  const response = await fetch(
    `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(`Spotify ${response.status} for artist ${artistId}`);
  // Guard: data.tracks may be missing if the response shape is unexpected
  if (!Array.isArray(data.tracks)) throw new Error(`Unexpected response shape for artist ${artistId}`);
  return data.tracks.slice(0, limit).map(t => t.uri);
}

// Run an array of async tasks in parallel batches to avoid Spotify rate limits.
async function batchSettled(items, batchSize, asyncFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(asyncFn));
    results.push(...batchResults);
  }
  return results;
}

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
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Artists array is required and must not be empty' }) };
    }
    if (!playlistName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Playlist name is required' }) };
    }

    const accessToken = await getAccessToken();
    const userId      = await getUserId(accessToken);
    const playlist    = await createSpotifyPlaylist(
      accessToken, userId, playlistName,
      playlistDescription || 'Created with EDC Playlist Generator'
    );

    const limit        = Math.max(1, Math.min(10, tracksPerArtist || 5));
    const validArtists = artists.filter(a => a.spotifyId);
    console.log(`Fetching tracks for ${validArtists.length} artists in batches of 20…`);

    // Fetch in batches of 20 — fast enough, but won't trigger Spotify's rate limiter
    const trackResults = await batchSettled(validArtists, 20, a =>
      getArtistTopTracks(accessToken, a.spotifyId, limit)
    );

    const allTrackUris = [];
    let failCount = 0;
    trackResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allTrackUris.push(...result.value);
      } else {
        failCount++;
        console.error(`  ✗ ${validArtists[i].name}: ${result.reason?.message}`);
      }
    });
    console.log(`Tracks collected: ${allTrackUris.length} (${failCount} artists failed)`);

    if (allTrackUris.length > 0) {
      await addTracksToPlaylist(accessToken, playlist.id, allTrackUris);
    }

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
          trackCount: allTrackUris.length
        }
      })
    };

  } catch (error) {
    console.error('create-playlist fatal error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Failed to create playlist' })
    };
  }
};
