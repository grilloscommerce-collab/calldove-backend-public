require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { MongoClient, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const https = require('https');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const BASE_URL = 'https://web-production-38c0e.up.railway.app';

let db = null;

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
  res.send('Talk2 Translation Server Running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, phone, preferredLanguage } = req.body;
    const db = await connectDB();
    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.json({ error: 'User already exists' });
    }
    const result = await db.collection('users').insertOne({
      email, password, phone, verified: false,
      preferredLanguage: preferredLanguage || 'en',
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
        email: user.email, phone: user.phone,
        userId: user._id.toString(),
        preferredLanguage: user.preferredLanguage || 'en'
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
    await 
twilioClient.verify.v2.services('VAfda39f88eaabea55df09f201fa193108').verifications.create({ to: 
phone, channel: 'sms' });
    res.json({ success: true });
  } catch (error) {
    console.error('Send verification error:', error);
    res.json({ error: 'Failed to send verification code' });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    const verification = await 
twilioClient.verify.v2.services('VAfda39f88eaabea55df09f201fa193108').verificationChecks.create({ 
to: phone, code: code });
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
    const voiceGrant = new VoiceGrant({ outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID, 
incomingAllow: true });
    const token = new AccessToken(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY, 
process.env.TWILIO_API_SECRET, { identity: userId });
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
    console.log(`📞 Call: ${userPhone} -> ${targetPhone} (${sourceLanguage})`);
    const call = await twilioClient.calls.create({
      url: `${BASE_URL}/voice-user?source=${sourceLanguage}&target=${targetPhone}`,
      to: userPhone,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    console.log(`✅ Call initiated: ${call.sid}`);
    res.json({ success: true, callSid: call.sid, message: 'Calling you now!' });
  } catch (error) {
    console.error('Call error:', error);
    res.json({ error: error.message || 'Failed to initiate call' });
  }
});

app.post('/voice-user', async (req, res) => {
  try {
    const source = req.query.source || 'es';
    const targetPhone = req.query.target;
    console.log(`👤 User answered, calling ${targetPhone}`);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting with 
translation.</Say><Dial 
action="${BASE_URL}/translation-loop?source=${source}&user=true"><Number>${targetPhone}</Number></Dial></Response>`;
    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('Voice user error:', error);
    res.type('text/xml');
    res.send('<Response><Say>Error</Say><Hangup /></Response>');
  }
});

app.post('/translation-loop', async (req, res) => {
  try {
    const { RecordingUrl, DialCallStatus } = req.body;
    const source = req.query.source;
    const isUser = req.query.user === 'true';
    console.log(`🎙️ Translation loop: ${DialCallStatus}`);
    
    if (DialCallStatus === 'completed' || DialCallStatus === 'no-answer') {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Call 
ended.</Say></Response>`;
      res.type('text/xml');
      res.send(twiml);
      return;
    }
    
    const target = isUser ? 'en' : source;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>After the beep, speak 
your message.</Say><Record maxLength="10" playBeep="true" 
action="${BASE_URL}/process-translation?source=${source}&target=${target}" /></Response>`;
    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('Translation loop error:', error);
    res.type('text/xml');
    res.send('<Response><Hangup /></Response>');
  }
});

app.post('/process-translation', async (req, res) => {
  try {
    const { RecordingSid } = req.body;
    const { source, target } = req.query;
    
    if (!RecordingSid) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>No audio 
detected.</Say><Hangup /></Response>`;
      res.type('text/xml');
      res.send(twiml);
      return;
    }

    const tmpFile = `/tmp/rec_${Date.now()}.wav`;
    const downloadUrl = 
`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${RecordingSid}.wav`;
    const file = fs.createWriteStream(tmpFile);
    
    await new Promise((resolve, reject) => {
      const auth = 
Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      https.get(downloadUrl, { headers: { 'Authorization': `Basic ${auth}` } }, (response) => {
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });

    console.log('Transcribing...');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1'
    });
    fs.unlinkSync(tmpFile);

    if (!transcription.text || transcription.text.trim().length === 0) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>No speech 
detected.</Say><Hangup /></Response>`;
      res.type('text/xml');
      res.send(twiml);
      return;
    }

    const detectedLang = transcription.language || source;
    console.log(`Transcribed (${detectedLang}): "${transcription.text}"`);

    const translation = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: `Translate from ${languageMap[detectedLang]?.name || 'detected language'} to ${languageMap[target].name}. Output ONLY the translation.` },
        { role: 'user', content: transcription.text }
      ],
      temperature: 0.3
    });

    const translatedText = translation.choices[0].message.content.trim();
    console.log(`Translated (${target}): "${translatedText}"`);

    const twiml = `<?xml version="1.0" 
encoding="UTF-8"?><Response><Say>${translatedText.replace(/&/g, '&amp;').replace(/</g, 
'&lt;').replace(/>/g, '&gt;')}</Say><Say>Speak again after the beep.</Say><Record maxLength="10" 
playBeep="true" action="${BASE_URL}/process-translation?source=${target}&target=${source}" 
/></Response>`;
    
    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('Process translation error:', error);
    res.type('text/xml');
    res.send('<Response><Say>Error</Say><Hangup /></Response>');
  }
});

app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`📱 Call ${CallSid}: ${CallStatus}`);
  res.sendStatus(200);
});

app.get('/api/chats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await connectDB();
    const conversations = await db.collection('conversations').find({ participants: userId 
}).sort({ lastMessageAt: -1 }).toArray();
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Get chats error:', error);
    res.json({ error: 'Failed to get chats' });
  }
});

app.get('/api/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const db = await connectDB();
    const messages = await db.collection('messages').find({ conversationId }).sort({ createdAt: 1 
}).limit(100).toArray();
    res.json({ success: true, messages });
  } catch (error) {
    console.error('Get messages error:', error);
    res.json({ error: 'Failed to get messages' });
  }
});

app.post('/api/messages/send', async (req, res) => {
  try {
    const { senderId, recipientId, text, senderLanguage } = req.body;
    const db = await connectDB();
    console.log(`Message: ${senderId} -> ${recipientId}`);
    let conversation = await db.collection('conversations').findOne({ participants: { $all: 
[senderId, recipientId] } });
    if (!conversation) {
      const result = await db.collection('conversations').insertOne({ participants: [senderId, 
recipientId], createdAt: new Date(), lastMessageAt: new Date() });
      conversation = { _id: result.insertedId };
    }
    const recipient = await db.collection('users').findOne({ _id: new ObjectId(recipientId) });
    const recipientLanguage = recipient?.preferredLanguage || 'en';
    let translatedText = text;
    if (senderLanguage !== recipientLanguage) {
      const translation = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: `Translate from ${languageMap[senderLanguage].name} to 
${languageMap[recipientLanguage].name}. Output ONLY the translation.` },
          { role: 'user', content: text }
        ],
        temperature: 0.3
      });
      translatedText = translation.choices[0].message.content.trim();
    }
    const message = {
      conversationId: conversation._id.toString(), senderId, recipientId,
      originalText: text, originalLanguage: senderLanguage,
      translatedText, translatedLanguage: recipientLanguage,
      createdAt: new Date(), read: false
    };
    const messageResult = await db.collection('messages').insertOne(message);
    await db.collection('conversations').updateOne({ _id: conversation._id }, { $set: { 
lastMessageAt: new Date(), lastMessage: translatedText } });
    res.json({ success: true, message: { ...message, _id: messageResult.insertedId } });
  } catch (error) {
    console.error('Send message error:', error);
    res.json({ error: 'Failed to send message' });
  }
});

app.post('/api/messages/read', async (req, res) => {
  try {
    const { conversationId, userId } = req.body;
    const db = await connectDB();
    await db.collection('messages').updateMany({ conversationId, recipientId: userId, read: false 
}, { $set: { read: true } });
    res.json({ success: true });
  } catch (error) {
    console.error('Mark read error:', error);
    res.json({ error: 'Failed to mark as read' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Talk2 Server running on port ${PORT}`);
  console.log(`Chat endpoints: ✅`);
  console.log(`Voice endpoints: ✅`);
  console.log(`Real-time translation: ✅`);
  console.log(`Auto language detection: ✅`);
});
