require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { MongoClient, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const https = require('https');
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

async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('talk2');
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

app.get('/', (req, res) => {
  res.send('Talk2 Translation Server - Media Streams Ready');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, phone, preferredLanguage } = req.body;
    const db = await connectDB();
    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) return res.json({ error: 'User already exists' });
    const result = await db.collection('users').insertOne({ email, password, phone, verified: false, preferredLanguage: preferredLanguage || 'en', createdAt: new Date() });
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
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ success: true, user: { email: user.email, phone: user.phone, userId: user._id.toString(), preferredLanguage: user.preferredLanguage || 'en' } });
  } catch (error) {
    console.error('Login error:', error);
    res.json({ error: 'Login failed' });
  }
});

app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { phone } = req.body;
    await twilioClient.verify.v2.services('VAfda39f88eaabea55df09f201fa193108').verifications.create({ to: phone, channel: 'sms' });
    res.json({ success: true });
  } catch (error) {
    console.error('Send verification error:', error);
    res.json({ error: 'Failed to send verification code' });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    const verification = await twilioClient.verify.v2.services('VAfda39f88eaabea55df09f201fa193108').verificationChecks.create({ to: phone, code: code });
    if (verification.status === 'approved') {
      const db = await connectDB();
      await db.collection('users').updateOne({ phone }, { $set: { verified: true } });
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
    const voiceGrant = new VoiceGrant({ outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID, incomingAllow: true });
    const token = new AccessToken(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { identity: userId });
    token.addGrant(voiceGrant);
    res.json({ success: true, token: token.toJwt(), identity: userId });
  } catch (error) {
    console.error('Generate token error:', error);
    res.json({ error: 'Failed to generate token' });
  }
});

app.post('/api/call/initiate', async (req, res) => {
  try {
    const { userPhone, targetPhone, sourceLanguage } = req.body;
    const cleanTargetPhone = targetPhone.replace(/[\s\(\)\-]/g, '');
    const callId = Date.now().toString();

    activeCalls.set(callId, {
      userPhone: userPhone,
      targetPhone: cleanTargetPhone,
      userLanguage: sourceLanguage,
      targetLanguage: sourceLanguage === 'es' ? 'en' : 'es',
      userAudioBuffer: [],
      targetAudioBuffer: [],
      userCallSid: null,
      targetCallSid: null
    });

    console.log('Initiating streaming call:', callId);

    const call = await twilioClient.calls.create({
      url: BASE_URL + '/voice-stream-user?callId=' + callId,
      to: userPhone,
      from: process.env.TWILIO_PHONE_NUMBER
    });

    res.json({ success: true, callSid: call.sid, callId: callId });
  } catch (error) {
    console.error('Call error:', error);
    res.json({ error: error.message });
  }
});

app.post('/voice-stream-user', async (req, res) => {
  try {
    const callId = req.query.callId;
    const callData = activeCalls.get(callId);

    if (!callData) {
      res.type('text/xml');
      res.send('<Response><Say>Call expired</Say><Hangup /></Response>');
      return;
    }

    callData.userCallSid = req.body.CallSid;
    console.log('User connected to streaming call:', callId);

    const wsUrl = BASE_URL.replace('https://', 'wss://') + '/media-stream?callId=' + callId + '&role=user';

    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Start><Stream url="' + wsUrl + '" /></Start><Pause length="3600"/></Response>');

    setTimeout(async () => {
      console.log('Attempting to call target:', callData.targetPhone);
      try {
        const targetCall = await twilioClient.calls.create({
          url: BASE_URL + '/voice-stream-target?callId=' + callId,
          to: callData.targetPhone,
          from: process.env.TWILIO_PHONE_NUMBER
        });
        console.log('Target call initiated:', targetCall.sid);
      } catch (err) {
        console.error('Target call FAILED:', err.message);
        console.error('Full error:', JSON.stringify(err, null, 2));
      }
    }, 3000);

  } catch (error) {
    console.error('Voice stream user error:', error);
    res.type('text/xml');
    res.send('<Response><Hangup /></Response>');
  }
});

app.post('/voice-stream-target', async (req, res) => {
  try {
    const callId = req.query.callId;
    const callData = activeCalls.get(callId);

    if (!callData) {
      res.type('text/xml');
      res.send('<Response><Hangup /></Response>');
      return;
    }

    callData.targetCallSid = req.body.CallSid;
    console.log('Target connected to streaming call:', callId);

    const wsUrl = BASE_URL.replace('https://', 'wss://') + '/media-stream?callId=' + callId + '&role=target';

    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Start><Stream url="' + wsUrl + '" /></Start><Pause length="3600"/></Response>');

  } catch (error) {
    console.error('Voice stream target error:', error);
    res.type('text/xml');
    res.send('<Response><Hangup /></Response>');
  }
});

