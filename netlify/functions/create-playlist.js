const fetch = require('node-fetch');

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

async function getArtistTopTracks(accessToken, artistId, limit) {
  const response = await fetch(
    `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(`Spotify ${response.status} for ${artistId}`);
  if (!Array.isArray(data.tracks)) throw new Error(`Unexpected response for ${artistId}`);
  return data.tracks.slice(0, limit).map(t => t.uri);
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
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Artists array is required' }) };
    }
    if (!playlistName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Playlist name is required' }) };
    }

    const limit        = Math.max(1, Math.min(10, tracksPerArtist || 5));
    const validArtists = artists.filter(a => a.spotifyId);

    // ── Step 1-3: token, user ID, playlist creation  (sequential, ~1s total)
    const accessToken = await getAccessToken();
    const [userId, ] = await Promise.all([getUserId(accessToken)]);
    const playlist    = await createSpotifyPlaylist(
      accessToken, userId, playlistName,
      playlistDescription || 'Created with EDC Playlist Generator'
    );

    console.log(`Fetching top tracks for ${validArtists.length} artists (all parallel)…`);
    const t0 = Date.now();

    // ── Step 4: fetch ALL artists' top tracks simultaneously (~500ms in prod)
    const trackResults = await Promise.allSettled(
      validArtists.map(a => getArtistTopTracks(accessToken, a.spotifyId, limit))
    );

    const allTrackUris = [];
    let failCount = 0;
    trackResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allTrackUris.push(...result.value);
      } else {
        failCount++;
        console.warn(`  ✗ ${validArtists[i]?.name}: ${result.reason?.message}`);
      }
    });
    console.log(`Tracks fetched: ${allTrackUris.length} in ${Date.now()-t0}ms (${failCount} artists failed)`);

    // ── Step 5: add tracks in 100-uri chunks, all chunks in parallel (~200ms in prod)
    if (allTrackUris.length > 0) {
      const chunks = [];
      for (let i = 0; i < allTrackUris.length; i += 100) chunks.push(allTrackUris.slice(i, i + 100));
      console.log(`Adding ${allTrackUris.length} tracks in ${chunks.length} parallel chunks…`);
      await Promise.all(chunks.map(chunk => addChunkToPlaylist(accessToken, playlist.id, chunk)));
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
    console.error('create-playlist error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Failed to create playlist' })
    };
  }
};
