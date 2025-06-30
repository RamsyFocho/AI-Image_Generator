   const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:5000/auth/google/callback'
);

const SCOPES = ['https://www.googleapis.com/auth/photoslibrary.appendonly'];

// GET /auth/google
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  res.redirect(url);
});

// GET /auth/google/callback
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  // Send token to frontend securely, or store in session
  res.redirect(`http://localhost:3000?access_token=${tokens.access_token}`);
});

// Upload handler
const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.single('image'), async (req, res) => {
  const { accessToken } = req.body;
  const filePath = req.file.path;
  const fileName = req.file.originalname;

  try {
    const imageBuffer = fs.readFileSync(filePath);
    const uploadRes = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
      method: 'POST',
      headers: {
        'Content-type': 'application/octet-stream',
        'X-Goog-Upload-File-Name': fileName,
        'X-Goog-Upload-Protocol': 'raw',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: imageBuffer,
    });

    const uploadToken = await uploadRes.text();

    const createRes = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-type': 'application/json',
      },
      body: JSON.stringify({
        newMediaItems: [{
          description: "Synced from React app",
          simpleMediaItem: {
            uploadToken,
          },
        }],
      }),
    });

    const result = await createRes.json();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).send('Upload failed');
  } finally {
    fs.unlinkSync(filePath);
  }
});

app.listen(5000, () => {
  console.log('Server running on http://localhost:5000');
});
