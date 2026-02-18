require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
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
  'es': 'Spanish', 'en': 'English', 'zh': 'Chinese', 'fr': 'French', 'de': 'German',
  'it': 'Italian', 'pt': 'Portuguese', 'ja': 'Japanese', 'ko': 'Korean', 'ar': 'Arabic', 'hi': 'Hindi'
};

const callLanguages = new Map();

app.get('/', (req, res) => {
  res.send('Calldove Translation Server Running');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    websocket_clients: wss.clients.size,
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

  console.log(`Voice webhook called - CallSid: ${callSid}, source: ${source}, target: ${target}`);

  callLanguages.set(callSid, { source, target });

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting to translation service</Say>
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
  console.log('WebSocket connection established');
  let callSid = null;
  let openAiWs = null;
  let streamSid = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        const langs = callLanguages.get(callSid) || { source: 'es', target: 'en' };

        console.log(`Stream started - CallSid: ${callSid}, source: ${langs.source}, target: ${langs.target}`);

        openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          }
        });

        openAiWs.on('open', () => {
          console.log('OpenAI WebSocket opened');
          
          const sessionConfig = {
            type: 'session.update',
            session: {
              type: 'realtime',
              model: 'gpt-realtime',
              instructions: `You are a real-time translator. Translate spoken ${languageMap[langs.source]} to 
${languageMap[langs.target]}. Output ONLY the translation, speak naturally in ${languageMap[langs.target]}.`,
              turn_detection: {
                type: 'server_vad'
              },
              audio: {
                input: {
                  format: 'g711_ulaw'
                },
                output: {
                  format: 'g711_ulaw',
                  voice: 'alloy'
                }
              }
            }
          };

          console.log('Sending session config:', JSON.stringify(sessionConfig));
          openAiWs.send(JSON.stringify(sessionConfig));
        });

        openAiWs.on('message', (data) => {
          try {
            const response = JSON.parse(data);
            console.log('OpenAI event:', response.type);

            if (response.type === 'error') {
              console.error('OpenAI ERROR:', JSON.stringify(response, null, 2));
            }

            if (response.type === 'response.output_audio.delta' && response.delta) {
              ws.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: response.delta }
              }));
            }
          } catch (error) {
            console.error('Error processing OpenAI message:', error.message);
          }
        });

        openAiWs.on('error', (error) => {
          console.error('OpenAI WebSocket error:', error);
        });
        
        openAiWs.on('close', (code, reason) => {
          console.log(`OpenAI WebSocket closed - Code: ${code}, Reason: ${reason}`);
        });
      }

      if (msg.event === 'media' && openAiWs && openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }

      if (msg.event === 'stop') {
        console.log('Stream stopped');
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.close();
        }
        if (callSid) {
          callLanguages.delete(callSid);
        }
      }
    } catch (error) {
      console.error('Error handling message:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  console.log('WebSocket upgrade requested from:', request.url);
  wss.handleUpgrade(request, socket, head, (ws) => {
    console.log('WebSocket upgrade successful');
    wss.emit('connection', ws, request);
  });
});
