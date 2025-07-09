import express from "express";
import cors from "cors";
import Replicate from "replicate";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";
import { extname } from "path";
import { writeFile } from "fs/promises";
import { GoogleGenAI } from '@google/genai';
// import mime from 'mime';
import { PassThrough } from "stream";
import jwt from "jsonwebtoken"; // Add this at the top to decode JWT
// Load env variables
dotenv.config();
import { google } from 'googleapis';

import multer from 'multer';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.BACKEND_URL}/auth/google/callback` // Use env var for backend URL
);
const SCOPES = ['https://www.googleapis.com/auth/photoslibrary.appendonly'];


// Initialize Replicate
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// // Initialize Supabase
// const supabase = createClient(
//   process.env.SUPABASE_URL,
//   process.env.SUPABASE_SERVICE_ROLE_KEY
// );

// Setup Express
const app = express();
const PORT = 5000;
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// Helper function to convert ReadableStream to Buffer
async function streamToBuffer(stream) {
  const chunks = [];
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

app.post("/api/transform", async (req, res) => {
  const { image, prompt } = req.body;
  const authHeader = req.headers.authorization; // e.g., "Bearer <token>"

  // Optional: Extract token if needed
  let accessToken = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    accessToken = authHeader.split(" ")[1];
  }

  if (!accessToken) {
    return res.status(401).json({ error: "Missing or invalid access token" });
  }

  // Decode the JWT to extract the user ID
  let userId;
  try {
    const decodedToken = jwt.decode(accessToken);
    userId = decodedToken?.sub; // Assuming the user ID is in the 'sub' field

    if (!userId) {
      throw new Error("User ID not found in token");
    }
  } catch (error) {
    return res.status(400).json({ error: "Invalid token", details: error.message });
  }

  // Create Supabase client for the user
  const userSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    }
  );

  // Validate required fields
  if (!image || !prompt) {
    return res.status(400).json({ error: "Missing image or prompt" });
  }

  try {
    // ✅ 1. Test Supabase connectivity BEFORE anything else
    const { error: supabaseError } = await userSupabase.storage
      .from("user-images")
      .list("", { limit: 1 });

    if (supabaseError) {
      console.error("❌ Supabase connection failed:", supabaseError.message);
      return res.status(500).json({
        error: "Supabase is not accessible. Cannot continue.",
        details: supabaseError.message,
      });
    }

    // ✅ 2. Run Replicate image transformation
    const output = await replicate.run("black-forest-labs/flux-kontext-pro", {
      input: {
        prompt: prompt,
        input_image: image,
        output_format: "jpg",
      },
    });

    console.log("✅ Image generated from Replicate");

    // ✅ 3. Convert stream to buffer
    const imageBuffer = await streamToBuffer(output);

    // Optional: Save to disk for debugging
    // await writeFile("output.jpg", imageBuffer);
    // console.log("✅ Image saved locally");

    // ✅ 4. Upload to Supabase
    const filePath = `${userId}/transform-${Date.now()}-${uuidv4()}.jpg`;

    const { error: uploadError } = await userSupabase.storage
      .from("user-images")
      .upload(filePath, imageBuffer, {
        contentType: "image/jpeg",
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("❌ Supabase upload failed:", uploadError.message);
      return res.status(500).json({
        error: "Failed to upload to Supabase",
        details: uploadError.message,
      });
    }

    // ✅ 5. Return public URL
    const { data: urlData } = userSupabase.storage
      .from("user-images")
      .getPublicUrl(filePath);

    console.log("✅ Upload successful:", urlData?.publicUrl);
    res.status(200).json({ transformedImage: urlData?.publicUrl });
  } catch (error) {
    console.error("❌ Transform error:", error);
    res.status(500).json({
      error: "Image transformation failed",
      details: error.message,
    });
  }
});

// 🧪 Optional endpoint to verify Supabase works
app.get("/api/test-supabase", async (_, res) => {
  try {
    const { data, error } = await userSupabase.storage
      .from("user-images")
      .list("", { limit: 1 });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      error: "Supabase connection failed",
      details: error.message,
    });
  }
});

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
  res.redirect(`${process.env.FRONTEND_URL}?access_token=${tokens.access_token}`); // Use env var for frontend URL
});
// Upload handler
const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.single('image'), async (req, res) => {
  const { accessToken, albumId } = req.body;
  const filePath = req.file.path;
  const imageBuffer = fs.readFileSync(filePath);
  const fileName = req.file.originalname;

  try {
    // Step 1: Upload image bytes
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

    // Step 2: Create media item in specified album
    const createRes = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-type': 'application/json',
      },
      body: JSON.stringify({
        albumId,
        newMediaItems: [{
          description: 'Uploaded from Gallery App',
          simpleMediaItem: { uploadToken },
        }],
      }),
    });

    const createData = await createRes.json();
    res.json(createData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  } finally {
    fs.unlinkSync(filePath); // Clean up
  }
});

app.post('/create-album', async (req, res) => {
  const { accessToken, albumTitle } = req.body;

  try {
    const createAlbumRes = await fetch('https://photoslibrary.googleapis.com/v1/albums', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: albumTitle }),
    });

    const album = await createAlbumRes.json();
    if (!album.id) throw new Error('Failed to create album');

    res.json({ id: album.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Album creation failed' });
  }
});
//--------------- text to image generation-----------------
// Initialize Google GenAI
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Helper function to generate unique filename
function generateFileName() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `generated-image-${timestamp}-${random}`;
}

// Route: Generate Image
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    console.log('Generating image for prompt:', prompt);

    const config = {
      responseModalities: ['IMAGE', 'TEXT'],
      responseMimeType: 'text/plain',
    };

    const model = 'gemini-2.0-flash-preview-image-generation';
    
    const contents = [
      {
        role: 'user',
        parts: [
          {
            text: prompt.trim(),
          },
        ],
      },
    ];

    const response = await ai.models.generateContentStream({
      model,
      config,
      contents,
    });

    let imageBuffer = null;
    let imageMimeType = null;
    let textResponse = '';

    // Process the streaming response
    for await (const chunk of response) {
      if (!chunk.candidates || !chunk.candidates[0].content || !chunk.candidates[0].content.parts) {
        continue;
      }

      // Check for image data
      if (chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        const inlineData = chunk.candidates[0].content.parts[0].inlineData;
        imageMimeType = inlineData.mimeType;
        imageBuffer = Buffer.from(inlineData.data || '', 'base64');
        console.log('Image generated successfully');
      }
      // Check for text response
      else if (chunk.text) {
        textResponse += chunk.text;
        console.log('Text response:', chunk.text);
      }
    }

    if (imageBuffer && imageMimeType) {
      // Set appropriate headers for image response
      res.set({
        'Content-Type': imageMimeType,
        'Content-Length': imageBuffer.length,
        'Cache-Control': 'no-cache'
      });
      
      // Send the image buffer
      res.send(imageBuffer);
    } else {
      console.error('No image data received from Gemini');
      res.status(500).json({ 
        error: 'Failed to generate image',
        textResponse: textResponse || 'No response received'
      });
    }

  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({ 
      error: 'Internal server error during image generation',
      message: error.message 
    });
  }
});



app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
