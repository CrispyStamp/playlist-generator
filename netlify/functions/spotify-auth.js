const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  
  // Use localhost for local dev, production URL for deployed
  const isLocal = process.env.NETLIFY_DEV === 'true';
  const redirectUri = isLocal 
    ? 'http://127.0.0.1:8888/.netlify/functions/spotify-callback'
    : 'https://festivalplaylistgenerator.netlify.app/.netlify/functions/spotify-callback';

  // Generate authorization URL
  const scopes = [
    'playlist-modify-public',
    'playlist-modify-private',
    'user-read-private'
  ].join(' ');

  const authUrl = `https://accounts.spotify.com/authorize?` +
    `client_id=${clientId}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}`;

  // Redirect to Spotify authorization
  return {
    statusCode: 302,
    headers: {
      Location: authUrl
    }
  };
};
