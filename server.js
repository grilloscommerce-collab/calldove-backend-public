require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const BASE_URL = process.env.BASE_URL || 'https://talk2-backend.onrender.com';

let db = null;
const activeCalls = new Map();
const activeWebSockets = new Map();

async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('talk2');
  console.log('MongoDB connected');
  return db;
}

const languageMap = {
  'es': 'Spanish', 'en': 'English', 'zh': 'Chinese',
  'fr': 'French', 'de': 'German', 'it': 'Italian',
  'pt': 'Portuguese', 'ja': 'Japanese', 'ko': 'Korean',
  'ar': 'Arabic', 'hi': 'Hindi'
};

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, phone, preferredLanguage } = req.body;
    const db = await connectDB();
    const existing = await db.collection('users').findOne({ email });
    if (existing) return res.json({ error: 'User already exists' });
    const result = await db.collection('users').insertOne({
      email, password, phone, verified: false,
      preferredLanguage: preferredLanguage || 'en', createdAt: new Date()
    });
    res.json({ success: true, userId: result.insertedId.toString() });
  } catch (e) { res.json({ error: 'Registration failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = await connectDB();
    const user = await db.collection('users').findOne({ email, password });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ success: true, user: { email: user.email, phone: user.phone, userId: user._id.toString(), preferredLanguage: user.preferredLanguage || 'en' } });
  } catch (e) { res.json({ error: 'Login failed' }); }
});

app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { phone } = req.body;
    await twilioClient.verify.v2.services('VAfda39f88eaabea55df09f201fa193108').verifications.create({ to: phone, channel: 'sms' });
    res.json({ success: true });
  } catch (e) { res.json({ error: 'Failed to send code' }); }
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    const v = await twilioClient.verify.v2.services('VAfda39f88eaabea55df09f201fa193108').verificationChecks.create({ to: phone, code });
    if (v.status === 'approved') {
      const db = await connectDB();
      await db.collection('users').updateOne({ phone }, { $set: { verified: true } });
      res.json({ success: true });
    } else { res.json({ error: 'Invalid code' }); }
  } catch (e) { res.json({ error: 'Verification failed' }); }
});

app.post('/api/call/initiate', async (req, res) => {
  try {
    const { userPhone, targetPhone, sourceLanguage } = req.body;
    const cleanTarget = targetPhone.replace(/[\s\(\)\-]/g, '');
    const callId = Date.now().toString();

    // Save to BOTH memory AND MongoDB
    const callData = {
      callId,
      userPhone,
      targetPhone: cleanTarget,
      userLanguage: sourceLanguage,
      targetLanguage: sourceLanguage === 'es' ? 'en' : 'es',
      userCallSid: null,
      targetCallSid: null,
      createdAt: new Date()
    };

    activeCalls.set(callId, { ...callData, userAudioBuffer: [], targetAudioBuffer: [] });

    const db = await connectDB();
    await db.collection('activecalls').insertOne(callData);

    console.log('Initiating call:', callId);

    const call = await twilioClient.calls.create({
      url: BASE_URL + '/voice-stream-user?callId=' + callId,
      to: userPhone,
      from: process.env.TWILIO_PHONE_NUMBER
    });

    res.json({ success: true, callSid: call.sid, callId });
  } catch (e) {
    console.error('Call error:', e);
    res.json({ error: e.message });
  }
});

async function getCallData(callId) {
  // Try memory first
  if (activeCalls.has(callId)) return activeCalls.get(callId);
  
  // Fall back to MongoDB
  console.log('Loading call from MongoDB:', callId);
  const db = await connectDB();
  const data = await db.collection('activecalls').findOne({ callId });
  if (data) {
    const callData = { ...data, userAudioBuffer: [], targetAudioBuffer: [] };
    activeCalls.set(callId, callData);
    return callData;
  }
  return null;
}

