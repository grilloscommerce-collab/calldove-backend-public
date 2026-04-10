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

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, 
process.env.TWILIO_AUTH_TOKEN);
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

const activeConferences = new Map();

// ==========================================
// HEALTH & INFO
// ==========================================

app.get('/', (req, res) => {
  res.send('Talk2 Translation Server Running');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString() 
  });
});

// ==========================================
// AUTH ENDPOINTS
// ==========================================

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
      preferredLanguage: 'en',
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

// ==========================================
// VOICE CALL ENDPOINTS - BIDIRECTIONAL
// ==========================================

app.post('/api/call/initiate', async (req, res) => {
  try {
    const { userPhone, targetPhone, sourceLanguage, targetLanguage } = 
req.body;
    const conferenceName = `conf_${Date.now()}`;

    console.log(`📞 Initiating conference: ${userPhone} <-> ${targetPhone}`);
    console.log(`   Languages: ${sourceLanguage} <-> ${targetLanguage}`);

    activeConferences.set(conferenceName, {
      userPhone,
      targetPhone,
      userLanguage: sourceLanguage,
      targetLanguage: targetLanguage,
      createdAt: new Date()
    });

    const userCall = await twilioClient.calls.create({
      url: 
`${BASE_URL}/connect-user?conference=${conferenceName}&lang=${sourceLanguage}`,
      to: userPhone,
      from: process.env.TWILIO_PHONE_NUMBER,
      statusCallback: `${BASE_URL}/call-status`,
      statusCallbackEvent: ['answered', 'completed']
    });

    console.log(`✅ User call initiated: ${userCall.sid}`);

    res.json({ 
      success: true, 
      callSid: userCall.sid,
      conferenceName,
      message: 'Call initiated. Answer your phone!'
    });

  } catch (error) {
    console.error('Call initiation error:', error);
    res.json({ 
      error: error.message || 'Failed to initiate call' 
    });
  }
});

app.post('/connect-user', async (req, res) => {
  try {
    const conferenceName = req.query.conference;
    const userLang = req.query.lang;
    
    console.log(`👤 User answered, joining conference: ${conferenceName}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting your call with translation.</Say>
  <Dial>
    <Conference
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      
statusCallback="${BASE_URL}/conference-status?conference=${conferenceName}"
      statusCallbackEvent="start,end,join,leave"
    >${conferenceName}</Conference>
  </Dial>
</Response>`;

    res.type('text/xml');
    res.send(twiml);

    setTimeout(async () => {
      const confData = activeConferences.get(conferenceName);
      if (confData) {
        console.log(`📞 Calling target: ${confData.targetPhone}`);
        
        await twilioClient.calls.create({
          url: 
`${BASE_URL}/connect-target?conference=${conferenceName}&lang=${confData.targetLanguage}`,
          to: confData.targetPhone,
          from: process.env.TWILIO_PHONE_NUMBER
        });
      }
    }, 2000);

  } catch (error) {
    console.error('Connect user error:', error);
    res.type('text/xml');
    res.send('<Response><Say>Connection error</Say><Hangup /></Response>');
  }
});

app.post('/connect-target', async (req, res) => {
  try {
    const conferenceName = req.query.conference;
    const targetLang = req.query.lang;
    
    console.log(`👥 Target answered, joining conference: ${conferenceName}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference
      startConferenceOnEnter="false"
      endConferenceOnExit="true"
    >${conferenceName}</Conference>
  </Dial>
</Response>`;

    res.type('text/xml');
    res.send(twiml);

  } catch (error) {
    console.error('Connect target error:', error);
    res.type('text/xml');
    res.send('<Response><Hangup /></Response>');
  }
});

app.post('/conference-status', (req, res) => {
  const { StatusCallbackEvent, FriendlyName } = req.body;
  const conferenceName = req.query.conference;
  
  console.log(`🎙️  Conference ${conferenceName}: ${StatusCallbackEvent}`);
  
  if (StatusCallbackEvent === 'conference-end') {
    activeConferences.delete(conferenceName);
    console.log(`✅ Conference ${conferenceName} ended and cleaned up`);
  }
  
  res.sendStatus(200);
});

app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`📱 Call ${CallSid}: ${CallStatus}`);
  res.sendStatus(200);
});

