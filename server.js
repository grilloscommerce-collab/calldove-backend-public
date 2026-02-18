require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const fs = require('fs');
const { Readable } = require('stream');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

let db = null;

async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('calldove');
  console.log('MongoDB connected');
  return db;
}

const languageMap = {
  'es': { code: 'es', name: 'Spanish' },
  'en': { code: 'en', name: 'English' },
  'zh': { code: 'zh', name: 'Chinese' },
  'fr': { code: 'fr', name: 'French' },
  'de': { code: 'de', name: 'German' },
  'it': { code: 'it', name: 'Italian' },
  'pt': { code: 'pt', name: 'Portuguese' },
  'ja': { code: 'ja', name: 'Japanese' },
  'ko': { code: 'ko', name: 'Korean' },
  'ar': { code: 'ar', name: 'Arabic' },
  'hi': { code: 'hi', name: 'Hindi' }
};

const callLanguages = new Map();

app.get('/', (req, res) => {
  res.send('Calldove Translation Server Running');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString() 
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, phone } = req.body;
    const db = await connectDB();
    
    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.json({ error: 'User already exists' });
    }
    
    const result = await db.collection('users').insertOne({
      email,
      password,
      phone,
      verified: false,
      createdAt: new Date()
    });
    
    res.json({ success: true, userId: result.insertedId.toString() });
  } catch (error) {
    console.error('Registration error:', error);
    res.json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = await connectDB();
    
    const user = await db.collection('users').findOne({ email, password });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    res.json({
      success: true,
      user: {
        email: user.email,
        phone: user.phone,
        userId: user._id.toString()
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.json({ error: 'Login failed' });
  }
});

app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { phone } = req.body;
    
    await twilioClient.verify.v2
      .services('VAfda39f88eaabea55df09f201fa193108')
      .verifications
      .create({ to: phone, channel: 'sms' });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Send verification error:', error);
    res.json({ error: 'Failed to send verification code' });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    
    const verification = await twilioClient.verify.v2
      .services('VAfda39f88eaabea55df09f201fa193108')
      .verificationChecks
      .create({ to: phone, code: code });
    
    if (verification.status === 'approved') {
      const db = await connectDB();
      await db.collection('users').updateOne(
        { phone },
        { $set: { verified: true } }
      );
      res.json({ success: true });
    } else {
      res.json({ error: 'Invalid code' });
    }
  } catch (error) {
    console.error('Verify code error:', error);
    res.json({ error: 'Verification failed' });
  }
});

app.post('/api/generate-token', async (req, res) => {
  try {
    const { userId } = req.body;
    
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: true
    });

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { identity: userId }
    );

    token.addGrant(voiceGrant);

    res.json({
      success: true,
      token: token.toJwt(),
      identity: userId
    });
  } catch (error) {
    console.error('Generate token error:', error);
    res.json({ error: 'Failed to generate token' });
  }
});

app.post('/voice', async (req, res) => {
  const source = req.query.source || 'es';
  const target = req.query.target || 'en';
  const callSid = req.body.CallSid;

  console.log(`Voice webhook - CallSid: ${callSid}, ${source} → ${target}`);
  callLanguages.set(callSid, { source, target });

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Translation ready. Speak in ${languageMap[source].name}.</Say>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="callSid" value="${callSid}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twimlResponse);
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
  console.log('WebSocket connected');
  let callSid = null;
  let streamSid = null;
  let audioBuffer = [];
  let isProcessing = false;
  let langs = { source: 'es', target: 'en' };

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        langs = callLanguages.get(callSid) || { source: 'es', target: 'en' };
        console.log(`Stream started: ${langs.source} → ${langs.target}`);
      }

      if (msg.event === 'media') {
        audioBuffer.push(msg.media.payload);

        if (audioBuffer.length >= 150 && !isProcessing) {
          isProcessing = true;
          const audioToProcess = audioBuffer.slice();
          audioBuffer = [];

          processAudio(audioToProcess, langs, streamSid, ws).finally(() => {
            isProcessing = false;
          });
        }
      }

      if (msg.event === 'stop') {
        console.log('Stream stopped');
      }
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket closed');
    if (callSid) {
      callLanguages.delete(callSid);
    }
  });
});

function mulawToWav(mulawBuffer) {
  const wavHeader = Buffer.alloc(44);
  const dataSize = mulawBuffer.length * 2;
  const fileSize = dataSize + 36;

  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(fileSize, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(8000, 24);
  wavHeader.writeUInt32LE(16000, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(dataSize, 40);

  const mulawTable = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let mulaw = ~i;
    let sign = mulaw & 0x80;
    let exponent = (mulaw >> 4) & 0x07;
    let mantissa = mulaw & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample = sign ? -sample : sample;
    mulawTable[i] = sample;
  }

  const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcmBuffer.writeInt16LE(mulawTable[mulawBuffer[i]], i * 2);
  }

  return Buffer.concat([wavHeader, pcmBuffer]);
}

async function processAudio(audioChunks, langs, streamSid, ws) {
  try {
    console.log(`Processing ${audioChunks.length} audio chunks...`);

    const mulawData = Buffer.from(audioChunks.join(''), 'base64');
    const wavData = mulawToWav(mulawData);
    
    const tmpFile = `/tmp/audio_${Date.now()}.wav`;
    fs.writeFileSync(tmpFile, wavData);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1',
      language: langs.source
    });

    fs.unlinkSync(tmpFile);

    if (!transcription.text || transcription.text.trim().length === 0) {
      console.log('No speech detected');
      return;
    }

    console.log(`Transcribed: "${transcription.text}"`);

    const translation = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{
        role: 'system',
        content: `Translate from ${languageMap[langs.source].name} to ${languageMap[langs.target].name}. Output 
ONLY the translation.`
      }, {
        role: 'user',
        content: transcription.text
      }],
      temperature: 0.3
    });

    const translatedText = translation.choices[0].message.content.trim();
    console.log(`Translated: "${translatedText}"`);

    const speech = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: translatedText,
      response_format: 'mulaw'
    });

    const audioBuffer = Buffer.from(await speech.arrayBuffer());
    const base64Audio = audioBuffer.toString('base64');

    ws.send(JSON.stringify({
      event: 'media',
      streamSid: streamSid,
      media: {
        payload: base64Audio
      }
    }));

    console.log('✅ Translation sent!');
  } catch (error) {
    console.error('Process audio error:', error);
  }
}

const server = app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  console.log('WebSocket upgrade');
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
