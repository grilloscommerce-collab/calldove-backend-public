require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const { Encoder } = require('mu-law');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 
'mongodb+srv://calldove:Calldove2026@calldove-cluster.cgsphj9.mongodb.net/calldove?retryWrites=true&w=majority';
let db = null;

async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('calldove');
  console.log('MongoDB connected');
  return db;
}

connectDB().catch(console.error);

const LANGS = {
  es: 'Spanish',
  en: 'English',
  zh: 'Mandarin Chinese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  nl: 'Dutch',
  ru: 'Russian'
};

const callLanguages = new Map();

// AUTH ENDPOINTS
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, phone } = req.body;
    const database = await connectDB();
    const users = database.collection('users');
    
    const existing = await users.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    const user = {
      email,
      password,
      phone,
      createdAt: new Date(),
      verified: false
    };
    
    const result = await users.insertOne(user);
    console.log('New user registered:', email);
    
    res.json({ success: true, userId: result.insertedId });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const database = await connectDB();
    const users = database.collection('users');
    
    const user = await users.findOne({ email, password });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    console.log('Login successful:', email);
    
    res.json({ 
      success: true, 
      user: { 
        email: user.email, 
        phone: user.phone,
        userId: user._id
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/', (req, res) => {
  res.send('CallDove Backend Running');
});

app.post('/voice', (req, res) => {
  const src = req.query.source || 'es';
  const tgt = req.query.target || 'en';
  const callSid = req.body.CallSid;

  callLanguages.set(callSid, { source: src, target: tgt });
  console.log(`Call ${callSid}: ${src} <-> ${tgt}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media" />
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

const server = app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
});

const wss = new WebSocket.Server({ server, path: '/media' });

wss.on('connection', (twilioWs, req) => {
  console.log('Twilio WS connected');
  let callSid = null;
  let openaiWs = null;
  let streamSid = null;
  let src = 'es';
  let tgt = 'en';

  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === 'start') {
        callSid = data.start.callSid;
        streamSid = data.start.streamSid;

        if (callLanguages.has(callSid)) {
          const langs = callLanguages.get(callSid);
          src = langs.source;
          tgt = langs.target;
          callLanguages.delete(callSid);
        }

        const srcName = LANGS[src] || 'Spanish';
        const tgtName = LANGS[tgt] || 'English';
        console.log(`Connection: ${srcName} <-> ${tgtName}`);

        openaiWs = new 
WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        });

        openaiWs.on('open', () => {
          console.log('OpenAI WS connected');
          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['audio', 'text'],
              instructions: `You are a real-time translator. The user speaks ${srcName}. 
You must respond ONLY in ${tgtName}. Translate their message naturally and 
conversationally into ${tgtName}. Do not add extra commentary, just translate.`,
              voice: 'shimmer',
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              turn_detection: { type: 'server_vad' }
            }
          }));
        });

        openaiWs.on('message', (data) => {
          try {
            const event = JSON.parse(data);
            if (event.type === 'response.audio.delta' && event.delta) {
              twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: event.delta }
              }));
            }
          } catch (err) {
            console.error('OpenAI message error:', err);
          }
        });

        openaiWs.on('error', (err) => console.error('OpenAI error:', err));
        openaiWs.on('close', () => console.log('OpenAI WS closed'));
      }

      if (data.event === 'media' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: data.media.payload
        }));
      }

      if (data.event === 'stop') {
        console.log('Call ended');
        if (openaiWs) openaiWs.close();
      }
    } catch (err) {
      console.error('Twilio message error:', err);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WS closed');
    if (openaiWs) openaiWs.close();
  });
});