app.post('/voice', async (req, res) => {
  try {
    const source = req.query.source || 'es';
    const target = req.query.target || 'en';
    const callSid = req.body.CallSid;

    console.log(`Voice webhook - CallSid: ${callSid}, ${source} -> 
${target}`);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Translation ready. After the beep, speak in 
${languageMap[source].name}.</Say>
  <Record maxLength="10" playBeep="true" transcribe="false" 
action="${BASE_URL}/process-recording?source=${source}&target=${target}&callSid=${callSid}" 
/>
</Response>`;

    res.type('text/xml');
    res.send(twimlResponse);
  } catch (error) {
    console.error('Voice webhook error:', error);
    res.type('text/xml');
    res.send('<Response><Say>Application error</Say><Hangup /></Response>');
  }
});

app.post('/process-recording', async (req, res) => {
  try {
    const { RecordingSid } = req.body;
    const { source, target, callSid } = req.query;
    
    console.log(`Processing recording: ${RecordingSid}`);

    if (!RecordingSid) {
      console.error('No recording SID provided');
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>No recording received. Please try again.</Say>
  <Record maxLength="10" playBeep="true" transcribe="false" 
action="${BASE_URL}/process-recording?source=${source}&target=${target}&callSid=${callSid}" 
/>
</Response>`;
      res.type('text/xml');
      res.send(twiml);
      return;
    }

    const tmpFile = `/tmp/recording_${Date.now()}.wav`;
    const downloadUrl = 
`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${RecordingSid}.wav`;
    
    const file = fs.createWriteStream(tmpFile);
    
    await new Promise((resolve, reject) => {
      const auth = 
Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      
      https.get(downloadUrl, {
        headers: {
          'Authorization': `Basic ${auth}`
        }
      }, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        console.error('Download error:', err);
        reject(err);
      });
    });

    console.log('Audio downloaded, transcribing...');

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1',
      language: source
    });

    fs.unlinkSync(tmpFile);

    if (!transcription.text || transcription.text.trim().length === 0) {
      console.log('No speech detected');
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>No speech detected. Please speak clearly after the beep.</Say>
  <Record maxLength="10" playBeep="true" transcribe="false" 
action="${BASE_URL}/process-recording?source=${source}&target=${target}&callSid=${callSid}" 
/>
</Response>`;
      res.type('text/xml');
      res.send(twiml);
      return;
    }

    console.log(`Transcribed (${source}): "${transcription.text}"`);

    const translation = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{
        role: 'system',
        content: `Translate from ${languageMap[source].name} to 
${languageMap[target].name}. Output ONLY the translation, nothing else.`
      }, {
        role: 'user',
        content: transcription.text
      }],
      temperature: 0.3
    });

    const translatedText = translation.choices[0].message.content.trim();
    console.log(`Translated (${target}): "${translatedText}"`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${translatedText.replace(/&/g, '&amp;').replace(/</g, 
'&lt;').replace(/>/g, '&gt;')}</Say>
  <Say>Speak again after the beep.</Say>
  <Record maxLength="10" playBeep="true" transcribe="false" 
action="${BASE_URL}/process-recording?source=${source}&target=${target}&callSid=${callSid}" 
/>
</Response>`;

    console.log('✅ Translation sent successfully!');
    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('Process recording error:', error);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Translation error occurred. Hanging up.</Say>
  <Hangup />
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  }
});

// ==========================================
// CHAT ENDPOINTS
// ==========================================

app.get('/api/chats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await connectDB();
    
    const conversations = await db.collection('conversations')
      .find({ 
        participants: userId 
      })
      .sort({ lastMessageAt: -1 })
      .toArray();
    
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
    
    const messages = await db.collection('messages')
      .find({ conversationId })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();
    
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
    
    console.log(`New message from ${senderId} to ${recipientId}`);
    
    let conversation = await db.collection('conversations').findOne({
      participants: { $all: [senderId, recipientId] }
    });
    
    if (!conversation) {
      console.log('Creating new conversation');
      const result = await db.collection('conversations').insertOne({
        participants: [senderId, recipientId],
        createdAt: new Date(),
        lastMessageAt: new Date()
      });
      conversation = { _id: result.insertedId };
    }
    
    const recipient = await db.collection('users').findOne({ 
      _id: new ObjectId(recipientId) 
    });
    const recipientLanguage = recipient?.preferredLanguage || 'en';
    
    console.log(`Translating message from ${senderLanguage} to 
${recipientLanguage}`);
    
    let translatedText = text;
    if (senderLanguage !== recipientLanguage) {
      const translation = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{
          role: 'system',
          content: `Translate from ${languageMap[senderLanguage].name} to 
${languageMap[recipientLanguage].name}. Output ONLY the translation, maintain 
the tone and style.`
        }, {
          role: 'user',
          content: text
        }],
        temperature: 0.3
      });
      translatedText = translation.choices[0].message.content.trim();
      console.log(`Original: "${text}" -> Translated: "${translatedText}"`);
    }
    
    const message = {
      conversationId: conversation._id.toString(),
      senderId,
      recipientId,
      originalText: text,
      originalLanguage: senderLanguage,
      translatedText,
      translatedLanguage: recipientLanguage,
      createdAt: new Date(),
      read: false
    };
    
    const messageResult = await db.collection('messages').insertOne(message);
    
    await db.collection('conversations').updateOne(
      { _id: conversation._id },
      { 
        $set: { 
          lastMessageAt: new Date(),
          lastMessage: translatedText 
        } 
      }
    );
    
    console.log('✅ Message sent and translated successfully!');
    
    res.json({ 
      success: true, 
      message: { ...message, _id: messageResult.insertedId }
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.json({ error: 'Failed to send message' });
  }
});

app.post('/api/messages/read', async (req, res) => {
  try {
    const { conversationId, userId } = req.body;
    const db = await connectDB();
    
    await db.collection('messages').updateMany(
      { conversationId, recipientId: userId, read: false },
      { $set: { read: true } }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Mark read error:', error);
    res.json({ error: 'Failed to mark as read' });
  }
});

// ==========================================
// SERVER START
// ==========================================

const server = app.listen(PORT, () => {
  console.log(`Talk2 Server running on port ${PORT}`);
  console.log(`Chat endpoints: ✅`);
  console.log(`Voice endpoints: ✅`);
  console.log(`Conference calls: ✅`);
});
