import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type AppState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'confirm'
  | 'sending'
  | 'response'
  | 'error'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state: AppState = 'idle'
let audioChunks: Uint8Array[] = []
let transcript = ''
let agentResponse = ''
let errorMsg = ''

// ---------------------------------------------------------------------------
// Config — served by the Vite dev-server middleware (see vite.config.ts)
// ---------------------------------------------------------------------------
async function getConfig(): Promise<{ apiKey: string; agentId: string }> {
  try {
    const res = await fetch('/api/config')
    return await res.json()
  } catch {
    return { apiKey: '', agentId: '' }
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------
function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

function pcmToWav(pcm: Uint8Array): Blob {
  const sr = 16000, ch = 1, bps = 16
  const byteRate = sr * ch * (bps / 8)
  const blockAlign = ch * (bps / 8)
  const buf = new ArrayBuffer(44 + pcm.length)
  const v = new DataView(buf)

  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }

  w(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, ch, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, bps, true)
  w(36, 'data')
  v.setUint32(40, pcm.length, true)

  new Uint8Array(buf).set(pcm, 44)
  return new Blob([buf], { type: 'audio/wav' })
}

/** Convert Uint8Array → base64, chunked to avoid call-stack overflow. */
function uint8ToBase64(data: Uint8Array): string {
  let bin = ''
  const step = 8192
  for (let i = 0; i < data.length; i += step) {
    const slice = data.subarray(i, Math.min(i + step, data.length))
    bin += String.fromCharCode.apply(null, Array.from(slice))
  }
  return btoa(bin)
}

// ---------------------------------------------------------------------------
// ElevenLabs — Speech-to-Text
// ---------------------------------------------------------------------------
async function transcribeAudio(wav: Blob, apiKey: string): Promise<string> {
  const form = new FormData()
  form.append('file', wav, 'recording.wav')
  form.append('model_id', 'scribe_v1')

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  })

  if (!res.ok) throw new Error(`STT error ${res.status}`)
  const data = await res.json()
  return data.text || ''
}

// ---------------------------------------------------------------------------
// ElevenLabs — Conversational AI Agent
// ---------------------------------------------------------------------------
async function sendToAgent(
  pcm: Uint8Array,
  apiKey: string,
  agentId: string,
): Promise<string> {
  // 1. Get a signed WebSocket URL
  const urlRes = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
    { headers: { 'xi-api-key': apiKey } },
  )
  if (!urlRes.ok) throw new Error(`Agent auth failed: ${urlRes.status}`)
  const { signed_url } = await urlRes.json()

  // 2. Open the conversation
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(signed_url)
    let response = ''
    let settled = false
    let debounce: ReturnType<typeof setTimeout> | null = null

    const hardTimeout = setTimeout(() => finish(
      response || new Error('Agent timeout (30 s)'),
    ), 30_000)

    function finish(result: string | Error) {
      if (settled) return
      settled = true
      clearTimeout(hardTimeout)
      if (debounce) clearTimeout(debounce)
      try { ws.close() } catch { /* ok */ }
      result instanceof Error ? reject(result) : resolve(result)
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)

        // Connection ready — stream the recorded audio
        if (msg.type === 'conversation_initiation_metadata') {
          const chunk = 8000 // ~250 ms of 16 kHz / 16-bit mono
          for (let i = 0; i < pcm.length; i += chunk) {
            ws.send(JSON.stringify({
              user_audio_chunk: uint8ToBase64(pcm.subarray(i, i + chunk)),
            }))
          }
          // 1.5 s of silence so the agent's VAD detects end-of-speech
          ws.send(JSON.stringify({
            user_audio_chunk: uint8ToBase64(new Uint8Array(48_000)),
          }))
        }

        // Accumulate the agent's streamed text response
        if (msg.type === 'agent_response') {
          response += msg.agent_response_event?.agent_response || ''
          // Resolve 3 s after the last token (agent is done talking)
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => finish(response), 3000)
        }

        // The server may send a corrected transcript
        if (msg.type === 'agent_response_correction') {
          response =
            msg.agent_response_correction_event?.corrected_text || response
        }

        // Keep-alive
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({
            type: 'pong',
            event_id: msg.ping_event?.event_id,
          }))
        }
      } catch { /* ignore malformed frames */ }
    }

    ws.onerror = () => finish(new Error('WebSocket error'))
    ws.onclose = () => finish(response || new Error('Connection closed'))
  })
}

