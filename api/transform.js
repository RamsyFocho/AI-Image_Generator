import { createClient } from '@supabase/supabase-js';
import Replicate from 'replicate';
import jwt from 'jsonwebtoken';

// Helper to convert ReadableStream to Buffer
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image, prompt } = req.body;
  const authHeader = req.headers.authorization;

  let accessToken = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    accessToken = authHeader.split(' ')[1];
  }
  if (!accessToken) {
    return res.status(401).json({ error: 'Missing or invalid access token' });
  }

  // Decode JWT for userId
  let userId;
  try {
    const decodedToken = jwt.decode(accessToken);
    userId = decodedToken?.sub;
    if (!userId) throw new Error('User ID not found in token');
  } catch (error) {
    return res.status(400).json({ error: 'Invalid token', details: error.message });
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

  if (!image || !prompt) {
    return res.status(400).json({ error: 'Missing image or prompt' });
  }

  try {
    // Test Supabase connectivity
    const { error: supabaseError } = await userSupabase.storage
      .from('user-images')
      .list('', { limit: 1 });
    if (supabaseError) {
      return res.status(500).json({
        error: 'Supabase is not accessible. Cannot continue.',
        details: supabaseError.message,
      });
    }

    // Run Replicate image transformation
    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN,
    });
    const output = await replicate.run('black-forest-labs/flux-kontext-pro', {
      input: {
        prompt: prompt,
        input_image: image,
        output_format: 'jpg',
      },
    });
    const imageBuffer = await streamToBuffer(output);

    // Upload to Supabase
    const filePath = `${userId}/transform-${Date.now()}.jpg`;
    const { error: uploadError } = await userSupabase.storage
      .from('user-images')
      .upload(filePath, imageBuffer, {
        contentType: 'image/jpeg',
        cacheControl: '3600',
        upsert: false,
      });
    if (uploadError) {
      return res.status(500).json({
        error: 'Failed to upload to Supabase',
        details: uploadError.message,
      });
    }
    const { data: urlData } = userSupabase.storage
      .from('user-images')
      .getPublicUrl(filePath);
    return res.status(200).json({ transformedImage: urlData?.publicUrl });
  } catch (error) {
    return res.status(500).json({
      error: 'Image transformation failed',
      details: error.message,
    });
  }
}
