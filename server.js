require('dotenv').config();
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, 
'');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_VOICE = 'shimmer';

const LANGS = {
  es: 'Spanish', en: 'English', zh: 'Mandarin', fr: 'French',
  de: 'German', it: 'Italian', pt: 'Portuguese', ja: 'Japanese',
  ko: 'Korean', nl: 'Dutch', ru: 'Russian'
};

const callLanguages = new Map();

app.post('/voice', (req, res) => {
  const src = req.query.source || 'es';
  const tgt = req.query.target || 'en';
  const callSid = req.body.CallSid;
  
  console.log('DEBUG - CallSid:', callSid);
  console.log('DEBUG - Source:', src, 'Target:', tgt);
  
  if (callSid) {
    callLanguages.set(callSid, { source: src, target: tgt });
  }
  
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice', language: 'es-ES' }, 'CallDove');
  const connect = twiml.connect();
  connect.stream({
    url: PUBLIC_BASE_URL.replace(/^http/, 'ws') + '/media'
  });
  res.type('text/xml').send(twiml.toString());
});

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

wss.on('connection', (twilioWs, req) => {
  let src = 'es', tgt = 'en';
  let callSid = null;
  
  let streamSid, openaiWs, ready = false, lastMark = 0, inProgress = 
false;
  
  const safeSend = (ws, obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  };
  
  const connectOpenAI = (srcName, tgtName) => {
    const url = 'wss://api.openai.com/v1/realtime?model=' + 
encodeURIComponent(OPENAI_REALTIME_MODEL);
    openaiWs = new WebSocket(url, {
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
    
    openaiWs.on('open', () => {
      console.log('OpenAI OK');
      const instructions = 'Translate between ' + srcName + ' and ' + 
tgtName + '. Hear ' + srcName + ' speak ' + tgtName + '. Hear ' + tgtName 
+ ' speak ' + srcName + '. Direct only. Fast.';
      safeSend(openaiWs, {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: instructions,
          voice: OPENAI_VOICE,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600
          },
          temperature: 0.7,
          max_response_output_tokens: 150
        }
      });
      ready = true;
    });
    
    openaiWs.on('message', (buffer) => {
      let event;
      try {
        event = JSON.parse(buffer.toString());
      } catch (e) {
        return;
      }
      
      if (event.type === 'response.audio.delta' && event.delta && 
streamSid) {
        safeSend(twilioWs, {
          event: 'media',
          streamSid: streamSid,
          media: { payload: event.delta }
        });
        const now = Date.now();
        if (now - lastMark > 1000) {
          lastMark = now;
          safeSend(twilioWs, {
            event: 'mark',
            streamSid: streamSid,
            mark: { name: 'm_' + now }
          });
        }
      }
      
      if (event.type === 'input_audio_buffer.speech_started') {
        if (inProgress && streamSid) {
          safeSend(twilioWs, { event: 'clear', streamSid: streamSid });
          safeSend(openaiWs, { type: 'response.cancel' });
          inProgress = false;
        }
      }
      
      if (event.type === 'input_audio_buffer.speech_stopped') {
        if (!inProgress) {
          inProgress = true;
          safeSend(openaiWs, { type: 'response.create' });
        }
      }
      
      if (event.type === 'response.done') {
        inProgress = false;
      }
    });
    
    openaiWs.on('close', () => {
      ready = false;
      inProgress = false;
    });
    
    openaiWs.on('error', (err) => {
      console.error('OpenAI:', err.message);
    });
  };
  
  twilioWs.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }
    
    if (data.event === 'start') {
      streamSid = (data.start && data.start.streamSid) || data.streamSid;
      callSid = (data.start && data.start.callSid) || null;
      
      console.log('Stream OK - CallSid:', callSid);
      
      if (callSid && callLanguages.has(callSid)) {
        const langs = callLanguages.get(callSid);
        src = langs.source;
        tgt = langs.target;
        callLanguages.delete(callSid);
      }
      
      const srcName = LANGS[src] || 'Spanish';
      const tgtName = LANGS[tgt] || 'English';
      
      console.log('Conexion:', srcName, '<->', tgtName);
      connectOpenAI(srcName, tgtName);
    }
    
    if (data.event === 'media' && data.media && data.media.payload) {
      if (openaiWs && ready && openaiWs.readyState === WebSocket.OPEN) {
        safeSend(openaiWs, {
          type: 'input_audio_buffer.append',
          audio: data.media.payload
        });
      }
    }
    
    if (data.event === 'stop') {
      if (callSid) {
        callLanguages.delete(callSid);
      }
      twilioWs.close();
    }
  });
  
  twilioWs.on('close', () => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
});

server.listen(PORT, () => {
  console.log('CALLDOVE Multi-Language');
  console.log('URL:', PUBLIC_BASE_URL);
  console.log('Idiomas:', Object.keys(LANGS).join(', '));
});