async function processAudioChunk(audioData, callId, role) {
  const callData = activeCalls.get(callId);
  if (!callData) return;

  try {
    const tmpFile = '/tmp/audio_' + Date.now() + '.wav';
    fs.writeFileSync(tmpFile, audioData);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1'
    });

    fs.unlinkSync(tmpFile);

    if (!transcription.text || transcription.text.trim().length === 0) {
      console.log('No speech detected in chunk');
      return;
    }

    console.log(role + ' said:', transcription.text);

    const sourceLanguage = role === 'user' ? callData.userLanguage : callData.targetLanguage;
    const targetLanguage = role === 'user' ? callData.targetLanguage : callData.userLanguage;

    const translation = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Translate to ' + languageMap[targetLanguage].name + '. Output ONLY translation.' },
        { role: 'user', content: transcription.text }
      ],
      temperature: 0.3
    });

    const translatedText = translation.choices[0].message.content.trim();
    console.log('Translated to ' + targetLanguage + ':', translatedText);

    const targetCallSid = role === 'user' ? callData.targetCallSid : callData.userCallSid;

    if (targetCallSid) {
      await twilioClient.calls(targetCallSid).update({
        twiml: '<Response><Say>' + translatedText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</Say><Pause length="1"/></Response>'
      });
      console.log('Translation played to', role === 'user' ? 'target' : 'user');
    }

  } catch (error) {
    console.error('Process audio chunk error:', error.message);
  }
}

app.get('/api/chats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await connectDB();
    const conversations = await db.collection('conversations').find({ participants: userId }).sort({ lastMessageAt: -1 }).toArray();
    res.json({ success: true, conversations });
  } catch (error) {
    res.json({ error: 'Failed' });
  }
});

app.get('/api/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const db = await connectDB();
    const messages = await db.collection('messages').find({ conversationId }).sort({ createdAt: 1 }).limit(100).toArray();
    res.json({ success: true, messages });
  } catch (error) {
    res.json({ error: 'Failed' });
  }
});

app.post('/api/messages/send', async (req, res) => {
  try {
    const { senderId, recipientId, text, senderLanguage } = req.body;
    const db = await connectDB();
    let conversation = await db.collection('conversations').findOne({ participants: { $all: [senderId, recipientId] } });
    if (!conversation) {
      const result = await db.collection('conversations').insertOne({ participants: [senderId, recipientId], createdAt: new Date(), lastMessageAt: new Date() });
      conversation = { _id: result.insertedId };
    }
    const recipient = await db.collection('users').findOne({ _id: new ObjectId(recipientId) });
    const recipientLanguage = recipient?.preferredLanguage || 'en';
    let translatedText = text;
    if (senderLanguage !== recipientLanguage) {
      const translation = await openai.chat.completions.create({ model: 'gpt-4', messages: [{ role: 'system', content: 'Translate to ' + languageMap[recipientLanguage].name }, { role: 'user', content: text }], temperature: 0.3 });
      translatedText = translation.choices[0].message.content.trim();
    }
    const message = { conversationId: conversation._id.toString(), senderId, recipientId, originalText: text, originalLanguage: senderLanguage, translatedText, translatedLanguage: recipientLanguage, createdAt: new Date(), read: false };
    const messageResult = await db.collection('messages').insertOne(message);
    await db.collection('conversations').updateOne({ _id: conversation._id }, { $set: { lastMessageAt: new Date(), lastMessage: translatedText } });
    res.json({ success: true, message: { ...message, _id: messageResult.insertedId } });
  } catch (error) {
    res.json({ error: 'Failed' });
  }
});

app.post('/api/messages/read', async (req, res) => {
  try {
    const { conversationId, userId } = req.body;
    const db = await connectDB();
    await db.collection('messages').updateMany({ conversationId, recipientId: userId, read: false }, { $set: { read: true } });
    res.json({ success: true });
  } catch (error) {
    res.json({ error: 'Failed' });
  }
});

app.post('/api/messages/send-simple', async (req, res) => {
  try {
    const { senderPhone, recipientPhone, text, senderLanguage } = req.body;
    const targetLanguage = 'en';
    let translatedText = text;
    if (senderLanguage !== targetLanguage) {
      const translation = await openai.chat.completions.create({ model: 'gpt-4', messages: [{ role: 'system', content: 'Translate to ' + languageMap[targetLanguage].name }, { role: 'user', content: text }], temperature: 0.3 });
      translatedText = translation.choices[0].message.content.trim();
    }
    const message = { _id: Date.now().toString(), senderPhone, recipientPhone, originalText: text, originalLanguage: senderLanguage, translatedText, translatedLanguage: targetLanguage, createdAt: new Date().toISOString() };
    res.json({ success: true, message });
  } catch (error) {
    res.json({ error: 'Failed' });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({
  server: server,
  path: '/media-stream',
  verifyClient: (info) => {
    console.log('WebSocket verification:', info.req.url);
    return true;
  }
});

wss.on('connection', (ws, req) => {
  console.log('WebSocket connection established');

  const url = new URL(req.url, 'http://localhost');
  const callId = url.searchParams.get('callId');
  const role = url.searchParams.get('role');

  if (!callId || !role) {
    ws.close();
    return;
  }

  const callData = activeCalls.get(callId);
  if (!callData) {
    ws.close();
    return;
  }

  console.log('Media stream connected:', callId, role);

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        console.log('Stream started for', role);
      }

      if (msg.event === 'media') {
        const audioBuffer = role === 'user' ? callData.userAudioBuffer : callData.targetAudioBuffer;
        audioBuffer.push(msg.media.payload);

        if (audioBuffer.length >= 150) {
          const audioData = Buffer.from(audioBuffer.join(''), 'base64');
          audioBuffer.length = 0;

          console.log('Processing audio chunk from', role, '- size:', audioData.length);

          processAudioChunk(audioData, callId, role).catch(err => {
            console.error('Audio processing error:', err);
          });
        }
      }

      if (msg.event === 'stop') {
        console.log('Stream stopped for', role);
      }

    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket closed for', role);
  });
});

server.listen(PORT, () => {
  console.log('Talk2 Server with Media Streams on port ' + PORT);
  console.log('WebSocket ready for real-time translation');
});