// ---------------------------------------------------------------------------
// Bridge & display helpers
// ---------------------------------------------------------------------------
const bridge = await waitForEvenAppBridge()
const userInfo = await bridge.getUserInfo()
const userName = userInfo?.name || 'there'

async function show(content: string) {
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 1,
    containerName: 'main',
    content,
    contentOffset: 0,
    contentLength: 0,
  }))
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
async function transition(next: AppState) {
  state = next

  switch (state) {
    case 'idle':
      audioChunks = []
      transcript = ''
      agentResponse = ''
      await show(`Hello, ${userName}!\n\nTap to record\nDouble-tap to exit`)
      break

    case 'recording':
      audioChunks = []
      await bridge.audioControl(true)
      await show('● Recording...\n\nTap to stop')
      break

    case 'transcribing': {
      await bridge.audioControl(false)
      await show('Transcribing...')
      try {
        const cfg = await getConfig()
        if (!cfg.apiKey) throw new Error('No API key — set it in the browser')
        const pcm = mergeChunks(audioChunks)
        if (pcm.length < 16_000) throw new Error('Too short — hold longer')
        transcript = await transcribeAudio(pcmToWav(pcm), cfg.apiKey)
        if (!transcript.trim()) throw new Error('No speech detected')
        await transition('confirm')
      } catch (e: unknown) {
        errorMsg = e instanceof Error ? e.message : 'Transcription failed'
        await transition('error')
      }
      break
    }

    case 'confirm':
      await show(`"${transcript}"\n\nTap: send to agent\nSwipe ↓: cancel`)
      break

    case 'sending': {
      await show('Sending to agent...')
      try {
        const cfg = await getConfig()
        if (!cfg.agentId) throw new Error('No Agent ID — set it in the browser')
        const pcm = mergeChunks(audioChunks)
        agentResponse = await sendToAgent(pcm, cfg.apiKey, cfg.agentId)
        if (!agentResponse.trim()) throw new Error('Empty agent response')
        await transition('response')
      } catch (e: unknown) {
        errorMsg = e instanceof Error ? e.message : 'Agent error'
        await transition('error')
      }
      break
    }

    case 'response': {
      const text = agentResponse.length > 450
        ? agentResponse.slice(0, 447) + '...'
        : agentResponse
      await show(`${text}\n\nTap for new message`)
      break
    }

    case 'error':
      await show(`Error: ${errorMsg}\n\nTap to retry`)
      break
  }
}

// ---------------------------------------------------------------------------
// Create the initial glasses page
// ---------------------------------------------------------------------------
const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 8,
  containerID: 1,
  containerName: 'main',
  content: `Hello, ${userName}!\n\nTap to record\nDouble-tap to exit`,
  isEventCapture: 1,
})

const startResult = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }),
)
console.log('Page created:', startResult === 0 ? 'success' : `failed (${startResult})`)

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------
const unsubscribe = bridge.onEvenHubEvent(async (event) => {
  // ---- Audio data (high-frequency during recording) ----
  if (event.audioEvent?.audioPcm) {
    if (state === 'recording') {
      audioChunks.push(new Uint8Array(event.audioEvent.audioPcm))
    }
    return
  }

  // ---- Scroll gestures on the text container ----
  if (event.textEvent) {
    const t = event.textEvent.eventType ?? 0
    if (t === 2 && state === 'confirm') {
      await transition('idle') // swipe down → cancel
    }
    return
  }

  // ---- System / tap events ----
  if (event.sysEvent) {
    const t = event.sysEvent.eventType ?? 0

    // Double-tap → exit
    if (t === 3) {
      await bridge.audioControl(false)
      bridge.shutDownPageContainer(1)
      return
    }

    // Lifecycle cleanup
    if (t === 6 || t === 7) {
      await bridge.audioControl(false)
      unsubscribe()
      return
    }

    // Single tap → state-dependent action
    if (t === 0) {
      switch (state) {
        case 'idle':      await transition('recording');    break
        case 'recording': await transition('transcribing'); break
        case 'confirm':   await transition('sending');      break
        case 'response':  // fall through
        case 'error':     await transition('idle');          break
      }
    }
  }
})

// Safety net — stop hardware on page unload
window.addEventListener('beforeunload', () => {
  bridge.audioControl(false)
  unsubscribe()
})
