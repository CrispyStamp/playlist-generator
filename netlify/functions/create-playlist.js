const fetch = require('node-fetch');

async function getAccessToken() {
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

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
  if (!response.ok) throw new Error('Failed to get user profile');
  return data.id;
}

async function createPlaylist(accessToken, userId, name, description, isPublic = true) {
  const response = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, public: isPublic })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Failed to create playlist: ${data.error?.message || 'Unknown error'}`);
  return data;
}

async function addTracksToPlaylist(accessToken, playlistId, trackUris) {
  const chunks = [];
  for (let i = 0; i < trackUris.length; i += 100) chunks.push(trackUris.slice(i, i + 100));
  for (const chunk of chunks) {
    const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: chunk })
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(`Failed to add tracks: ${data.error?.message || 'Unknown error'}`);
    }
  }
}

async function getArtistTopTracks(accessToken, artistId, limit = 5) {
  const response = await fetch(
    `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(`Failed to get top tracks for ${artistId}`);
  return data.tracks.slice(0, limit).map(track => track.uri);
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
    const playlist    = await createPlaylist(
      accessToken, userId, playlistName,
      playlistDescription || 'Created with EDC Playlist Generator', true
    );

    const limit           = tracksPerArtist || 5;
    const validArtists    = artists.filter(a => a.spotifyId);

    // Fetch all artists' top tracks IN PARALLEL instead of one-by-one.
    // This cuts execution time from (N × ~200ms) down to ~200ms flat,
    // well within Netlify's 10-second function timeout.
    const trackResults = await Promise.allSettled(
      validArtists.map(a => getArtistTopTracks(accessToken, a.spotifyId, limit))
    );

    const allTrackUris = [];
    trackResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allTrackUris.push(...result.value);
      } else {
        console.error(`Failed to get tracks for ${validArtists[i].name}:`, result.reason);
      }
    });

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
    console.error('Error creating playlist:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to create playlist', details: error.message })
    };
  }
};
