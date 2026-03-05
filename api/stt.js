// ── Speech-to-Text Proxy ──
// Accepts audio from the client and transcribes it using Deepgram Nova-2.
// Falls back to OpenAI Whisper if Deepgram is unavailable.
//
// POST /api/stt  (multipart/form-data with "audio" file, or JSON { audio: base64 })
// Response: { success: true, text: "transcribed text", language: "en" }

import { createClient } from '@supabase/supabase-js';

const DEEPGRAM_API_KEY = (process.env.DEEPGRAM_API_KEY || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth ──
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // ── Extract audio ──
  // Expects JSON body with base64-encoded audio and mime type
  const { audio, mimeType } = req.body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: 'Missing audio (base64-encoded)' });
  }

  const audioBuffer = Buffer.from(audio, 'base64');
  if (audioBuffer.length < 100) {
    return res.status(400).json({ error: 'Audio too short' });
  }
  if (audioBuffer.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'Audio too large (max 10MB)' });
  }

  const contentType = mimeType || 'audio/webm';

  // ── Try Deepgram first, then Whisper ──
  try {
    if (DEEPGRAM_API_KEY) {
      const text = await transcribeDeepgram(audioBuffer, contentType);
      return res.json({ success: true, text, provider: 'deepgram' });
    }
    if (OPENAI_API_KEY) {
      const text = await transcribeWhisper(audioBuffer, contentType);
      return res.json({ success: true, text, provider: 'whisper' });
    }
    return res.status(503).json({ error: 'No STT provider configured. Set DEEPGRAM_API_KEY or OPENAI_API_KEY.' });
  } catch (err) {
    console.error('[stt] Transcription error:', err?.message);

    // Fallback: if Deepgram failed and Whisper is available, try Whisper
    if (DEEPGRAM_API_KEY && OPENAI_API_KEY) {
      try {
        const text = await transcribeWhisper(audioBuffer, contentType);
        return res.json({ success: true, text, provider: 'whisper_fallback' });
      } catch (fallbackErr) {
        console.error('[stt] Whisper fallback also failed:', fallbackErr?.message);
      }
    }

    return res.status(502).json({ error: 'Transcription failed' });
  }
}

// ── Deepgram Nova-2 ──
async function transcribeDeepgram(audioBuffer, contentType) {
  const params = new URLSearchParams({
    model: 'nova-2',
    language: 'en',
    smart_format: 'true',
    punctuate: 'true',
  });

  const response = await fetch(
    `https://api.deepgram.com/v1/listen?${params}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': contentType,
      },
      body: audioBuffer,
    }
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Deepgram ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  if (!transcript.trim()) {
    throw new Error('Empty transcript from Deepgram');
  }
  return transcript.trim();
}

// ── OpenAI Whisper ──
async function transcribeWhisper(audioBuffer, contentType) {
  // Whisper expects multipart/form-data
  const ext = contentType.includes('webm') ? 'webm'
    : contentType.includes('m4a') ? 'm4a'
    : contentType.includes('mp4') ? 'mp4'
    : contentType.includes('wav') ? 'wav'
    : 'webm';

  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: contentType });
  formData.append('file', blob, `audio.${ext}`);
  formData.append('model', 'whisper-1');
  formData.append('language', 'en');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Whisper ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const transcript = data.text || '';
  if (!transcript.trim()) {
    throw new Error('Empty transcript from Whisper');
  }
  return transcript.trim();
}
