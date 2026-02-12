require('dotenv').config();
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
if (!PUBLIC_BASE_URL) { console.error('ERROR: Falta PUBLIC_BASE_URL'); process.exit(1); }
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error('ERROR: Falta OPENAI_API_KEY'); process.exit(1); }
const OPENAI_REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_VOICE = 'shimmer';
const LANGS = { es:'Spanish', en:'English', zh:'Mandarin', fr:'French', de:'German', it:'Italian', pt:'Portuguese', ja:'Japanese', ko:'Korean', nl:'Dutch', ru:'Russian' };

app.post('/voice', (req, res) => {
  console.log('=== DEBUG ===');
  console.log('Query params:', req.query);
  console.log('source:', req.query.source);
  console.log('target:', req.query.target);
  console.log('=============');
  
  const src = req.query.source || 'es';
  const tgt = req.query.target || 'en';
  
  console.log('Usando source:', src, 'target:', tgt);
  
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice:'alice', language:'es-ES' }, 'CallDove conectado');
  const c = twiml.connect();
  c.stream({ url: PUBLIC_BASE_URL.replace(/^http/,'ws')+'/media?source='+src+'&target='+tgt });
  res.type('text/xml').send(twiml.toString());
});

app.get('/health', (req,res) => res.json({ok:true}));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path:'/media' });
wss.on('connection', (tws, req) => {
  console.log('=== WEBSOCKET DEBUG ===');
  console.log('URL completa:', req.url);
  const p = new URLSearchParams(req.url.split('?')[1]);
  console.log('Params extraidos:', Object.fromEntries(p));
  const src = p.get('source')||'es', tgt = p.get('target')||'en';
  const sn = LANGS[src]||'Spanish', tn = LANGS[tgt]||'English';
  console.log('Conexion:', sn, '<->', tn);
  console.log('======================');
  
  let sid=null, ows=null, ready=false, mark=0, prog=false;
  const send = (ws,o) => { if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(o)); };
  const conn = () => {
    ows = new WebSocket('wss://api.openai.com/v1/realtime?model='+encodeURIComponent(OPENAI_REALTIME_MODEL), {
      headers: { Authorization:'Bearer '+OPENAI_API_KEY, 'OpenAI-Beta':'realtime=v1' }
    });
    ows.on('open', () => {
      console.log('OpenAI OK');
      const inst = 'You translate between '+sn+' and '+tn+'. Hear '+sn+' speak '+tn+'. Hear '+tn+' speak '+sn+'. Direct translation only. No he says. Fast.';
      send(ows, { type:'session.update', session:{ modalities:['text','audio'], instructions:inst, voice:OPENAI_VOICE, input_audio_format:'g711_ulaw', output_audio_format:'g711_ulaw', input_audio_transcription:{model:'whisper-1'}, turn_detection:{type:'server_vad', threshold:0.5, prefix_padding_ms:300, silence_duration_ms:600}, temperature:0.7, max_response_output_tokens:150 }});
      ready=true;
    });
    ows.on('message', b => {
      let e; try { e=JSON.parse(b.toString()); } catch { return; }
      if(e.type==='response.audio.delta' && e.delta && sid) {
        send(tws, {event:'media', streamSid:sid, media:{payload:e.delta}});
        const n=Date.now(); if(n-mark>1000) { mark=n; send(tws, {event:'mark', streamSid:sid, mark:{name:'m_'+n}}); }
      }
      if(e.type==='input_audio_buffer.speech_started') { if(prog && sid) { send(tws,{event:'clear',streamSid:sid}); send(ows,{type:'response.cancel'}); prog=false; } }
      if(e.type==='input_audio_buffer.speech_stopped') { if(!prog) { prog=true; send(ows,{type:'response.create'}); } }
      if(e.type==='response.done') { prog=false; }
    });
    ows.on('close', () => { ready=false; prog=false; });
    ows.on('error', e => console.error('OpenAI err:', e.message));
  };
  conn();
  tws.on('message', m => {
    let d; try { d=JSON.parse(m.toString()); } catch { return; }
    if(d.event==='start') { sid=(d.start&&d.start.streamSid)||d.streamSid; console.log('Stream OK'); }
    if(d.event==='media' && d.media && d.media.payload && ows && ready && ows.readyState===WebSocket.OPEN) {
      send(ows, {type:'input_audio_buffer.append', audio:d.media.payload});
    }
    if(d.event==='stop') { console.log('Fin'); tws.close(); }
  });
  tws.on('close', () => { if(ows && ows.readyState===WebSocket.OPEN) ows.close(); });
});
server.listen(PORT, () => {
  console.log('CALLDOVE Multi-Language DEBUG');
  console.log('URL:', PUBLIC_BASE_URL);
  console.log('Idiomas:', Object.keys(LANGS).join(', '));
});
