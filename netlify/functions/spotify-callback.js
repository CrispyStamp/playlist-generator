const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  const { code } = event.queryStringParameters || {};

  if (!code) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Authorization code not provided' })
    };
  }
  
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  
  const isLocal = process.env.NETLIFY_DEV === 'true';
  const redirectUri = isLocal 
    ? 'http://127.0.0.1:8888/.netlify/functions/spotify-callback'
    : 'https://festivalplaylistgenerator.netlify.app/.netlify/functions/spotify-callback';

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(tokenData.error_description || 'Failed to get access token');
    }

    // Return HTML page with instructions to save the tokens
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html'
      },
      body: `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Spotify Authorization Success</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              max-width: 800px;
              margin: 50px auto;
              padding: 20px;
              background-color: #f5f5f5;
            }
            .container {
              background: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .success {
              color: #1DB954;
              font-size: 24px;
              margin-bottom: 20px;
            }
            .token-box {
              background: #f9f9f9;
              border: 1px solid #ddd;
              padding: 15px;
              border-radius: 4px;
              margin: 10px 0;
              font-family: monospace;
              word-break: break-all;
            }
            .label {
              font-weight: bold;
              margin-top: 20px;
              margin-bottom: 5px;
            }
            .warning {
              background: #fff3cd;
              border: 1px solid #ffc107;
              padding: 15px;
              border-radius: 4px;
              margin-top: 20px;
            }
            code {
              background: #f4f4f4;
              padding: 2px 6px;
              border-radius: 3px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✓ Authorization Successful!</div>
            
            <p>You've successfully authorized your Spotify account. Now you need to save these tokens as environment variables in Netlify:</p>
            
            <div class="label">Access Token (expires in 1 hour):</div>
            <div class="token-box">${tokenData.access_token}</div>
            
            <div class="label">Refresh Token (use this to get new access tokens):</div>
            <div class="token-box">${tokenData.refresh_token}</div>
            
            <div class="warning">
              <strong>⚠️ Important Instructions:</strong>
              <ol>
                <li>Go to your Netlify site dashboard</li>
                <li>Navigate to: Site settings → Environment variables</li>
                <li>Add these variables:
                  <ul>
                    <li><code>SPOTIFY_REFRESH_TOKEN</code> = (paste the refresh token above)</li>
                  </ul>
                </li>
                <li>Keep these tokens secret - don't share them!</li>
                <li>The refresh token doesn't expire, so you only need to do this once</li>
              </ol>
            </div>
            
            <p style="margin-top: 20px;">After adding the environment variable, your app will be able to create playlists automatically!</p>
          </div>
        </body>
        </html>
      `
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to exchange authorization code',
        details: error.message 
      })
    };
  }
};