app.post('/voice-stream-user', async (req, res) => {
  try {
    const callId = req.query.callId;
    const callData = await getCallData(callId);

    if (!callData) {
      console.log('No call data for:', callId);
      res.type('text/xml');
      res.send('<Response><Say>Call not found</Say><Hangup /></Response>');
      return;
    }

    callData.userCallSid = req.body.CallSid;
    
    // Update MongoDB
    const db = await connectDB();
    await db.collection('activecalls').updateOne({ callId }, { $set: { userCallSid: req.body.CallSid } });

    console.log('User connected:', callId, 'SID:', req.body.CallSid);

    const wsUrl = BASE_URL.replace('https://', 'wss://') + '/media-stream?callId=' + callId + '&role=user';
    console.log('WS URL for user:', wsUrl);

    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Start><Stream url="${wsUrl}" /></Start><Pause length="3600"/></Response>`);

    setTimeout(async () => {
      try {
        const targetCall = await twilioClient.calls.create({
          url: BASE_URL + '/voice-stream-target?callId=' + callId,
          to: callData.targetPhone,
          from: process.env.TWILIO_PHONE_NUMBER
        });
        console.log('Target call initiated:', targetCall.sid);
      } catch (err) {
        console.error('Target call FAILED:', err.message);
      }
    }, 3000);

  } catch (e) {
    console.error('voice-stream-user error:', e);
    res.type('text/xml');
    res.send('<Response><Hangup /></Response>');
  }
});

app.post('/voice-stream-target', async (req, res) => {
  try {
    const callId = req.query.callId;
    const callData = await getCallData(callId);

    if (!callData) {
      res.type('text/xml');
      res.send('<Response><Hangup /></Response>');
      return;
    }

    callData.targetCallSid = req.body.CallSid;

    const db = await connectDB();
    await db.collection('activecalls').updateOne({ callId }, { $set: { targetCallSid: req.body.CallSid } });

    console.log('Target connected:', callId, 'SID:', req.body.CallSid);

    const wsUrl = BASE_URL.replace('https://', 'wss://') + '/media-stream?callId=' + callId + '&role=target';
    console.log('WS URL for target:', wsUrl);

    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Start><Stream url="${wsUrl}" /></Start><Pause length="3600"/></Response>`);

  } catch (e) {
    console.error('voice-stream-target error:', e);
    res.type('text/xml');
    res.send('<Response><Hangup /></Response>');
  }
});

async function processAudioChunk(audioData, callId, role) {
  const callData = await getCallData(callId);
  if (!callData) return;

  try {
    const tmpFile = '/tmp/audio_' + Date.now() + '.wav';
    fs.writeFileSync(tmpFile, audioData);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1'
    });

    fs.unlinkSync(tmpFile);

    if (!transcription.text || transcription.text.trim().length === 0) return;

    console.log(role + ' said:', transcription.text);

    const targetLang = role === 'user' ? callData.targetLanguage : callData.userLanguage;

    const translation = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Translate to ' + languageMap[targetLang] + '. Output ONLY the translation.' },
        { role: 'user', content: transcription.text }
      ],
      temperature: 0.3
    });

    const translatedText = translation.choices[0].message.content.trim();
    console.log('Translated:', translatedText);

    // Get latest SIDs from MongoDB
    const db = await connectDB();
    const freshData = await db.collection('activecalls').findOne({ callId });
    const targetCallSid = role === 'user' ? freshData?.targetCallSid : freshData?.userCallSid;

    if (targetCallSid) {
      const safeText = translatedText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await twilioClient.calls(targetCallSid).update({
        twiml: '<Response><Say>' + safeText + '</Say><Pause length="1"/></Response>'
      });
      console.log('Translation played to', role === 'user' ? 'target' : 'user');
    } else {
      console.log('No targetCallSid yet for role:', role);
    }
  } catch (e) {
    console.error('processAudioChunk error:', e.message);
  }
}

app.post('/api/messages/send-simple', async (req, res) => {
  try {
    const { senderPhone, recipientPhone, text, senderLanguage } = req.body;
    const targetLanguage = 'en';
    let translatedText = text;
    if (senderLanguage !== targetLanguage) {
      const t = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'system', content: 'Translate to English' }, { role: 'user', content: text }],
        temperature: 0.3
      });
      translatedText = t.choices[0].message.content.trim();
    }
    res.json({ success: true, message: { _id: Date.now().toString(), senderPhone, recipientPhone, originalText: text, translatedText, createdAt: new Date().toISOString() } });
  } catch (e) { res.json({ error: 'Failed' }); }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const callId = url.searchParams.get('callId');
  const role = url.searchParams.get('role');

  console.log('WS connected - callId:', callId, 'role:', role);

  if (!callId || !role) {
    console.log('WS closing - missing params. Full URL:', req.url);
    ws.close();
    return;
  }

  getCallData(callId).then(callData => {
    if (!callData) {
      console.log('WS closing - no callData for:', callId);
      ws.close();
      return;
    }

    console.log('Media stream ACTIVE:', callId, role);

    ws.on('message', async (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event === 'start') console.log('Stream started:', role);

        if (msg.event === 'media') {
          const audioBuffer = role === 'user' ? callData.userAudioBuffer : callData.targetAudioBuffer;
          audioBuffer.push(msg.media.payload);
          if (audioBuffer.length >= 150) {
            const audioData = Buffer.from(audioBuffer.join(''), 'base64');
            audioBuffer.length = 0;
            console.log('Processing audio from', role);
            processAudioChunk(audioData, callId, role).catch(console.error);
          }
        }

        if (msg.event === 'stop') console.log('Stream stopped:', role);
      } catch (e) {
        console.error('WS message error:', e);
      }
    });

    ws.on('close', () => console.log('WS closed:', role));
  });
});

server.listen(PORT, () => {
  console.log('Talk2 Server running on port ' + PORT);
  console.log('WebSocket ready');
});
